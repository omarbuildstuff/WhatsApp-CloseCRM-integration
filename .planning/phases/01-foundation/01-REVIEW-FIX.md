---
phase: 01-foundation
fixed_at: 2026-04-09T00:00:00Z
review_path: .planning/phases/01-foundation/01-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 01: Code Review Fix Report

**Fixed at:** 2026-04-09T00:00:00Z
**Source review:** .planning/phases/01-foundation/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5
- Fixed: 5
- Skipped: 0

## Fixed Issues

### CR-01: TLS Certificate Verification Disabled for Database Connection

**Files modified:** `src/db/pool.ts`
**Commit:** 4aca507
**Applied fix:** Removed `ssl: { rejectUnauthorized: false }` from the Pool constructor. The `sslmode=require` already present in `DATABASE_URL` handles TLS correctly, so the override that disabled certificate validation is no longer needed.

### WR-01: Pending Reconnect Timer Not Cancelled on Explicit Disconnect/Logout

**Files modified:** `src/whatsapp/sessionManager.ts`
**Commit:** e15d461
**Applied fix:** Added `private reconnectTimers = new Map<string, NodeJS.Timeout>()`. In `handleReconnect`, the `setTimeout` return value is now stored in the map. Both `disconnect()` and `logout()` cancel any pending timer via `clearTimeout` before proceeding, preventing stale reconnect timers from firing after an intentional disconnect.

### WR-02: Unhandled Promise Rejection in Async `connection.update` Handler

**Files modified:** `src/whatsapp/sessionManager.ts`
**Commit:** e15d461
**Applied fix:** Extracted the async handler body into a named `handleConnectionUpdate` function. The `sock.ev.on('connection.update', ...)` listener is now synchronous and calls `handleConnectionUpdate(update).catch(err => logger.error(...))`, ensuring DB errors are logged rather than silently dropped by the EventEmitter.

### WR-03: `logout()` Leaves Stale State on Network Error

**Files modified:** `src/whatsapp/sessionManager.ts`
**Commit:** e15d461
**Applied fix:** Wrapped `sock.logout()` in a `try/catch` inside `logout()`. On failure, a warning is logged and execution continues. `clearAuthState()` and the DB status update to `needs_qr` now always run regardless of whether the WhatsApp socket logout call succeeds.

### WR-04: `closeApiKey` and `dashboardPassword` Silently Default to Empty String

**Files modified:** `src/config.ts`
**Commit:** c13b580
**Applied fix:** Changed `process.env.CLOSE_API_KEY ?? ''` and `process.env.DASHBOARD_PASSWORD ?? ''` to use the existing `required()` helper. Missing values now throw at startup with a clear error message instead of silently producing an empty string that causes runtime failures.

---

_Fixed: 2026-04-09T00:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
