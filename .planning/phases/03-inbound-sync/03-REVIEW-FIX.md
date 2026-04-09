---
phase: 03-inbound-sync
fixed_at: 2026-04-09T18:38:03Z
review_path: .planning/phases/03-inbound-sync/03-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 03: Code Review Fix Report

**Fixed at:** 2026-04-09T18:38:03Z
**Source review:** .planning/phases/03-inbound-sync/03-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5 (CR-01, CR-02, WR-01, WR-02, WR-03)
- Fixed: 5
- Skipped: 0

## Fixed Issues

### CR-01: `messageTimestamp` is a protobuf `Long` — `Number()` conversion produces `NaN`

**Files modified:** `src/whatsapp/messageHandler.ts`
**Commit:** 9cc11ff
**Applied fix:** Replaced `Number(msg.messageTimestamp ?? 0)` with a typeof-guard that calls `.toNumber()` on Long objects and falls back to the raw number for plain `number` values, eliminating NaN production for 64-bit protobuf timestamps.

---

### CR-02: Close activity timestamp is always "now" — message time is not forwarded

**Files modified:** `src/close/types.ts`, `src/whatsapp/messageHandler.ts`
**Commit:** 09c92d1
**Applied fix:** Added optional `date?: string` field (ISO 8601) to `WhatsAppActivityPayload` interface in `types.ts`; passed `timestamp.toISOString()` as `date` in the `postWhatsAppActivity` call in `messageHandler.ts` so Close records the actual WhatsApp message time rather than server-receipt time.

---

### WR-01: Duplicate Close activity possible when `UPDATE messages SET close_activity_id` fails

**Files modified:** `src/whatsapp/messageHandler.ts`
**Commit:** b0dae2f
**Applied fix:** Wrapped the `UPDATE messages SET close_activity_id` query in its own `try/catch` block. On failure it logs at `error` level with `repId`, `waMessageId`, and `activityId` so the orphaned state (activity exists in Close but DB column is NULL) is immediately observable and reconcilable by ops. The outer catch is unchanged and still covers Steps 3–4 failures.

---

### WR-02: `Retry-After` header parsed with `parseFloat` — silently breaks for date-format values

**Files modified:** `src/close/client.ts`
**Commit:** 7aae2e0
**Applied fix:** Extended the `retryDelay` callback to first attempt `parseFloat` (seconds-integer format), then fall back to `Date.parse` (HTTP-date format) with `Math.max(0, targetMs - Date.now())` as the delay. Falls through to `exponentialDelay` only when neither format is parseable, preventing the zero-delay hammering on date-format 429 responses.

---

### WR-03: Inner `try/catch` in `handle()` swallows all errors — outer `.catch()` in `index.ts` never fires

**Files modified:** `src/index.ts`
**Commit:** 475cee9
**Applied fix:** Replaced the unreachable `.catch((err) => logger.error(...))` with `void messageHandler.handle(repId, msg)` plus an inline comment explaining that `handle()` catches and logs all processing errors internally. Eliminates the false-safety appearance while keeping the intent clear.

---

## Skipped Issues

None — all in-scope findings were fixed.

---

_Fixed: 2026-04-09T18:38:03Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
