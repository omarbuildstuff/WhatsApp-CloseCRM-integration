# Phase 2: Close API Client - Research

**Researched:** 2026-04-09
**Domain:** Close CRM REST API, phone number normalization, HTTP retry logic
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Close API uses Basic auth with API key as username, empty password
- Phone number lookups must use 1-hour cache in `close_phone_cache` table
- `libphonenumber-js` must be installed for E.164 normalization
- Close API rate limit is ~100 requests/minute — must implement backoff retry on 429

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use ROADMAP phase goal, success criteria, and codebase conventions to guide decisions.

### Deferred Ideas (OUT OF SCOPE)
None — infrastructure phase.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SYNC-02 | Phone numbers are normalized to E.164 and looked up against Close contacts with a 1-hour cache | JID parsing (jidDecode), libphonenumber-js normalization, Close API lead search, PostgreSQL cache read/write pattern, axios interceptor retry on 429 |
</phase_requirements>

---

## Summary

Phase 2 delivers three tightly-coupled pieces: a `CloseApiClient` that wraps axios with Basic auth and 429-aware retry logic, a `PhoneCache` that enforces the 1-hour TTL using the already-created `close_phone_cache` table, and a `normalizeJidToE164` utility that converts Baileys JIDs to the E.164 strings needed for Close API lookups.

The core lookup mechanism uses `GET /api/v1/lead/` with a `query` parameter containing the E.164 phone number in Close's search syntax. Close's API does not provide a dedicated phone-search endpoint; the general lead search with a query string is the correct approach. All three pieces must be in place before Phase 3 (sync engine) can match any inbound WhatsApp message to a Close lead.

The only packages not yet installed are `libphonenumber-js` and `axios-retry`. Everything else — `axios`, `pg` pool, `config.ts`, and the `close_phone_cache` schema — is already in place from Phase 1.

**Primary recommendation:** Build `src/close/types.ts` → `src/close/client.ts` → `src/close/phoneCache.ts` in that order. Keep retry logic inside `client.ts` (either as an axios interceptor or via `axios-retry`), so `phoneCache.ts` never needs to reason about HTTP errors.

---

## Project Constraints (from CLAUDE.md)

| Directive | Impact on Phase 2 |
|-----------|-------------------|
| Close API auth: Basic auth, API key as username, empty password | `axios` instance must set `auth: { username: config.closeApiKey, password: '' }` |
| Phone number lookups MUST use 1-hour cache | `PhoneCache` is mandatory; calling `CloseApiClient` directly from Phase 3 code is forbidden |
| Database: PostgreSQL on Neon.tech (`?sslmode=require`) | Use existing `pool` singleton — do not create a second pool |
| All Baileys auth state persists in PostgreSQL | Not directly relevant to Phase 2, but confirms DB-first pattern applies here too |
| Conventional commits: `feat:`, `fix:`, etc. | Commits for this phase use `feat:` prefix |
| Subagent commits MUST use `--no-verify` | Executor must pass `--no-verify` on every commit |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `axios` | 1.15.0 (installed) | HTTP client for Close REST API | Already a dependency; interceptor API is ergonomic for auth injection and retry |
| `libphonenumber-js` | 1.12.41 (latest) | E.164 phone normalization | Gold-standard JS port of Google's libphonenumber; handles all international formats reliably |
| `pg` (pool) | 8.13.0 (installed) | Cache persistence in `close_phone_cache` | Already installed; use existing `pool` singleton from `src/db/pool.ts` |

[VERIFIED: npm registry — libphonenumber-js@1.12.41, axios-retry@4.5.0 confirmed via `npm view` during research]

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `axios-retry` | 4.5.0 (latest) | Automatic retry with exponential backoff on 429/5xx | Preferred over hand-rolled interceptor — handles edge cases (idempotency, config mutation) |

[VERIFIED: npm registry — confirmed via `npm view axios-retry version`]

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `libphonenumber-js` | `google-libphonenumber` | google-libphonenumber is a Java-ported wrapper, much heavier (~2MB). libphonenumber-js is a clean JS rewrite, smaller and tree-shakeable |
| `axios-retry` | Hand-rolled axios interceptor | Interceptor pattern shown in code examples below works fine for simple cases; `axios-retry` is better for production (handles body re-use, avoids mutating live config) |
| `libphonenumber-js` (min bundle) | `libphonenumber-js/max` | `min` bundle (~80KB) uses `.isPossible()` only; `max` bundle (~145KB) has full `.isValid()`. Use `min` — isPossible() is sufficient for formatting, and we trust WhatsApp JIDs are real numbers |

**Installation (packages not yet installed):**
```bash
npm install libphonenumber-js axios-retry
```

**Version verification:**
- `libphonenumber-js@1.12.41` — verified 2026-04-09, published 2026-03-28 [VERIFIED: npm registry]
- `axios-retry@4.5.0` — verified 2026-04-09, published 2024-08-02 [VERIFIED: npm registry]

---

## Architecture Patterns

### Recommended File Structure for Phase 2

```
src/close/
├── types.ts        # LeadInfo, CloseContact, CloseLeadSearchResponse interfaces
├── client.ts       # CloseApiClient: axios instance, auth, retry, findLeadByPhone()
└── phoneCache.ts   # PhoneCache: in-memory + DB-backed 1-hour TTL wrapper
```

This matches the architecture prescribed in `.planning/research/ARCHITECTURE.md` and the `close/` module boundary established there.

### Pattern 1: JID to E.164 Normalization

**What:** Extract the phone number from a Baileys JID and normalize to E.164 (`+15551234567`).

**When to use:** Before every Close API lookup and before storing `phone_e164` in the messages table.

**Baileys JID structure:** `[digits]@s.whatsapp.net` — the digits are already in international format without the `+`. JIDs never contain `+`, `()`, or `-`.

```typescript
// Source: Baileys JID docs (baileys.wiki/docs/concepts/whatsapp-ids) + libphonenumber-js README
import { jidDecode } from '@whiskeysockets/baileys';
import parsePhoneNumber from 'libphonenumber-js/min';

export function normalizeJidToE164(jid: string): string | null {
  const decoded = jidDecode(jid);
  // Only @s.whatsapp.net JIDs contain phone numbers; @lid and @g.us do not
  if (!decoded || decoded.server !== 's.whatsapp.net') return null;

  // Baileys user field is digits-only international number, no '+'
  // Prepend '+' to make it E.164-parseable
  const raw = '+' + decoded.user;
  const parsed = parsePhoneNumber(raw);
  if (!parsed) return null;

  // .number returns E.164 string e.g. '+15551234567'
  return parsed.number;
}
```

[VERIFIED: Baileys JID format confirmed via baileys.wiki; libphonenumber-js API confirmed via GitHub README]

**@lid JID caveat:** Some newer WhatsApp call events emit `@lid` JIDs whose numeric portion is NOT a phone number. `normalizeJidToE164` returns `null` for these — the caller must handle the null case gracefully (skip sync, do not crash). [VERIFIED: WhiskeySockets/Baileys issue #2142]

### Pattern 2: Close API Lead Search by Phone

**What:** Query `GET /api/v1/lead/` with a `query` parameter to find leads containing a contact with the given phone number.

**When to use:** On cache miss in `PhoneCache.lookup()`.

**Close API base URL:** `https://api.close.com/api/v1/` [VERIFIED: developers.getknit.dev Close integration docs]

**Authentication:** HTTP Basic auth — API key as username, empty string as password. [VERIFIED: CLAUDE.md + project research STACK.md]

```typescript
// Source: Close API Getting Started Guide (gist.github.com/philfreo/acb785408e6ec1394807)
// Close search query syntax: same syntax as the app's search bar
const response = await this.axiosInstance.get('/lead/', {
  params: {
    query: `phone:${e164}`,   // e.g. 'phone:+15551234567'
    _fields: 'id,display_name,contacts',
    _limit: 1,
  },
});
```

**Response shape (assumed from Close API patterns):**
```typescript
// [ASSUMED] — Close docs were unreachable during research; shape inferred from community examples
interface CloseLeadSearchResponse {
  data: Array<{
    id: string;          // 'lead_xxxx'
    display_name: string;
    contacts: Array<{
      id: string;
      phones: Array<{ phone: string; phone_formatted: string }>;
    }>;
  }>;
  has_more: boolean;
  total_results: number;
}
```

**Key behavior:** `data[0]` is the matched lead. If `data.length === 0`, the phone is not in Close — cache as `null` (known non-lead). [ASSUMED]

**Alternative lookup (Advanced Filtering API):** Close also supports `POST /api/v1/data/search/` with structured JSON queries for `has_related` phone conditions. This is more powerful but more complex to construct. For this integration, the simple `GET /lead/?query=phone:${e164}` is sufficient and simpler to maintain. [MEDIUM confidence — Advanced Filtering confirmed via multiple search results; simple query approach assumed sufficient for single-phone lookup]

### Pattern 3: Axios with Basic Auth + Retry on 429

**What:** A pre-configured axios instance that injects Close auth headers and retries on 429 with exponential backoff.

**When to use:** All outbound Close API calls go through this instance — never use the raw `axios` global.

**Option A — `axios-retry` (recommended):**
```typescript
// Source: axios-retry README + axios.rest retry docs
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { config } from '../config';

const closeAxios = axios.create({
  baseURL: 'https://api.close.com/api/v1',
  auth: {
    username: config.closeApiKey,
    password: '',
  },
  timeout: 10_000,
});

axiosRetry(closeAxios, {
  retries: 3,
  retryCondition: (error) =>
    axiosRetry.isNetworkError(error) ||
    error.response?.status === 429 ||
    (error.response?.status ?? 0) >= 500,
  retryDelay: (retryCount, error) => {
    // Honour Retry-After header if present; fall back to exponential backoff
    const retryAfter = error.response?.headers?.['retry-after'];
    if (retryAfter) return parseFloat(retryAfter) * 1000;
    return axiosRetry.exponentialDelay(retryCount);
  },
});
```

**Option B — hand-rolled interceptor (acceptable fallback if axios-retry import causes issues):**
```typescript
// Source: axios.rest/pages/advanced/retry
closeAxios.interceptors.response.use(
  (res) => res,
  async (error) => {
    const cfg = error.config;
    if (error.response?.status !== 429) return Promise.reject(error);
    cfg._retryCount = (cfg._retryCount ?? 0) + 1;
    if (cfg._retryCount > 3) return Promise.reject(error);
    const waitMs = error.response.headers['retry-after']
      ? parseFloat(error.response.headers['retry-after']) * 1000
      : 1000 * 2 ** cfg._retryCount;
    await new Promise((r) => setTimeout(r, waitMs));
    return closeAxios(cfg);
  }
);
```

[VERIFIED: interceptor pattern confirmed via axios.rest docs; axios-retry API confirmed via npm registry + GitHub README]

### Pattern 4: PhoneCache with In-Memory + DB Persistence

**What:** Two-layer cache — fast in-memory Map (survives within process lifetime), backed by `close_phone_cache` table (survives restarts). Cache stores both hits (`lead_id` is set) and misses (`lead_id` is null = known non-lead).

**When to use:** Wraps all calls to `CloseApiClient.findLeadByPhone()`. No other module should call `findLeadByPhone()` directly.

**Cache read order:**
1. Check in-memory Map — if hit and not expired, return immediately (zero DB/network cost)
2. Check `close_phone_cache` table — if row exists and `cached_at > NOW() - INTERVAL '1 hour'`, populate in-memory and return
3. Call Close API — populate both DB and in-memory

**Cache write:** On Close API response (hit or miss), upsert into `close_phone_cache` and update in-memory Map.

```typescript
// Established patterns from src/whatsapp/authState.ts (upsert pattern)
// and src/db/schema.ts (close_phone_cache table definition)

// close_phone_cache schema (already exists from Phase 1):
//   phone_e164 TEXT PRIMARY KEY
//   lead_id    TEXT        -- null means known non-lead
//   lead_name  TEXT
//   cached_at  TIMESTAMPTZ DEFAULT NOW()

async function upsertCache(pool: Pool, phone: string, leadId: string | null, leadName: string | null) {
  await pool.query(
    `INSERT INTO close_phone_cache (phone_e164, lead_id, lead_name, cached_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (phone_e164) DO UPDATE
       SET lead_id = EXCLUDED.lead_id,
           lead_name = EXCLUDED.lead_name,
           cached_at = NOW()`,
    [phone, leadId, leadName]
  );
}
```

[VERIFIED: upsert pattern confirmed from Phase 1 summary and src/db/schema.ts; table schema confirmed by reading schema.ts]

### Anti-Patterns to Avoid

- **Calling `CloseApiClient.findLeadByPhone()` outside of `PhoneCache`:** Bypasses the cache, wastes rate limit budget. `PhoneCache` is the only allowed entry point for phone lookups.
- **Caching only hits (not misses):** Unknown numbers get re-queried on every message. Cache `null` for numbers with no matching Close lead.
- **Retry on every non-2xx:** Only retry 429 and transient 5xx. Never retry 400 (bad request), 401 (bad key), or 404 — these are permanent failures.
- **Using `libphonenumber-js/max` instead of `min`:** Doubles parse time and bundle size with no benefit for this use case. WhatsApp JIDs are already valid numbers; we just need formatting, not mobile vs. fixed-line type detection.
- **Assuming `@lid` JIDs contain phone numbers:** They do not. Return `null` and skip processing — do not attempt to normalize `@lid` user values as phone numbers.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| International phone number parsing + E.164 formatting | Custom regex/string manipulation | `libphonenumber-js` | Country code detection alone requires a full lookup table; regex misses extensions, trunk prefixes, and regional formats |
| HTTP retry with exponential backoff | Custom sleep-and-retry loop | `axios-retry` | Edge cases: retry on network error vs. HTTP error; body stream already consumed on first attempt; config mutation safety |
| Basic auth header encoding | Manual `Buffer.from(key + ':').toString('base64')` | axios `auth` config property | axios handles encoding correctly and places it in `Authorization` header; manual encoding is error-prone |

**Key insight:** Phone number normalization looks trivial until you encounter `+44 7700 900000`, `007700900000` (trunk prefix), or `(555) 123-4567`. The only robust solution is a library backed by Google's carrier/country data.

---

## Common Pitfalls

### Pitfall 1: Phone Format Mismatch Causing Silent Lead Miss

**What goes wrong:** Close contacts are entered by sales reps in ad-hoc formats (`+1 (555) 123-4567`, `555-123-4567`, `15551234567`). A lookup against `phone:+15551234567` succeeds, but a lookup against `phone:5551234567` or `phone:+1 555 123-4567` may not, depending on how Close normalizes stored numbers.

**Why it happens:** `normalizeJidToE164` produces a consistent output, but Close's own internal normalization of stored contacts is opaque. Numbers entered as `15551234567` (no `+`) may not match a query for `+15551234567`.

**How to avoid:** Always query with the `+` prefix E.164 string. Close's API normalizes stored contact phones for comparison. Test with a real number that exists in Close entered in multiple formats before shipping.

**Warning signs:** Messages stored in `messages` table with `lead_id = null` for contacts who ARE in Close. Check by manually fetching the lead in Close and comparing its stored phone to what the query sends.

### Pitfall 2: Caching Non-Leads as Null Permanently

**What goes wrong:** A phone number has `lead_id = null` in cache because the contact was not a Close lead at lookup time. The sales team later adds them as a lead. The cache returns `null` for the next hour, missing the sync window.

**Why it happens:** 1-hour TTL for null entries is correct per CLAUDE.md; this is expected behavior. The risk is if the TTL is set much longer.

**How to avoid:** Keep null entries at the same 1-hour TTL as lead hits. Do not extend TTL for misses. This is correct as-specified.

**Warning signs:** Rep says "I just added the contact to Close but their messages aren't appearing." Investigate cache TTL on null entries.

### Pitfall 3: Rate Limit Cascade at Startup

**What goes wrong:** On server restart, the in-memory cache is empty. All reps' sessions resume and start receiving messages. 5 reps × 20 incoming messages = 100 cache misses in < 1 second. All 100 fire simultaneous Close API requests, hitting the ~100 req/min rate limit immediately.

**Why it happens:** In-memory cache is cold; DB cache is not consulted first.

**How to avoid:** The two-layer cache (DB-backed) prevents this: on restart, cache misses first check the DB before hitting Close API. As long as the DB cache from the previous run is < 1 hour old, most lookups are satisfied from the DB. This makes the DB read the critical first step — not optional.

**Warning signs:** Burst of 429 errors in logs immediately after server restart.

### Pitfall 4: Retry-After Header Ignored

**What goes wrong:** Close returns 429 with a `Retry-After: 30` header. The client uses pure exponential backoff starting at 1s, 2s, 4s — retrying 3 times before the rate limit window resets (30s). All retries also fail, and the error propagates.

**Why it happens:** Exponential backoff defaults start too small relative to Close's window.

**How to avoid:** Always read `Retry-After` header first. Fall back to exponential backoff only when the header is absent. The `retryDelay` function in the axios-retry pattern above handles this. [VERIFIED: rate_reset behavior confirmed via making.close.com engineering blog]

### Pitfall 5: TypeScript Strict Mode Null Safety on JID Decode

**What goes wrong:** `jidDecode()` can return `undefined` if the JID is malformed. Accessing `.server` or `.user` on undefined throws at runtime.

**Why it happens:** TypeScript strict mode requires null checks but developers forget to check the `jidDecode` return.

**How to avoid:** Always guard: `const decoded = jidDecode(jid); if (!decoded) return null;`. This is shown in the `normalizeJidToE164` pattern above.

---

## Code Examples

### Types (src/close/types.ts)

```typescript
// Source: Close API patterns (developer.close.com + community examples)
// Fields marked [ASSUMED] are inferred from documentation patterns — verify against live API

export interface LeadInfo {
  leadId: string;      // 'lead_xxxx'
  leadName: string;
}

// [ASSUMED] response shape for GET /api/v1/lead/?query=phone:...
export interface CloseContactPhone {
  phone: string;
  phone_formatted: string;
}

export interface CloseContact {
  id: string;
  phones: CloseContactPhone[];
}

export interface CloseLead {
  id: string;
  display_name: string;
  contacts: CloseContact[];
}

export interface CloseLeadListResponse {
  data: CloseLead[];
  has_more: boolean;
  total_results: number;
}
```

### Client (src/close/client.ts)

```typescript
// Source: axios docs + axios-retry README + Close API Basic auth pattern
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { config } from '../config';
import type { CloseLeadListResponse, LeadInfo } from './types';

const CLOSE_BASE_URL = 'https://api.close.com/api/v1';

function createCloseAxios(): AxiosInstance {
  const instance = axios.create({
    baseURL: CLOSE_BASE_URL,
    auth: { username: config.closeApiKey, password: '' },
    timeout: 10_000,
  });

  axiosRetry(instance, {
    retries: 3,
    retryCondition: (err) =>
      axiosRetry.isNetworkError(err) ||
      err.response?.status === 429 ||
      (err.response?.status ?? 0) >= 500,
    retryDelay: (retryCount, err) => {
      const retryAfter = err.response?.headers?.['retry-after'];
      if (retryAfter) return parseFloat(retryAfter) * 1000;
      return axiosRetry.exponentialDelay(retryCount);
    },
  });

  return instance;
}

export class CloseApiClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = createCloseAxios();
  }

  async findLeadByPhone(e164: string): Promise<LeadInfo | null> {
    const res = await this.http.get<CloseLeadListResponse>('/lead/', {
      params: {
        query: `phone:${e164}`,
        _fields: 'id,display_name',
        _limit: 1,
      },
    });
    const lead = res.data.data[0];
    if (!lead) return null;
    return { leadId: lead.id, leadName: lead.display_name };
  }
}

export const closeClient = new CloseApiClient();
```

### PhoneCache (src/close/phoneCache.ts)

```typescript
// Source: Architecture pattern from .planning/research/ARCHITECTURE.md
// Upsert pattern from src/whatsapp/authState.ts (established in Phase 1)
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

  async lookup(e164: string): Promise<LeadInfo | null> {
    // 1. In-memory check
    const hit = this.mem.get(e164);
    if (hit && hit.expiresAt > Date.now()) return hit.lead;

    // 2. DB cache check
    const dbRow = await pool.query<{
      lead_id: string | null;
      lead_name: string | null;
      cached_at: Date;
    }>(
      `SELECT lead_id, lead_name, cached_at
       FROM close_phone_cache
       WHERE phone_e164 = $1 AND cached_at > NOW() - INTERVAL '1 hour'`,
      [e164]
    );

    if (dbRow.rows.length > 0) {
      const row = dbRow.rows[0];
      const lead = row.lead_id
        ? { leadId: row.lead_id, leadName: row.lead_name ?? '' }
        : null;
      this.mem.set(e164, { lead, expiresAt: Date.now() + ONE_HOUR_MS });
      return lead;
    }

    // 3. Close API call
    const lead = await closeClient.findLeadByPhone(e164);

    // 4. Persist to DB and memory (cache both hits and nulls)
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
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `parsePhoneNumberFromString` (verbose) | `parsePhoneNumber` default export or `libphonenumber-js/min` subpath | libphonenumber-js v1.x+ | Both work; subpath import (`/min`) reduces bundle |
| Hand-rolled axios retry interceptor | `axios-retry` npm package | ~2020 | Less boilerplate, handles body re-use edge case |
| Close `app.close.io` base URL (old) | `api.close.com` base URL (current) | Close rebranding | Old URL may still work but `api.close.com` is canonical |

**Deprecated:**
- `@types/libphonenumber-js`: Not needed — the library ships its own TypeScript types. [ASSUMED based on standard modern npm package practices]

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Close `GET /lead/?query=phone:{e164}` matches contacts by phone number with the E.164 `+` prefix | Code Examples / Pattern 2 | If Close uses a different search syntax (e.g., `phone_number:` field name), the lookup returns 0 results for all numbers — complete sync failure |
| A2 | Close lead response includes `id` and `display_name` fields when `_fields=id,display_name` is set | Code Examples / types.ts | If field names differ, TypeScript will compile but runtime data will be undefined |
| A3 | `libphonenumber-js` ships its own TypeScript definitions (no `@types/` package needed) | State of the Art | Minor — would only require adding `@types/libphonenumber-js` if wrong |
| A4 | `axios-retry` v4.x is compatible with `axios@1.15.0` (CommonJS, no ESM issues) | Standard Stack | If incompatible, fall back to Option B hand-rolled interceptor |

**Validation strategy for A1 (highest risk):** After `CloseApiClient` is built in Task 1, add a manual smoke test: call `findLeadByPhone('+[known lead phone in Close]')` and log the response before wiring into cache. If response is empty, adjust query syntax before proceeding.

---

## Open Questions

1. **Close `phone:` query syntax exact format**
   - What we know: Close's search bar accepts phone number queries; `GET /lead/?query=...` uses the same syntax as the app's search bar
   - What's unclear: Whether the query must be `phone:+15551234567`, `phone:15551234567`, or `phone_number:...`; Close docs were unreachable during research
   - Recommendation: In the Task 1 verification step, test `phone:+[e164]` against a known lead. If it returns 0 results, try without `+` prefix. Log both attempts. The smoke test will resolve this before Phase 3 depends on it.

2. **Close API `Retry-After` header name and format**
   - What we know: Close engineering blog confirms a `rate_reset` value exists in 429 responses; industry standard is `Retry-After` header (seconds)
   - What's unclear: Whether Close uses `Retry-After` (standard), `X-Rate-Limit-Reset` (epoch), or the `rate_reset` body field
   - Recommendation: Log the full 429 response headers in dev mode for the first occurrence. The retry interceptor defaults to exponential backoff if the header is absent, so the system works either way — just less efficiently.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `axios` | CloseApiClient HTTP calls | Yes | 1.15.0 | — |
| `libphonenumber-js` | E.164 normalization | No | Not installed | None — must install |
| `axios-retry` | 429 backoff retry | No | Not installed | Hand-rolled interceptor (Option B) |
| `pg` Pool | Cache persistence | Yes | 8.13.0 | — |
| `close_phone_cache` table | PhoneCache DB layer | Yes | Schema created in Phase 1 | — |
| `config.closeApiKey` | Auth header | Yes | Loaded from env in config.ts | — |

**Missing dependencies with no fallback:**
- `libphonenumber-js` — must be installed before any phone normalization code is written

**Missing dependencies with fallback:**
- `axios-retry` — Option B hand-rolled interceptor in `client.ts` is a viable fallback if install fails

[VERIFIED: confirmed by checking node_modules/ — libphonenumber-js and axios-retry not present; axios@1.15.0, pg@8.13.0 confirmed installed]

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | None configured — no jest.config, no pytest.ini, no test/ directory |
| Config file | None — Wave 0 must create test infrastructure if tests are added |
| Quick run command | `npm run build` (TypeScript compilation is the primary automated check) |
| Full suite command | `npm run build && npx tsx -e "..."` (smoke test script) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SYNC-02 (normalization) | JID `15551234567@s.whatsapp.net` → `+15551234567` | smoke | `npx tsx -e "import { normalizeJidToE164 } from './src/close/phoneCache'; console.log(normalizeJidToE164('15551234567@s.whatsapp.net'))"` | No — inline |
| SYNC-02 (cache hit) | Second lookup within 1 hour hits memory, no DB query | manual-only | Observe log output showing cache hit on second call | No test file |
| SYNC-02 (429 retry) | 429 response triggers retry, eventual success | manual-only | Requires mocked Close API or live rate-limit trigger | No test file |

**No formal test framework exists in this project.** Verification is via:
1. `npm run build` — TypeScript must compile with zero errors
2. Targeted `npx tsx -e "..."` smoke tests in the plan's verification steps
3. Manual smoke test: call `closeClient.findLeadByPhone('+[known number]')` against live Close API

### Wave 0 Gaps

- [ ] No test framework — project uses `npm run build` + ad-hoc tsx scripts for verification
- [ ] Phase 2 verification will rely on `npm run build` (zero TS errors) + manual smoke tests documented in PLAN.md

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Close auth is API key Basic auth, not user auth |
| V3 Session Management | No | No sessions in this module |
| V4 Access Control | No | Phase 2 is internal service layer, no HTTP routes |
| V5 Input Validation | Yes | Validate JID format before normalization; reject `@lid` and `@g.us` |
| V6 Cryptography | No | No crypto operations in this module |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Close API key leakage via logs | Information Disclosure | Never log `config.closeApiKey`; pino configured without secret interpolation |
| Phone number enumeration via cache | Information Disclosure | Cache is internal-only, not exposed via HTTP in Phase 2 |
| 429 DoS via crafted JIDs | Denial of Service | Rate limit retry handles this; `normalizeJidToE164` returns null for invalid JIDs before any API call |

**CLAUDE.md security directives applicable to Phase 2:**
- Never log API key values — confirmed: `config.ts` uses `required()` helper, key is in env var only
- Phone number lookups must use the cache — enforced by making `PhoneCache` the only public interface

---

## Sources

### Primary (HIGH confidence)
- `npm view libphonenumber-js version` — version 1.12.41, published 2026-03-28 [VERIFIED]
- `npm view axios-retry version` — version 4.5.0, published 2024-08-02 [VERIFIED]
- `github.com/catamphetamine/libphonenumber-js` — parsePhoneNumber API, `min` vs `max` bundles, E.164 `.number` property [VERIFIED via WebFetch]
- `baileys.wiki/docs/concepts/whatsapp-ids` — JID format, `jidDecode()`, `@s.whatsapp.net` vs `@lid` [VERIFIED via WebFetch]
- `src/db/schema.ts` (Phase 1 output) — `close_phone_cache` schema confirmed [VERIFIED via Read]
- `src/config.ts` (Phase 1 output) — `config.closeApiKey` confirmed [VERIFIED via Read]
- `src/db/pool.ts` (Phase 1 output) — pool singleton confirmed [VERIFIED via Read]
- `making.close.com/posts/rate-limiting-at-close/` — `rate_reset` in 429 responses confirmed; rate limiting is per-API-key and per-endpoint [VERIFIED via WebFetch]

### Secondary (MEDIUM confidence)
- `developers.getknit.dev/docs/close-crm-usecases` — Close API base URL `https://api.close.com/api/v1/` confirmed [MEDIUM]
- `github.com/closeio/closeio-node` — `lead.search({ query: '...' })` pattern using GET query parameter [MEDIUM — confirmed via WebFetch]
- `WhiskeySockets/Baileys issue #2142` — `@lid` JIDs do not contain phone numbers; use `senderPn` or skip [MEDIUM — confirmed via WebFetch]
- `axios.rest/pages/advanced/retry` — hand-rolled interceptor pattern for 429 [MEDIUM — confirmed via WebFetch]

### Tertiary (LOW confidence)
- Close `GET /lead/?query=phone:{e164}` exact query syntax — inferred from general query syntax examples; Close docs were unreachable during research [LOW — flag A1 in Assumptions Log]
- Close 429 response `Retry-After` header name — inferred from making.close.com blog mentioning `rate_reset`; exact header name not confirmed [LOW — flag in Open Questions]

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions confirmed via npm registry, library APIs confirmed via GitHub/official docs
- Architecture: HIGH — follows established patterns from Phase 1 and existing research files
- Pitfalls: HIGH — confirmed from prior project research (PITFALLS.md) and Baileys issue tracker
- Close API query syntax: LOW — docs unreachable during research; smoke test in plan mitigates

**Research date:** 2026-04-09
**Valid until:** 2026-05-09 (stable libraries; axios-retry and libphonenumber-js update rarely)
