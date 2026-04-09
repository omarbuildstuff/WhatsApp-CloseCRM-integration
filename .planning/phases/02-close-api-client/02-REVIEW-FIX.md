---
phase: 02-close-api-client
fixed_at: 2026-04-09T00:00:00Z
review_path: .planning/phases/02-close-api-client/02-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 02: Code Review Fix Report

**Fixed at:** 2026-04-09
**Source review:** .planning/phases/02-close-api-client/02-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3 (WR-01, WR-02, WR-03 — Critical/Warning only; IN-01, IN-02 excluded)
- Fixed: 3
- Skipped: 0

## Fixed Issues

### WR-01: Unhandled rejection from `closeClient.findLeadByPhone` in cache miss path

**Files modified:** `src/close/phoneCache.ts`
**Commit:** b42d941
**Applied fix:** Wrapped the Close API call in a try/catch that logs the error and returns `null` without caching, allowing callers to continue safely. Wrapped the DB upsert in a separate try/catch so a database failure is logged but does not prevent the in-memory cache entry from being set (survivable degradation).

---

### WR-02: Concurrent cache misses for the same phone trigger multiple parallel Close API calls

**Files modified:** `src/close/phoneCache.ts`
**Commit:** 05cb5a7
**Applied fix:** Added a `private readonly inFlight = new Map<string, Promise<LeadInfo | null>>()` field to `PhoneCache`. The `lookup()` method now checks `inFlight` immediately after the in-memory hit check — if a fetch is already running for the same number, it returns the existing promise. A new `_fetchAndCache()` private method holds the DB cache check + API call + upsert logic. The `inFlight` entry is removed in a `.finally()` handler so it is always cleaned up whether the fetch succeeds or fails.

---

### WR-03: `findLeadByPhone` has no error handling — API errors propagate as untyped exceptions

**Files modified:** `src/close/client.ts`
**Commit:** 67f832e
**Applied fix:** Replaced the direct `res.data.data[0]` access with an `Array.isArray` guard on `res.data?.data`. If the Close API returns a response that does not include a `data` array, an explicit `Error` is thrown with the raw response body included in the message, making malformed-response failures clearly identifiable instead of a silent `TypeError`.

---

_Fixed: 2026-04-09_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
