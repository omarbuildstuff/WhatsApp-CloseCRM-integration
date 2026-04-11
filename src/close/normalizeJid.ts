import { jidDecode } from '@whiskeysockets/baileys';
import parsePhoneNumber from 'libphonenumber-js/min';
import { pool } from '../db/pool';

/**
 * Convert a WhatsApp JID to E.164 phone number (synchronous, pure).
 * Returns null for non-phone JIDs (@lid, @g.us) or unparseable numbers.
 */
export function normalizeJidToE164(jid: string): string | null {
  const decoded = jidDecode(jid);
  if (!decoded || decoded.server !== 's.whatsapp.net') return null;

  // Baileys user field is digits-only international number without '+'
  const raw = '+' + decoded.user;
  const parsed = parsePhoneNumber(raw);
  if (!parsed) return null;

  // .number returns E.164 string e.g. '+15551234567'
  return parsed.number as string;
}

/**
 * Resolve a WhatsApp JID to E.164 with async fallback for @lid JIDs.
 * For @s.whatsapp.net JIDs, delegates to normalizeJidToE164.
 * For @lid JIDs, looks up the lid_phone_map table.
 */
export async function resolveJidToE164(jid: string): Promise<string | null> {
  const e164 = normalizeJidToE164(jid);
  if (e164) return e164;

  // Check if this is an @lid JID
  const decoded = jidDecode(jid);
  if (!decoded || decoded.server !== 'lid') return null;

  const result = await pool.query<{ phone_e164: string }>(
    'SELECT phone_e164 FROM lid_phone_map WHERE lid = $1',
    [jid]
  );
  return result.rows[0]?.phone_e164 ?? null;
}

/**
 * Store a lid→phone_e164 mapping so future @lid JIDs can be resolved.
 * Called from contacts.upsert events when Baileys provides both JID types.
 */
export async function storeLidMapping(lid: string, phoneE164: string): Promise<void> {
  await pool.query(
    `INSERT INTO lid_phone_map (lid, phone_e164, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (lid) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164, updated_at = NOW()`,
    [lid, phoneE164]
  );
}
