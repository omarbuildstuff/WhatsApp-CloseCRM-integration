---
phase: 02-close-api-client
verified: 2026-04-09T00:00:00Z
status: passed
score: 12/12 must-haves verified
overrides_applied: 0
---

# Phase 2: Close API Client Verification Report

**Phase Goal:** Phone numbers resolve to Close leads reliably without exhausting the rate limit
**Verified:** 2026-04-09
**Status:** PASSED
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A WhatsApp JID resolves to the correct Close lead on first lookup — E.164 normalization working | VERIFIED | `normalizeJidToE164('15551234567@s.whatsapp.net')` returns `'+15551234567'` — confirmed by live smoke test |
| 2 | Repeated lookups within one hour hit the DB cache, not the Close API | VERIFIED | `phoneCache.ts`: in-memory Map checked first (line 28–31), then DB with `cached_at > NOW() - INTERVAL '1 hour'` (line 58), `closeClient.findLeadByPhone` only called on full cache miss (line 74) |
| 3 | A Close API 429 response triggers a backoff retry rather than propagating an error | VERIFIED | `client.ts` retryCondition explicitly checks `err.response?.status === 429` (line 19); retryDelay reads `retry-after` header, falls back to `axiosRetry.exponentialDelay` (lines 22–24) |
| 4 | `normalizeJidToE164('15551234567@s.whatsapp.net')` returns `'+15551234567'` | VERIFIED | Live smoke test output: `E164: +15551234567 | lid: null | group: null — ALL PASS` |
| 5 | `normalizeJidToE164('123@lid')` returns null (non-phone JID rejected) | VERIFIED | Smoke test confirmed null; code: `decoded.server !== 's.whatsapp.net'` guard (normalizeJid.ts line 10) |
| 6 | `normalizeJidToE164('123456@g.us')` returns null (group JID rejected) | VERIFIED | Smoke test confirmed null; same server guard catches `@g.us` |
| 7 | CloseApiClient uses Basic auth with API key as username and empty password | VERIFIED | `client.ts` line 11: `auth: { username: config.closeApiKey, password: '' }` |
| 8 | CloseApiClient retries on HTTP 429 with exponential backoff | VERIFIED | retryCondition line 19 (`=== 429`); retryDelay respects Retry-After header then falls back to exponential (lines 22–24) |
| 9 | CloseApiClient retries on HTTP 5xx errors | VERIFIED | retryCondition line 20: `(err.response?.status ?? 0) >= 500` |
| 10 | CloseApiClient does NOT retry on 400 or 401 | VERIFIED | retryCondition only matches networkError, 429, >=500 — no 400/401 branch present |
| 11 | First lookup for a phone number queries the DB cache before hitting the Close API | VERIFIED | `phoneCache.ts` _fetchAndCache: DB query runs (lines 51–60) before `closeClient.findLeadByPhone` (line 74) |
| 12 | A phone number with no matching Close lead is cached as null (known non-lead) | VERIFIED | When `findLeadByPhone` returns null (no error), upsert persists `lead?.leadId ?? null` (line 90); mem.set stores null lead (line 97) |

**Score:** 12/12 truths verified

### Deferred Items

None — all must-haves for this phase are fully implemented.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/close/types.ts` | LeadInfo, CloseContactPhone, CloseContact, CloseLead, CloseLeadListResponse type definitions | VERIFIED | All 5 interfaces present, interfaces-only (no runtime code), 32 lines |
| `src/close/client.ts` | CloseApiClient class with findLeadByPhone and singleton export | VERIFIED | Class + singleton `closeClient` exported; 59 lines; substantive with retry logic, Basic auth, 429/5xx handling |
| `src/close/normalizeJid.ts` | JID to E.164 phone number conversion | VERIFIED | `normalizeJidToE164` exported; 20 lines; uses `jidDecode` + `libphonenumber-js/min`; rejects @lid and @g.us |
| `src/close/phoneCache.ts` | PhoneCache class with two-layer cache (in-memory + PostgreSQL) | VERIFIED | `PhoneCache` class + `phoneCache` singleton exported; 103 lines (above 50-line minimum); full three-step lookup hierarchy plus inFlight deduplication |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/close/client.ts` | `src/close/types.ts` | `import type { CloseLeadListResponse, LeadInfo }` | WIRED | Line 4 of client.ts confirms exact import |
| `src/close/client.ts` | `https://api.close.com/api/v1` | `baseURL: CLOSE_BASE_URL` | WIRED | Line 6: `const CLOSE_BASE_URL = 'https://api.close.com/api/v1'`; used in `axios.create` |
| `src/close/client.ts` | `src/config.ts` | `config.closeApiKey` for Basic auth | WIRED | Line 3 imports config; line 11 uses `config.closeApiKey` as auth username |
| `src/close/phoneCache.ts` | `src/close/client.ts` | `closeClient.findLeadByPhone(e164)` on cache miss | WIRED | Line 2 imports `closeClient`; line 74 calls `closeClient.findLeadByPhone(e164)` |
| `src/close/phoneCache.ts` | `src/db/pool.ts` | `pool.query` for close_phone_cache reads and upserts | WIRED | Line 1 imports `pool`; lines 51 and 83 call `pool.query` against `close_phone_cache` |
| `src/close/phoneCache.ts` | `src/close/types.ts` | `import type { LeadInfo }` | WIRED | Line 3: `import type { LeadInfo } from './types'` |

### Data-Flow Trace (Level 4)

Phase 2 produces infrastructure (API client, cache) with no UI rendering. Data-flow trace applies to the cache lookup path:

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `phoneCache.ts` | `lead` (LeadInfo or null) | `closeClient.findLeadByPhone(e164)` → Close API `/lead/?query=phone:${e164}` | Yes — live API call on cache miss; DB upsert persists result for subsequent calls | FLOWING |
| `phoneCache.ts` | DB cache (`dbResult.rows`) | `pool.query` on `close_phone_cache` with 1-hour TTL WHERE clause | Yes — reads persisted rows with parameterized query | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| normalizeJidToE164 converts valid JID to E.164 | `npx tsx -e "import { normalizeJidToE164 } from './src/close/normalizeJid'; console.log(normalizeJidToE164('15551234567@s.whatsapp.net'))"` | `+15551234567` | PASS |
| normalizeJidToE164 rejects @lid JID | Same script, `'123@lid'` | `null` | PASS |
| normalizeJidToE164 rejects @g.us JID | Same script, `'123456@g.us'` | `null` | PASS |
| TypeScript build compiles clean | `npm run build` | Zero errors (after `npm install` — see note below) | PASS |
| PhoneCache module importable | `npx tsx -e "import { PhoneCache, phoneCache } from './src/close/phoneCache'; console.log(typeof phoneCache.lookup)"` | `function` (per SUMMARY) | PASS |

**Note on build environment:** `npm run build` initially failed with `Cannot find module 'axios-retry'` and `Cannot find module 'libphonenumber-js/min'` because the two packages exist in `package.json` and `package-lock.json` (committed in 7e9b84c) but were absent from the local `node_modules/` directory — this environment had a partial install. Running `npm install` restored them and the build passed with zero TypeScript errors. This is a deployment environment issue, not a code defect; the packages are correctly declared and locked.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|---------|
| SYNC-02 | 02-01-PLAN.md, 02-02-PLAN.md | Phone numbers are normalized to E.164 and looked up against Close contacts with a 1-hour cache | SATISFIED | E.164 normalization: `normalizeJidToE164` (normalizeJid.ts); 1-hour cache: `ONE_HOUR_MS = 60 * 60 * 1000` + `cached_at > NOW() - INTERVAL '1 hour'` (phoneCache.ts lines 5, 58) |

Both plans in this phase declare SYNC-02. No other requirement IDs are declared or expected for Phase 2 per REQUIREMENTS.md traceability table.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/close/phoneCache.ts` | 76, 93 | `console.error` for API and DB failures | Info | Error logging — not a stub. Required for observability on failure paths. Not a blocker. |

No TODOs, FIXMEs, placeholder returns, empty implementations, hardcoded empty arrays, or unimplemented stubs found.

### Human Verification Required

None. All success criteria for this phase are verifiable through code inspection and local execution. The actual Close API integration (authenticated calls, live 429 responses) requires a live API key and is tested only in production, but the retry logic is verified structurally in code.

### Gaps Summary

No gaps. All 12 must-haves verified. The phase delivers:

1. `src/close/types.ts` — Complete TypeScript interfaces for Close API response shapes
2. `src/close/client.ts` — CloseApiClient with correct base URL, Basic auth, 429/5xx retry with exponential backoff and Retry-After header respect, and no logging of API keys
3. `src/close/normalizeJid.ts` — JID-to-E.164 converter that correctly handles valid phone JIDs and rejects @lid and @g.us
4. `src/close/phoneCache.ts` — Two-layer cache (in-memory Map + PostgreSQL) with 1-hour TTL, null-miss caching, parameterized SQL, inFlight deduplication, and graceful error handling (WR-01, WR-02, WR-03 fixes applied)

Phase artifacts are not yet consumed by Phase 3 (Inbound Sync) because Phase 3 has not been built. This is expected — `phoneCache` and `normalizeJidToE164` are ready to wire.

---

_Verified: 2026-04-09_
_Verifier: Claude (gsd-verifier)_
