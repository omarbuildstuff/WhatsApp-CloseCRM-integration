import { pool } from '../db/pool';
import { closeClient } from './client';
import type { LeadInfo } from './types';

const ONE_HOUR_MS = 60 * 60 * 1000;

interface CacheEntry {
  lead: LeadInfo | null;
  expiresAt: number;
}

export class PhoneCache {
  private readonly mem = new Map<string, CacheEntry>();

  /**
   * Look up a phone number (E.164 format) and return the matching Close lead.
   * Returns null if no lead matches this phone number.
   *
   * Lookup order:
   * 1. In-memory Map (fastest, survives within process lifetime)
   * 2. PostgreSQL close_phone_cache table (survives restarts)
   * 3. Close API via closeClient.findLeadByPhone() (cache miss)
   */
  async lookup(e164: string): Promise<LeadInfo | null> {
    // 1. In-memory check
    const memHit = this.mem.get(e164);
    if (memHit && memHit.expiresAt > Date.now()) {
      return memHit.lead;
    }

    // 2. DB cache check (1-hour TTL enforced in SQL)
    const dbResult = await pool.query<{
      lead_id: string | null;
      lead_name: string | null;
      cached_at: Date;
    }>(
      `SELECT lead_id, lead_name, cached_at
       FROM close_phone_cache
       WHERE phone_e164 = $1 AND cached_at > NOW() - INTERVAL '1 hour'`,
      [e164]
    );

    if (dbResult.rows.length > 0) {
      const row = dbResult.rows[0];
      const lead = row.lead_id
        ? { leadId: row.lead_id, leadName: row.lead_name ?? '' }
        : null;
      this.mem.set(e164, { lead, expiresAt: Date.now() + ONE_HOUR_MS });
      return lead;
    }

    // 3. Close API call (cache miss — both hits and nulls get cached)
    const lead = await closeClient.findLeadByPhone(e164);

    // 4. Persist to DB (upsert) and in-memory
    await pool.query(
      `INSERT INTO close_phone_cache (phone_e164, lead_id, lead_name, cached_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (phone_e164) DO UPDATE
         SET lead_id = EXCLUDED.lead_id,
             lead_name = EXCLUDED.lead_name,
             cached_at = NOW()`,
      [e164, lead?.leadId ?? null, lead?.leadName ?? null]
    );

    this.mem.set(e164, { lead, expiresAt: Date.now() + ONE_HOUR_MS });
    return lead;
  }
}

export const phoneCache = new PhoneCache();
