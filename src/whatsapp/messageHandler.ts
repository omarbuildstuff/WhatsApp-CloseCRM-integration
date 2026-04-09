import type { proto } from '@whiskeysockets/baileys';
import { normalizeJidToE164 } from '../close/normalizeJid';
import { phoneCache } from '../close/phoneCache';
import { closeClient } from '../close/client';
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
    if (!msg.key.remoteJid) return;
    if (msg.key.remoteJid.endsWith('@g.us')) return; // skip groups
    if (msg.key.fromMe) return;                       // skip outbound
    if (!msg.message) return;                          // skip system stubs
    if (!msg.key.id) return;                           // skip messages with no dedup key

    // Step 2: EXTRACT
    const jid = msg.key.remoteJid;
    const waMessageId = msg.key.id;
    const body = extractBody(msg);
    const mediaType = detectMediaType(msg);
    const e164 = normalizeJidToE164(jid);
    const tsSec = msg.messageTimestamp
      ? (typeof msg.messageTimestamp === 'number'
          ? msg.messageTimestamp
          : msg.messageTimestamp.toNumber())   // Long has .toNumber()
      : 0;
    const timestamp = new Date(tsSec * 1000); // PITFALL: seconds, not ms!

    try {
      // Step 3: LEAD LOOKUP
      const lead = e164 ? await phoneCache.lookup(e164) : null;

      // Step 4: PERSIST TO DB — ALWAYS, regardless of lead match (SYNC-03)
      const result = await pool.query(
        `INSERT INTO messages (id, rep_id, direction, wa_jid, phone_e164, lead_id, body, media_type, timestamp)
         VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [waMessageId, repId, jid, e164 ?? null, lead?.leadId ?? null, body, mediaType, timestamp]
      );
      const inserted = (result.rowCount ?? 0) > 0;

      // Step 5: SYNC TO CLOSE — only if lead matched AND row was inserted (not a duplicate)
      if (lead && inserted) {
        const activityId = await closeClient.postWhatsAppActivity({
          lead_id: lead.leadId,
          direction: 'inbound',
          external_whatsapp_message_id: waMessageId,
          message_markdown: body ?? '', // fallback empty string for Close API
          date: timestamp.toISOString(), // forward actual message time to Close
        });
        if (activityId) {
          await pool.query(
            'UPDATE messages SET close_activity_id = $1 WHERE id = $2',
            [activityId, waMessageId]
          );
        }
      }
    } catch (err) {
      logger.error({ repId, waMessageId, err }, 'Failed to process inbound message');
    }
  }
}

export const messageHandler = new MessageHandler();
