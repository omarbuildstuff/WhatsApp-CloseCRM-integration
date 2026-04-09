import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import pino from 'pino';
import { jidEncode } from '@whiskeysockets/baileys';
import { pool } from '../db/pool';
import { sessionManager } from '../whatsapp/sessionManager';
import { closeClient } from './client';
import { phoneCache } from './phoneCache';
import { config } from '../config';
import type { CloseWebhookActivityData } from './types';

const logger = pino({ level: 'info' });

/**
 * Verify HMAC-SHA256 signature from Close webhook.
 * Key is hex-decoded CLOSE_WEBHOOK_SECRET.
 * Signed data = sigTimestamp + rawBody (utf8).
 * Returns false on any error (mismatched buffer lengths, bad hex, etc.).
 */
function verifySignature(
  rawBody: Buffer,
  sigTimestamp: string,
  sigHash: string,
  secret: string
): boolean {
  try {
    const key = Buffer.from(secret, 'hex');
    const data = sigTimestamp + rawBody.toString('utf8');
    const computed = createHmac('sha256', key).update(data).digest('hex');
    const computedBuf = Buffer.from(computed, 'hex');
    const expectedBuf = Buffer.from(sigHash, 'hex');
    if (computedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(computedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Express handler for POST /webhook/close.
 *
 * Route must be registered with express.raw({ type: 'application/json' })
 * middleware so req.body is a Buffer for HMAC verification.
 *
 * Pipeline:
 *   Step 1: HMAC-SHA256 signature verification (+ replay guard)
 *   Step 2: Parse JSON payload
 *   Step 3: Loop guard — drop if external_whatsapp_message_id is set (OUT-02, CLAUDE.md)
 *   Step 4: Direction filter — only process 'outbound' activities
 *   Step 5: Respond 200 early, then process async
 *   Steps 6-10: Rep routing, phone resolution, Baileys send, persist, patch Close
 */
export async function handleCloseWebhook(req: Request, res: Response): Promise<void> {
  // ── Step 1: HMAC-SHA256 Signature Verification ────────────────────────────
  const sigHash = req.headers['close-sig-hash'] as string | undefined;
  const sigTimestamp = req.headers['close-sig-timestamp'] as string | undefined;

  if (!sigHash || !sigTimestamp) {
    res.status(403).json({ error: 'Invalid signature' });
    return;
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    // Safety: if middleware was not configured correctly, reject
    res.status(403).json({ error: 'Invalid signature' });
    return;
  }

  if (!verifySignature(rawBody, sigTimestamp, sigHash, config.closeWebhookSecret)) {
    res.status(403).json({ error: 'Invalid signature' });
    return;
  }

  // Replay protection: reject if timestamp is more than 5 minutes old
  // close-sig-timestamp may be seconds or milliseconds
  const tsNum = parseInt(sigTimestamp, 10);
  const tsMs = tsNum > 1e12 ? tsNum : tsNum * 1000;
  if (Math.abs(Date.now() - tsMs) > 300_000) {
    res.status(403).json({ error: 'Invalid signature' });
    return;
  }

  // ── Step 2: Parse JSON payload ─────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  // Support both nesting shapes until live verification confirms one
  const data: CloseWebhookActivityData | undefined =
    (parsed as { event?: { data?: CloseWebhookActivityData } })?.event?.data ??
    (parsed as { data?: CloseWebhookActivityData })?.data;

  if (!data?.id) {
    // Unrecognized event shape — drop silently
    res.status(200).json({ ok: true });
    return;
  }

  // ── Step 3: Loop Guard — CRITICAL, NON-NEGOTIABLE (OUT-02, CLAUDE.md) ─────
  // external_whatsapp_message_id is non-null when OUR integration created the activity.
  // Dropping here prevents infinite send loops.
  if (data.external_whatsapp_message_id) {
    logger.debug(
      { activityId: data.id, externalWaId: data.external_whatsapp_message_id },
      'Loop guard: dropping webhook for our own activity'
    );
    res.status(200).json({ ok: true });
    return;
  }

  // ── Step 4: Direction filter ───────────────────────────────────────────────
  if (data.direction !== 'outbound') {
    logger.debug({ activityId: data.id, direction: data.direction }, 'Dropping non-outbound activity');
    res.status(200).json({ ok: true });
    return;
  }

  // ── Step 5: Respond 200 early — prevents Close timeout retries ────────────
  // All remaining logic is async and errors are logged, never returned to Close.
  res.status(200).json({ ok: true });

  // ── Steps 6-10: Async processing after response ───────────────────────────
  void (async () => {
    try {
      // Step 6: Rep routing
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM reps WHERE close_user_id = $1 AND status = 'connected'",
        [data.user_id]
      );
      if (!rows.length) {
        logger.warn({ closeUserId: data.user_id }, 'No connected rep for Close user');
        return;
      }
      const repId = rows[0].id;

      const sock = sessionManager.getSession(repId);
      if (!sock) {
        logger.warn({ repId }, 'No active Baileys session');
        return;
      }

      // Step 7: Resolve customer phone number from lead_id (cached — CLAUDE.md architecture rule)
      const phoneE164 = await phoneCache.getLeadPhone(data.lead_id);
      if (!phoneE164) {
        logger.warn({ leadId: data.lead_id }, 'Cannot resolve phone for lead');
        return;
      }
      // Normalize to digits-only (E.164 strict) — Close stores numbers in user-entered formats
      const digits = phoneE164.replace(/\D/g, '');
      if (!digits || digits.length < 7 || digits.length > 15) {
        logger.error({ leadId: data.lead_id, phoneE164 }, 'Invalid phone number format — cannot construct JID');
        return;
      }
      const jid = jidEncode(digits, 's.whatsapp.net');

      // Step 8: Send via Baileys
      if (!data.message_markdown || typeof data.message_markdown !== 'string') {
        logger.error({ closeActivityId: data.id }, 'Empty or missing message_markdown — dropping');
        return;
      }
      const result = await sock.sendMessage(jid, { text: data.message_markdown });
      const waMessageId = result?.key?.id ?? null;

      if (!waMessageId) {
        logger.error({ repId, closeActivityId: data.id }, 'sendMessage returned undefined');
        return;
      }

      // Step 9: Persist outbound message to PostgreSQL
      await pool.query(
        `INSERT INTO messages (id, rep_id, direction, wa_jid, phone_e164, lead_id, close_activity_id, body, timestamp)
         VALUES ($1, $2, 'outgoing', $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [waMessageId, repId, jid, phoneE164, data.lead_id, data.id, data.message_markdown]
      );

      // Step 10: Update Close activity with real WA message ID
      await closeClient.updateWhatsAppActivity(data.id, {
        external_whatsapp_message_id: waMessageId,
      });

      logger.info(
        { repId, waMessageId, closeActivityId: data.id },
        'Outbound message sent and Close activity updated'
      );
    } catch (err) {
      logger.error({ err, closeActivityId: data.id }, 'Outbound webhook processing failed');
    }
  })();
}
