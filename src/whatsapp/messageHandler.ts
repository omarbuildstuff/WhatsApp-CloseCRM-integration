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

    // For group messages, resolve the participant's phone (the sender)
    // For DMs, resolve the remote JID as before
    const phoneJid = isGroup ? (msg.key.participant ?? null) : jid;

    if (isGroup && !phoneJid) {
      logger.debug({ repId, jid }, 'Filtered: group message without participant');
      return;
    }

    // Skip outgoing group messages — rep's message goes to the group, not a specific lead
    if (isGroup && msg.key.fromMe) {
      logger.debug({ repId, jid }, 'Filtered: outgoing group message');
      return;
    }

    let e164 = phoneJid ? await resolveJidToE164(phoneJid) : null;
    // Fallback: if @lid JID wasn't in lid_phone_map, try live resolution via Baileys socket
    if (!e164 && phoneJid) {
      const decoded = jidDecode(phoneJid);
      if (decoded?.server === 'lid') {
        e164 = await sessionManager.resolveLidJid(repId, phoneJid);
        if (e164) {
          logger.info({ repId, jid: phoneJid, e164 }, 'Resolved @lid JID via live Baileys query');
        }
      }
    }
    const isFromMe = !!msg.key.fromMe;
    const dbDirection = isFromMe ? 'outgoing' : 'incoming';
    const closeDirection: 'incoming' | 'outgoing' = isFromMe ? 'outgoing' : 'incoming';
    const tsSec = msg.messageTimestamp
      ? (typeof msg.messageTimestamp === 'number'
          ? msg.messageTimestamp
          : msg.messageTimestamp.toNumber())   // Long has .toNumber()
      : 0;
    const timestamp = new Date(tsSec * 1000); // PITFALL: seconds, not ms!

    logger.info({ repId, waMessageId, jid, e164, isGroup, body: body?.substring(0, 50) }, 'Message passed filters — persisting');

    // For group messages, prefix the body with [Group: <name>] for context in Close
    const groupPrefix = isGroup ? `[Group Chat] ` : '';
    const closeBody = groupPrefix + (body ?? '');

    try {
      // Step 3: LEAD LOOKUP — find ALL leads matching this phone
      const leads = e164 ? await phoneCache.lookupAll(e164) : [];

      // Step 4+5: PERSIST + SYNC — only for lead-matched messages
      if (leads.length === 0 || !e164) {
        logger.debug({ repId, waMessageId, e164 }, 'No lead match — skipping DB persist and Close sync');
        return;
      }

      // Persist with first lead for DB record
      const result = await pool.query(
        `INSERT INTO messages (id, rep_id, direction, wa_jid, phone_e164, lead_id, body, media_type, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [waMessageId, repId, dbDirection, jid, e164, leads[0].leadId, body, mediaType, timestamp]
      );
      const inserted = (result.rowCount ?? 0) > 0;

      if (inserted) {
        // Fetch rep's WA phone and Close user ID for activity attribution
        const repRow = await pool.query<{ wa_phone: string | null; close_user_id: string | null }>(
          'SELECT wa_phone, close_user_id FROM reps WHERE id = $1',
          [repId]
        );
        const localPhone = repRow.rows[0]?.wa_phone ?? '';
        const closeUserId = repRow.rows[0]?.close_user_id ?? undefined;

        // Post activity to EVERY matching lead
        for (const lead of leads) {
          const contactId = await closeClient.findContactId(lead.leadId, e164);
          if (!contactId) {
            logger.warn({ repId, leadId: lead.leadId, e164 }, 'No contact_id found on lead — skipping Close sync for this lead');
            continue;
          }
          const payload: import('../close/types').WhatsAppActivityPayload = {
            lead_id: lead.leadId,
            contact_id: contactId,
            direction: closeDirection,
            external_whatsapp_message_id: waMessageId,
            local_phone: localPhone,
            remote_phone: e164,
            message_markdown: closeBody,
            activity_at: timestamp.toISOString(),
            ...(closeUserId ? { user_id: closeUserId } : {}),
          };
          logger.info({ repId, waMessageId, leadId: lead.leadId, leadCount: leads.length, direction: closeDirection }, 'Posting WhatsApp activity to Close');
          try {
            const activityId = await closeClient.postWhatsAppActivity(payload);
            if (activityId) {
              logger.info({ repId, waMessageId, activityId, leadId: lead.leadId }, 'Close activity created');
              // Store first activity ID in DB
              if (lead === leads[0]) {
                try {
                  await pool.query(
                    'UPDATE messages SET close_activity_id = $1 WHERE id = $2',
                    [activityId, waMessageId]
                  );
                } catch (updateErr) {
                  logger.error(
                    { repId, waMessageId, activityId, err: updateErr },
                    'Close activity posted but DB close_activity_id update failed'
                  );
                }
              }
            }
          } catch (closeErr: any) {
            logger.error(
              { repId, waMessageId, leadId: lead.leadId, err: closeErr, responseData: closeErr?.response?.data },
              'Failed to post WhatsApp activity to Close'
            );
          }
        }
      }
    } catch (err) {
      logger.error({ repId, waMessageId, err }, 'Failed to process inbound message');
    }
  }
}

export const messageHandler = new MessageHandler();
