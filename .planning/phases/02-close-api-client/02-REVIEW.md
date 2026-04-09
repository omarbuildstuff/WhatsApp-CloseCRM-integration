---
phase: 02-close-api-client
reviewed: 2026-04-09T00:00:00Z
depth: standard
files_reviewed: 4
files_reviewed_list:
  - src/close/types.ts
  - src/close/client.ts
  - src/close/normalizeJid.ts
  - src/close/phoneCache.ts
findings:
  critical: 0
  warning: 3
  info: 2
  total: 5
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-04-09
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

The four Close API client files are well-structured overall. The retry logic, Basic auth setup, E.164 normalisation, and two-tier caching (in-memory + PostgreSQL) all align with CLAUDE.md architecture rules. The main concerns are unhandled promise rejections in `phoneCache.ts` that can crash the process when the Close API or database fails after all retries are exhausted, and a potential burst-traffic race condition in the cache lookup path. No security vulnerabilities were found.

---

## Warnings

### WR-01: Unhandled rejection from `closeClient.findLeadByPhone` in cache miss path

**File:** `src/close/phoneCache.ts:53`

**Issue:** The Close API call on a cache miss is not wrapped in try/catch. If all three retries fail (network outage, persistent 5xx), the thrown `AxiosError` propagates out of `lookup()` as an unhandled rejection. Callers that do not catch this will crash or silently drop messages. The DB upsert and in-memory set (lines 56-66) are also skipped, so a temporary API failure leaves no negative-cache entry and the next call will immediately retry the API again.

**Fix:** Wrap the API call and cache write in a try/catch and decide on a fallback (e.g., return `null` and do not cache, or re-throw with context):

```typescript
async lookup(e164: string): Promise<LeadInfo | null> {
  // ... in-memory and DB cache checks unchanged ...

  // 3. Close API call — handle failure gracefully
  let lead: LeadInfo | null;
  try {
    lead = await closeClient.findLeadByPhone(e164);
  } catch (err) {
    console.error(`[PhoneCache] Close API lookup failed for ${e164}:`, err);
    // Do not cache — let the next call retry after a natural delay
    return null;
  }

  // 4. Persist to DB and in-memory
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
```

---

### WR-02: Concurrent cache misses for the same phone trigger multiple parallel Close API calls

**File:** `src/close/phoneCache.ts:24-68`

**Issue:** If two WhatsApp messages arrive simultaneously for the same previously-uncached phone number, both calls to `lookup()` will pass the in-memory check (line 26-29), both will miss the DB cache (line 32-41), and both will invoke `closeClient.findLeadByPhone()` in parallel. This doubles (or more) the API request volume for burst arrivals and can exhaust the rate limit budget described in CLAUDE.md ("Phone number lookups against Close API MUST use the 1-hour cache to respect rate limits").

**Fix:** Deduplicate in-flight lookups using a `Map` of pending promises:

```typescript
private readonly inFlight = new Map<string, Promise<LeadInfo | null>>();

async lookup(e164: string): Promise<LeadInfo | null> {
  // 1. In-memory check (unchanged)
  const memHit = this.mem.get(e164);
  if (memHit && memHit.expiresAt > Date.now()) return memHit.lead;

  // Coalesce concurrent lookups for the same number
  const existing = this.inFlight.get(e164);
  if (existing) return existing;

  const promise = this._fetchAndCache(e164).finally(() => {
    this.inFlight.delete(e164);
  });
  this.inFlight.set(e164, promise);
  return promise;
}

private async _fetchAndCache(e164: string): Promise<LeadInfo | null> {
  // DB cache check + API call + upsert (existing body of lookup())
}
```

---

### WR-03: `findLeadByPhone` has no error handling — API errors propagate as untyped exceptions

**File:** `src/close/client.ts:38-49`

**Issue:** `this.http.get()` can throw an `AxiosError` (after retries) or an unexpected error if the response body does not match `CloseLeadListResponse`. There is no try/catch, and `res.data.data` is accessed without a null-guard. If Close returns a malformed response (e.g., missing `data` array), this throws a `TypeError` that propagates to `PhoneCache.lookup()` and then to the message handler. Axios-retry handles transient HTTP errors but does not handle malformed successful responses.

**Fix:** Add a guard on the response shape and wrap in try/catch or document the throw contract explicitly so callers can handle it:

```typescript
async findLeadByPhone(e164: string): Promise<LeadInfo | null> {
  const res = await this.http.get<CloseLeadListResponse>('/lead/', {
    params: {
      query: `phone:${e164}`,
      _fields: 'id,display_name',
      _limit: 1,
    },
  });

  const leads = res.data?.data;
  if (!Array.isArray(leads)) {
    throw new Error(`Unexpected Close API response shape for phone lookup: ${JSON.stringify(res.data)}`);
  }

  const lead = leads[0];
  if (!lead) return null;
  return { leadId: lead.id, leadName: lead.display_name };
}
```

---

## Info

### IN-01: `CloseContact` and `CloseContactPhone` types are declared but never used in the fetch path

**File:** `src/close/types.ts:8-17`

**Issue:** `CloseContact` and `CloseContactPhone` are defined in `types.ts` and referenced in `CloseLead`, but `client.ts` uses `_fields: 'id,display_name'` which excludes the `contacts` array from the API response. The `contacts` field on `CloseLead` will always be `undefined` at runtime. These types are unused dead code unless a future call requests the `contacts` field.

**Fix:** Either remove the unused interface fields, or add a comment explaining they are reserved for future use (e.g., a reverse-lookup path that fetches contacts). If contacts are needed later, also add `contacts` to the `_fields` param.

---

### IN-02: `libphonenumber-js/min` may silently reject valid numbers from smaller territories

**File:** `src/close/normalizeJid.ts:2`

**Issue:** The `min` build of `libphonenumber-js` omits metadata for less-common territories to reduce bundle size. `parsePhoneNumber` called with a `+`-prefixed international number and no default country will silently return `undefined` for some valid numbers where the `min` build lacks territory metadata. This means `normalizeJidToE164` returns `null` for those contacts, and they are never matched to Close leads, with no log entry to indicate why.

**Fix:** Either switch to the full `libphonenumber-js` build (larger bundle, ~145 KB) or add a log line when `parsePhoneNumber` returns null so dropped numbers are observable:

```typescript
const parsed = parsePhoneNumber(raw);
if (!parsed) {
  console.warn(`[normalizeJid] Could not parse phone number from JID: ${jid} (raw: ${raw})`);
  return null;
}
```

---

_Reviewed: 2026-04-09_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
