---
phase: 02-close-api-client
plan: 01
subsystem: close-api
tags: [close-api, http-client, phone-normalization, retry-logic, typescript]
dependency_graph:
  requires: []
  provides: [CloseApiClient, closeClient, normalizeJidToE164, Close API types]
  affects: [02-02-phone-cache, 03-whatsapp-listener]
tech_stack:
  added: [libphonenumber-js@^0.10.0, axios-retry@^4.0.0]
  patterns: [axios singleton, axiosRetry with exponential backoff, E.164 normalization]
key_files:
  created:
    - src/close/types.ts
    - src/close/client.ts
    - src/close/normalizeJid.ts
  modified:
    - package.json
    - package-lock.json
decisions:
  - "Use libphonenumber-js/min (not /max) for smaller bundle — sufficient for E.164 formatting"
  - "Singleton closeClient exported at module level — PhoneCache wraps it, no direct instantiation needed"
  - "retryCondition targets 429 and >= 500 explicitly — 400/401 are permanent failures, not retried"
  - "Retry-After header respected before falling back to exponential backoff"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-09"
  tasks_completed: 2
  files_created: 3
  files_modified: 2
---

# Phase 02 Plan 01: Close API Client and JID Normalizer Summary

**One-liner:** Axios-based CloseApiClient with Basic auth, 3-retry 429/5xx backoff, and WhatsApp JID to E.164 normalizer using libphonenumber-js/min.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Install deps and create Close API types | 7e9b84c | package.json, src/close/types.ts |
| 2 | Create CloseApiClient with retry and JID normalizer | 53270f1 | src/close/client.ts, src/close/normalizeJid.ts |

## What Was Built

### src/close/types.ts
Five TypeScript interfaces for Close API response shapes:
- `LeadInfo` — cached lead data (leadId, leadName)
- `CloseContactPhone` — phone entry on a contact
- `CloseContact` — contact with phone array
- `CloseLead` — lead with id, display_name, contacts
- `CloseLeadListResponse` — paginated lead search response

No runtime code — interfaces only.

### src/close/client.ts
`CloseApiClient` class with:
- `baseURL: https://api.close.com/api/v1`
- Basic auth: `config.closeApiKey` as username, empty password
- 10-second timeout
- `axiosRetry` with 3 retries on network errors, HTTP 429, and HTTP >= 500
- Respects `Retry-After` header before falling back to exponential backoff
- Does NOT retry 400 or 401 (permanent failures)
- `findLeadByPhone(e164)` — queries `phone:${e164}` with `_fields: id,display_name` and `_limit: 1`
- Singleton `closeClient` exported at module level

### src/close/normalizeJid.ts
`normalizeJidToE164(jid)` function:
- Uses `jidDecode` from Baileys to parse JID
- Rejects non-phone JIDs: returns `null` for `@lid`, `@g.us`, or malformed
- Prepends `+` to Baileys `user` field (digits-only international number)
- Parses with `libphonenumber-js/min` `parsePhoneNumber`
- Returns E.164 string (e.g., `+15551234567`) or `null` if unparseable

## Verification Results

```
deps OK
E164: +15551234567 | lid: null | group: null
ALL PASS
npm run build — zero TypeScript errors
```

## Deviations from Plan

None — plan executed exactly as written.

## Threat Mitigations Applied

| Threat | Mitigation |
|--------|------------|
| T-02-01 (API key disclosure) | config.closeApiKey used only in axios auth object — never logged or interpolated into strings |
| T-02-02 (JID tampering) | decoded.server checked against 's.whatsapp.net' before processing; @lid and @g.us rejected |
| T-02-03 (Retry storm / DoS) | axiosRetry with retries: 3, exponential backoff, Retry-After header respected |

## Self-Check: PASSED

- [x] src/close/types.ts exists
- [x] src/close/client.ts exists
- [x] src/close/normalizeJid.ts exists
- [x] Commit 7e9b84c exists (Task 1)
- [x] Commit 53270f1 exists (Task 2)
- [x] npm run build — zero errors
- [x] normalizeJidToE164 smoke test — ALL PASS
