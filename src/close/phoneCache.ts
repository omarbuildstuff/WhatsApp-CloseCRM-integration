import { pool } from '../db/pool';
import { closeClient } from './client';
import type { LeadInfo } from './types';

const ONE_HOUR_MS = 60 * 60 * 1000;

interface CacheEntry {
  lead: LeadInfo | null;
  expiresAt: number;
}

interface LeadPhoneCacheEntry {
  phone: string | null;
  expiresAt: number;
}

export class PhoneCache {
  private readonly mem = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<LeadInfo | null>>();
  private readonly leadMem = new Map<string, LeadPhoneCacheEntry>();

  /**
   * Look up a phone number (E.164 format) and return the matching Close lead.
   * Returns null if no lead matches this phone number.
   *
   * Lookup order:
   * 1. In-memory Map (fastest, survives within process lifetime)
   * 2. Coalesce concurrent in-flight lookups for the same number
   * 3. PostgreSQL close_phone_cache table (survives restarts)
   * 4. Close API via closeClient.findLeadByPhone() (cache miss)
   */
  async lookup(e164: string): Promise<LeadInfo | null> {
    // 1. In-memory check
    const memHit = this.mem.get(e164);
    if (memHit && memHit.expiresAt > Date.now()) {
      return memHit.lead;
    }

    // 2. Coalesce concurrent lookups for the same number to avoid duplicate API calls
    const existing = this.inFlight.get(e164);
    if (existing) return existing;

    const promise = this._fetchAndCache(e164).finally(() => {
      this.inFlight.delete(e164);
    });
    this.inFlight.set(e164, promise);
    return promise;
  }

  /**
   * Internal: check DB cache, then fall back to Close API, then persist result.
   * Called at most once per phone number at a time — concurrent callers share
   * the same promise via the `inFlight` map.
   */
  private async _fetchAndCache(e164: string): Promise<LeadInfo | null> {
    // 3. DB cache check (1-hour TTL enforced in SQL)
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

    // 4. Close API call — handle failure gracefully
    let lead: LeadInfo | null;
    try {
      lead = await closeClient.findLeadByPhone(e164);
    } catch (err) {
      console.error(`[PhoneCache] Close API lookup failed for ${e164}:`, err);
      // Do not cache — let the next call retry after a natural delay
      return null;
    }

    // 5. Persist to DB (upsert) and in-memory
    try {
      await pool.query(
        `INSERT INTO close_phone_cache (phone_e164, lead_id, lead_name, cached_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (phone_e164) DO UPDATE
           SET lead_id = EXCLUDED.lead_id,
               lead_name = EXCLUDED.lead_name,
               cached_at = NOW()`,
        [e164, lead?.leadId ?? null, lead?.leadName ?? null]
      );
    } catch (err) {
      console.error(`[PhoneCache] DB upsert failed for ${e164}:`, err);
      // In-memory cache still set below — survivable
    }

    this.mem.set(e164, { lead, expiresAt: Date.now() + ONE_HOUR_MS });
    return lead;
  }

  /**
   * Resolve the primary phone number for a Close lead ID.
   * Uses a 1-hour in-memory cache to comply with CLAUDE.md architecture rule:
   * "Phone number lookups against Close API MUST use the 1-hour cache."
   *
   * Falls back to closeClient.getLeadContacts() on cache miss and caches
   * the result (including null) to prevent repeated API calls for the same lead.
   */
  async getLeadPhone(leadId: string): Promise<string | null> {
    const memHit = this.leadMem.get(leadId);
    if (memHit && memHit.expiresAt > Date.now()) return memHit.phone;

    // DB cache: check close_phone_cache for any row matching this lead_id
    const dbResult = await pool.query<{ phone_e164: string | null }>(
      `SELECT phone_e164 FROM close_phone_cache WHERE lead_id = $1 AND cached_at > NOW() - INTERVAL '1 hour' LIMIT 1`,
      [leadId]
    );
    if (dbResult.rows.length > 0) {
      const phone = dbResult.rows[0].phone_e164 ?? null;
      this.leadMem.set(leadId, { phone, expiresAt: Date.now() + ONE_HOUR_MS });
      return phone;
    }

    // Fallback to live API — then cache result
    const phone = await closeClient.getLeadContacts(leadId);
    this.leadMem.set(leadId, { phone, expiresAt: Date.now() + ONE_HOUR_MS });
    return phone;
  }
}

export const phoneCache = new PhoneCache();
