import { jidDecode } from '@whiskeysockets/baileys';
import parsePhoneNumber from 'libphonenumber-js/min';

/**
 * Convert a WhatsApp JID to E.164 phone number.
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
