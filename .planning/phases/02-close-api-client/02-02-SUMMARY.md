---
phase: 02-close-api-client
plan: 02
subsystem: close-api
tags: [close-api, phone-cache, postgresql, two-layer-cache, typescript]
dependency_graph:
  requires: [02-01]
  provides: [PhoneCache, phoneCache, two-layer phone-to-lead cache]
  affects: [03-whatsapp-listener, 04-outbound]
tech_stack:
  added: []
  patterns: [two-layer cache (in-memory Map + PostgreSQL), parameterized SQL upsert, ON CONFLICT DO UPDATE]
key_files:
  created:
    - src/close/phoneCache.ts
  modified: []
decisions:
  - "Cache both hits AND null misses — prevents repeated Close API calls for numbers that don't belong to any lead"
  - "In-memory cache populated on DB hit — avoids DB round-trips within process lifetime after restart"
  - "No clearCache/invalidate method — not needed for MVP; TTL expiry handles staleness"
  - "DB TTL enforced in SQL WHERE clause, not in application code — single source of truth for expiry"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-09"
  tasks_completed: 1
  files_created: 1
  files_modified: 0
---

# Phase 02 Plan 02: PhoneCache Two-Layer Cache Summary

**One-liner:** PhoneCache class with in-memory Map + PostgreSQL close_phone_cache providing 1-hour TTL phone-to-lead lookup that survives restarts and prevents Close API rate limit exhaustion.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create PhoneCache with two-layer caching | e43a37f | src/close/phoneCache.ts |

## What Was Built

### src/close/phoneCache.ts

`PhoneCache` class implementing a three-step lookup hierarchy:

1. **In-memory Map** — `Map<string, CacheEntry>` with `expiresAt` absolute timestamp. Fastest layer, zero DB round-trips within process lifetime after first lookup.

2. **PostgreSQL close_phone_cache** — Persistent cache that survives server restarts. Query uses `cached_at > NOW() - INTERVAL '1 hour'` to enforce TTL. On DB hit, result is populated into the in-memory cache to avoid future DB round-trips.

3. **Close API** — `closeClient.findLeadByPhone(e164)` called only on true cache miss. Result (lead or null) is persisted via `ON CONFLICT (phone_e164) DO UPDATE` upsert to both DB and in-memory cache.

Key implementation details:
- `ONE_HOUR_MS = 60 * 60 * 1000` (3,600,000 ms) — used for in-memory `expiresAt` calculation
- Null misses cached identically to hits — `lead_id = null` in DB means known non-lead; prevents re-querying unknown numbers
- All SQL uses parameterized `$1`, `$2`, `$3` placeholders — no string interpolation of `e164` values
- `phoneCache` singleton exported at module level — callers never instantiate PhoneCache directly

## Verification Results

```
npm run build — zero TypeScript errors
All acceptance criteria verified:
- ONE_HOUR_MS = 60 * 60 * 1000 ✓
- SQL: cached_at > NOW() - INTERVAL '1 hour' ✓
- ON CONFLICT (phone_e164) DO UPDATE ✓
- Null caching: lead?.leadId ?? null ✓
- Imports: pool from '../db/pool', closeClient from './client', LeadInfo from './types' ✓
- Exports: class PhoneCache, const phoneCache ✓
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Missing npm packages in worktree**
- **Found during:** Task 1 (build verification)
- **Issue:** `npm run build` failed with `Cannot find module 'axios-retry'` and `Cannot find module 'libphonenumber-js/min'`. Packages were installed in the main repo (plan 02-01) but not in the worktree's `node_modules`.
- **Fix:** Ran `npm install` in the worktree to install all dependencies from package.json.
- **Files modified:** None (node_modules — not committed)
- **Commit:** N/A (no code change needed)

## Threat Mitigations Applied

| Threat | Mitigation |
|--------|------------|
| T-02-05 (DoS — rate limit flood on restart) | Two-layer cache: DB cache from prior run satisfies most lookups on restart, preventing cold-start API flood |
| T-02-07 (Tampering — SQL injection via e164) | All SQL uses parameterized `$1`, `$2`, `$3` placeholders — e164 never interpolated into query strings |

## Known Stubs

None — PhoneCache is fully wired to `closeClient.findLeadByPhone()` and `pool.query()` against the `close_phone_cache` table.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes introduced. Uses existing `close_phone_cache` table defined in Phase 1 schema.

## Self-Check: PASSED

- [x] src/close/phoneCache.ts exists
- [x] Commit e43a37f exists
- [x] npm run build — zero TypeScript errors
- [x] ONE_HOUR_MS = 60 * 60 * 1000 present
- [x] SQL TTL check with INTERVAL '1 hour' present
- [x] ON CONFLICT (phone_e164) DO UPDATE present
- [x] Null caching (lead?.leadId ?? null) present
- [x] Imports: pool, closeClient, LeadInfo
- [x] Exports: PhoneCache class + phoneCache singleton
