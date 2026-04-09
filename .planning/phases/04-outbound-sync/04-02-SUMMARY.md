---
phase: "04-outbound-sync"
plan: "02"
subsystem: "outbound-sync"
tags: [webhook, express, middleware, hmac, baileys, close-api, outbound]

# Dependency graph
requires:
  - phase: "04-01"
    provides: "handleCloseWebhook Express handler"
provides:
  - "POST /webhook/close route wired into Express with express.raw middleware"
  - "Complete outbound sync pipeline operational (compiles and route registered)"
affects:
  - "src/index.ts (webhook route added)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Route-level express.raw() middleware registered BEFORE app.use(express.json()) — preserves raw Buffer for HMAC verification"
    - ".catch() safety net on async handler — prevents unhandled promise rejection from crashing server"

key-files:
  created: []
  modified:
    - "src/index.ts"

key-decisions:
  - "Webhook route registered BEFORE express.json() middleware — critical ordering for HMAC verification correctness"
  - ".catch() wrapper on handleCloseWebhook prevents unhandled promise rejection crash even if handler throws post-response"

patterns-established:
  - "Route-level raw body middleware: use express.raw({ type: 'application/json' }) on specific route, not globally"

requirements-completed: [DASH-05, OUT-01, OUT-02]

# Metrics
duration: 8min
completed: 2026-04-09
---

# Phase 04 Plan 02: Wire Close Webhook Route into Express Summary

**POST /webhook/close wired into Express with express.raw middleware correctly ordered before express.json(), completing the full outbound sync pipeline.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-04-09T00:00:00Z
- **Completed:** 2026-04-09T00:08:00Z
- **Tasks:** 2 (1 auto + 1 checkpoint auto-approved)
- **Files modified:** 1

## Accomplishments

- Imported `handleCloseWebhook` from `./close/webhookHandler` into `src/index.ts`
- Registered `POST /webhook/close` with `express.raw({ type: 'application/json' })` route-level middleware BEFORE `app.use(express.json())`
- Wrapped async handler in `.catch()` safety net (T-04-10 threat mitigation)
- `npm run build` and `npx tsc --noEmit` both succeed with zero errors
- Middleware ordering verified: `express.raw` at line 32, `express.json()` at line 41

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire POST /webhook/close route into Express with raw body middleware** - `c5a0102` (feat)
2. **Task 2: Verify outbound sync pipeline compiles and route is registered** - Auto-approved checkpoint (autonomous mode)

## Files Created/Modified

- `src/index.ts` — Added import for `handleCloseWebhook`, registered `/webhook/close` route with `express.raw` before `express.json()`

## Decisions Made

- Middleware ordering is enforced by code position: webhook route registered before `app.use(express.json())` so the raw Buffer is preserved for HMAC verification — if reversed, `req.body` would be a parsed object and all HMAC checks would fail with 403
- `.catch()` wrapper is placed inline rather than using an Express error-handling middleware to ensure the error logger captures the specific webhook context

## Deviations from Plan

None — plan executed exactly as written.

All threat model mitigations present:
- T-04-09: `express.raw({ type: 'application/json' })` registered as route-level middleware BEFORE `app.use(express.json())`
- T-04-10: `.catch()` wrapper on `handleCloseWebhook` call prevents server crash from async errors

## Issues Encountered

None.

## Known Stubs

None — the route is fully wired to the production `handleCloseWebhook` implementation from Plan 01.

## Threat Flags

No new threat surface introduced. The webhook route was already covered by the Plan 01 threat model (T-04-09, T-04-10).

## Next Phase Readiness

The complete outbound sync pipeline is now operational:
- HMAC-verified Close webhook endpoint at `POST /webhook/close`
- Loop guard preventing infinite send loops (`external_whatsapp_message_id` check)
- Rep routing, Baileys `sendMessage`, PostgreSQL persistence, Close activity patch

To activate: set `CLOSE_WEBHOOK_SECRET` env var to the hex signature_key from your Close webhook subscription, then configure Close to POST to `https://{host}/webhook/close` for WhatsApp Message activity events.

No blockers for Phase 05 (Dashboard / final integration).

---
*Phase: 04-outbound-sync*
*Completed: 2026-04-09*

## Self-Check: PASSED

- `src/index.ts` — EXISTS (contains handleCloseWebhook, express.raw, /webhook/close)
- `.planning/phases/04-outbound-sync/04-02-SUMMARY.md` — EXISTS
- Commit `c5a0102` — EXISTS
- `grep -q handleCloseWebhook src/index.ts` — PASS
- `grep -q express.raw src/index.ts` — PASS
- `grep -q /webhook/close src/index.ts` — PASS
- `npx tsc --noEmit` — PASS (no errors)
- `npm run build` — PASS (exit code 0)
- Middleware ordering: express.raw at line 32, express.json() at line 41 (CORRECT)
