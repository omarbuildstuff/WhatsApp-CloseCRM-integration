import type { proto } from '@whiskeysockets/baileys';
import { jidDecode } from '@whiskeysockets/baileys';
import { resolveJidToE164 } from '../close/normalizeJid';
import { phoneCache } from '../close/phoneCache';
import { closeClient } from '../close/client';
import { sessionManager } from './sessionManager';
import { pool } from '../db/pool';
import pino from 'pino';

const logger = pino({ level: 'info' });

/**
 * Extract text body from a WhatsApp message.
 * Returns null for unrecognised message types.
 * Returns a placeholder string for audio and sticker messages.
 */
export function extractBody(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;

  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  if (m.documentWithCaptionMessage?.message?.documentMessage?.caption) {
    return m.documentWithCaptionMessage.message.documentMessage.caption;
  }
  if (m.locationMessage) {
    const lat = m.locationMessage.degreesLatitude ?? 0;
    const lng = m.locationMessage.degreesLongitude ?? 0;
    return `Location: ${lat}, ${lng}`;
  }
  if (m.contactMessage?.displayName) {
    return `Contact: ${m.contactMessage.displayName}`;
  }
  if (m.audioMessage) return '[Audio message]';
  if (m.stickerMessage) return '[Sticker]';

  return null;
}

/**
 * Detect the media type of a WhatsApp message.
 * Returns null for text-only messages.
 */
export function detectMediaType(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;

  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.documentMessage || m.documentWithCaptionMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  if (m.locationMessage) return 'location';
  if (m.contactMessage) return 'contact';

  return null;
}

export class MessageHandler {
  // Cache group participants (1 hour TTL)
  private groupCache = new Map<string, { participants: string[]; expiresAt: number }>();

  private async getGroupParticipantPhones(repId: string, groupJid: string): Promise<string[]> {
    const cached = this.groupCache.get(groupJid);
    if (cached && cached.expiresAt > Date.now()) return cached.participants;

    const sock = sessionManager.getSession(repId);
    if (!sock) return [];

    try {
      const metadata = await sock.groupMetadata(groupJid);
      const phones: string[] = [];
      for (const p of metadata.participants) {
        const e164 = await resolveJidToE164(p.id);
        if (e164) phones.push(e164);
      }
      this.groupCache.set(groupJid, { participants: phones, expiresAt: Date.now() + 60 * 60 * 1000 });
      logger.info({ repId, groupJid, participantCount: phones.length }, 'Cached group participants');
      return phones;
    } catch (err) {
      logger.warn({ repId, groupJid, err }, 'Failed to fetch group metadata');
      return [];
    }
  }

  /**
   * Handle an inbound WhatsApp message event from Baileys.
   * Implements the 5-step pipeline: filter -> extract -> lookup -> persist -> sync
   */
  async handle(repId: string, msg: proto.IWebMessageInfo): Promise<void> {
    // Step 1: FILTER CHAIN — return early, no side effects
    if (!msg.key.remoteJid) { logger.debug({ repId }, 'Filtered: no remoteJid'); return; }
    if (!msg.message) { logger.debug({ repId, msgId: msg.key.id }, 'Filtered: no message content'); return; }
    if (!msg.key.id) { logger.debug({ repId }, 'Filtered: no message id'); return; }

    // Step 2: EXTRACT
    const isGroup = msg.key.remoteJid.endsWith('@g.us');
    const jid = msg.key.remoteJid;
    const waMessageId = msg.key.id;
    const body = extractBody(msg);
    const mediaType = detectMediaType(msg);
    const isFromMe = !!msg.key.fromMe;
    const dbDirection = isFromMe ? 'outgoing' : 'incoming';
    const closeDirection: 'incoming' | 'outgoing' = isFromMe ? 'outgoing' : 'incoming';
    const tsSec = msg.messageTimestamp
      ? (typeof msg.messageTimestamp === 'number'
          ? msg.messageTimestamp
          : msg.messageTimestamp.toNumber())
      : 0;
    const timestamp = new Date(tsSec * 1000);

    // For group messages, prefix the body with [Group Chat] for context in Close
    const groupPrefix = isGroup ? `[Group Chat] ` : '';
    const closeBody = groupPrefix + (body ?? '');

    // ── Group message: sync to ALL lead-participants in the group
    // Any message in a group (incoming or outgoing) gets posted to every
    // lead that is a participant in that group.
    if (isGroup) {
      const participantPhones = await this.getGroupParticipantPhones(repId, jid);
      if (participantPhones.length === 0) {
        logger.debug({ repId, jid }, 'No resolvable participants in group');
        return;
      }
      // Add sender name prefix for incoming messages so you know who said what
      let groupBody = closeBody;
      if (!isFromMe && msg.pushName) {
        groupBody = `[Group Chat] ${msg.pushName}: ${body ?? ''}`;
      }
      logger.info({ repId, waMessageId, jid, isFromMe, participantCount: participantPhones.length, body: body?.substring(0, 50) }, 'Group message — syncing to all lead-participants');
      await this.syncToPhones(repId, waMessageId, jid, participantPhones, groupBody, mediaType, closeDirection, timestamp);
      return;
    }

    // ── DM message (existing logic)
    let e164 = await resolveJidToE164(jid);
    if (!e164) {
      const decoded = jidDecode(jid);
      if (decoded?.server === 'lid') {
        e164 = await sessionManager.resolveLidJid(repId, jid);
        if (e164) {
          logger.info({ repId, jid, e164 }, 'Resolved @lid JID via live Baileys query');
        }
      }
    }

    logger.info({ repId, waMessageId, jid, e164, body: body?.substring(0, 50) }, 'DM message — syncing');

    if (!e164) {
      logger.debug({ repId, waMessageId }, 'No phone resolved — skipping');
      return;
    }

    await this.syncToPhones(repId, waMessageId, jid, [e164], closeBody, mediaType, closeDirection, timestamp);
  }

  /**
   * Sync a message to Close for all leads matching any of the given phone numbers.
   */
  private async syncToPhones(
    repId: string,
    waMessageId: string,
    jid: string,
    phones: string[],
    messageBody: string,
    mediaType: string | null,
    direction: 'incoming' | 'outgoing',
    timestamp: Date,
  ): Promise<void> {
    try {
      // Collect all leads across all phone numbers
      const allLeads: Array<{ leadId: string; leadName: string; phone: string }> = [];
      for (const phone of phones) {
        const leads = await phoneCache.lookupAll(phone);
        for (const lead of leads) {
          allLeads.push({ ...lead, phone });
        }
      }

      if (allLeads.length === 0) {
        logger.debug({ repId, waMessageId, phones }, 'No lead matches — skipping');
        return;
      }

      // Persist with first lead for DB record
      const dbDirection = direction === 'outgoing' ? 'outgoing' : 'incoming';
      const firstLead = allLeads[0];
      const result = await pool.query(
        `INSERT INTO messages (id, rep_id, direction, wa_jid, phone_e164, lead_id, body, media_type, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [waMessageId, repId, dbDirection, jid, firstLead.phone, firstLead.leadId, messageBody, mediaType, timestamp]
      );
      const inserted = (result.rowCount ?? 0) > 0;
      if (!inserted) return;

      // Fetch rep info
      const repRow = await pool.query<{ wa_phone: string | null; close_user_id: string | null }>(
        'SELECT wa_phone, close_user_id FROM reps WHERE id = $1',
        [repId]
      );
      const localPhone = repRow.rows[0]?.wa_phone ?? '';
      const closeUserId = repRow.rows[0]?.close_user_id ?? undefined;

      // Post activity to every matching lead
      let firstActivityId: string | null = null;
      for (const lead of allLeads) {
        const contactId = await closeClient.findContactId(lead.leadId, lead.phone);
        if (!contactId) {
          logger.warn({ repId, leadId: lead.leadId, phone: lead.phone }, 'No contact_id — skipping this lead');
          continue;
        }
        const payload: import('../close/types').WhatsAppActivityPayload = {
          lead_id: lead.leadId,
          contact_id: contactId,
          direction,
          external_whatsapp_message_id: waMessageId,
          local_phone: localPhone,
          remote_phone: lead.phone,
          message_markdown: messageBody,
          activity_at: timestamp.toISOString(),
          ...(closeUserId ? { user_id: closeUserId } : {}),
        };
        logger.info({ repId, waMessageId, leadId: lead.leadId, leadCount: allLeads.length, direction }, 'Posting WhatsApp activity to Close');
        try {
          const activityId = await closeClient.postWhatsAppActivity(payload);
          if (activityId) {
            logger.info({ repId, waMessageId, activityId, leadId: lead.leadId }, 'Close activity created');
            if (!firstActivityId) {
              firstActivityId = activityId;
              await pool.query('UPDATE messages SET close_activity_id = $1 WHERE id = $2', [activityId, waMessageId]).catch(() => {});
            }
          }
        } catch (closeErr: any) {
          logger.error({ repId, waMessageId, leadId: lead.leadId, err: closeErr, responseData: closeErr?.response?.data }, 'Failed to post activity to Close');
        }
      }
    } catch (err) {
      logger.error({ repId, waMessageId, err }, 'Failed to sync message');
    }
  }
}

export const messageHandler = new MessageHandler();
