---
phase: "04-outbound-sync"
plan: "01"
subsystem: "outbound-sync"
tags: [webhook, hmac, baileys, close-api, outbound, loop-guard]
dependency_graph:
  requires:
    - "03-inbound-sync (messageHandler, pool, sessionManager, closeClient)"
  provides:
    - "handleCloseWebhook Express handler (ready to wire in Plan 02)"
    - "updateWhatsAppActivity CloseApiClient method"
    - "getLeadContacts CloseApiClient method"
    - "CloseWebhookEvent, CloseWebhookActivityData, WhatsAppActivityUpdatePayload types"
    - "closeWebhookSecret config field"
  affects:
    - "src/close/client.ts (two new methods)"
    - "src/close/types.ts (three new types)"
    - "src/config.ts (one new field)"
tech_stack:
  added: []
  patterns:
    - "Early 200 response before async processing (prevent Close retry storms)"
    - "timingSafeEqual for HMAC comparison (T-04-02)"
    - "Replay protection via timestamp window check (T-04-03)"
    - "Loop guard via external_whatsapp_message_id presence check (T-04-04)"
    - "ON CONFLICT DO NOTHING for idempotent message persistence"
key_files:
  created:
    - "src/close/webhookHandler.ts"
  modified:
    - "src/config.ts"
    - "src/close/types.ts"
    - "src/close/client.ts"
decisions:
  - "Respond 200 immediately after HMAC passes, run send pipeline async — prevents Close webhook retry storms on transient failures"
  - "Loop guard placed as first business logic check (Step 3) after payload parse, before rep routing or any send — this is non-negotiable per CLAUDE.md"
  - "getLeadContacts uses lead_id->phone path rather than reverse phoneCache — outbound webhook only provides lead_id, not customer phone"
  - "verifySignature() catches all exceptions and returns false — prevents 500 on malformed signature headers"
  - "Timestamp dual-mode check (>1e12 = ms, else seconds) handles ambiguity in Close webhook spec"
metrics:
  duration_minutes: 21
  completed_date: "2026-04-09"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 3
---

# Phase 04 Plan 01: Close Webhook Handler for Outbound WhatsApp Summary

**One-liner:** HMAC-verified Close webhook handler with loop guard, rep routing, Baileys sendMessage, PostgreSQL persist, and Close activity patch — full outbound pipeline in four files.

## What Was Built

The complete outbound sync handler that fires when a rep creates a WhatsApp Message activity in Close CRM. Four files implement the pipeline:

1. **`src/config.ts`** — Added `closeWebhookSecret` from `CLOSE_WEBHOOK_SECRET` env var (hex-encoded signature key from Close webhook subscription).

2. **`src/close/types.ts`** — Added three new types:
   - `CloseWebhookEvent` — envelope wrapper with `event.data` nesting
   - `CloseWebhookActivityData` — activity payload fields (id, lead_id, user_id, direction, message_markdown, external_whatsapp_message_id)
   - `WhatsAppActivityUpdatePayload` — PUT body for patching activity with real WA message ID

3. **`src/close/client.ts`** — Added two methods to `CloseApiClient`:
   - `updateWhatsAppActivity(activityId, patch)` — PUT `/activity/whatsapp_message/{id}/`, errors swallowed (non-critical after send succeeds)
   - `getLeadContacts(leadId)` — GET `/lead/{id}/?_fields=contacts`, returns first phone string or null

4. **`src/close/webhookHandler.ts`** — `handleCloseWebhook` Express handler implementing a 10-step pipeline:
   - Step 1: HMAC-SHA256 verify using `verifySignature()` with `timingSafeEqual` (T-04-01, T-04-02)
   - Replay guard: reject if timestamp older than 5 minutes (T-04-03)
   - Step 2: JSON parse with fallback nesting (`event.data` or `data`)
   - Step 3: **Loop guard** — drop if `external_whatsapp_message_id` is set (T-04-04, CLAUDE.md mandate)
   - Step 4: Direction filter — only process `outbound` activities
   - Step 5: Respond `200 { ok: true }` early (T-04-05)
   - Step 6: Query `reps WHERE close_user_id = $1 AND status = 'connected'` (T-04-06, T-04-08)
   - Step 7: `getLeadContacts(lead_id)` → E.164 → `jidEncode(digits, 's.whatsapp.net')`
   - Step 8: `sock.sendMessage(jid, { text })` with null-check on `result?.key?.id`
   - Step 9: INSERT into `messages` with `ON CONFLICT DO NOTHING`
   - Step 10: `updateWhatsAppActivity` patches Close with real WA message ID

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | `5b5516b` | feat(04-01): add webhook secret config, CloseWebhookEvent types, updateWhatsAppActivity and getLeadContacts methods |
| 2 | `6e024ec` | feat(04-01): create Close webhook handler with HMAC, loop guard, Baileys send, persist, and patch |

## Deviations from Plan

None — plan executed exactly as written.

All threat model mitigations (T-04-01 through T-04-09) are present:
- T-04-01/02: `verifySignature()` + `timingSafeEqual`
- T-04-03: 5-minute timestamp replay guard
- T-04-04: Loop guard at Step 3 before any send logic
- T-04-05: Early 200 response, business errors logged only
- T-04-06: Rep query with `close_user_id` + `status='connected'`
- T-04-07: 403 returns only `{ error: 'Invalid signature' }`, no HMAC details
- T-04-08: All DB queries use `$1`/`$2` parameterized placeholders
- T-04-09: Handler documented to require `express.raw()` middleware (wired in Plan 02)

## Known Stubs

None — the handler is complete. It is not yet wired to an Express route; that is Plan 02's responsibility.

## Threat Flags

No new threat surface beyond what the plan's threat model already covers.

## Self-Check: PASSED

- `src/close/webhookHandler.ts` — EXISTS (185 lines, exceeds 80-line minimum)
- `src/config.ts` — contains `closeWebhookSecret`
- `src/close/types.ts` — contains `CloseWebhookEvent`, `CloseWebhookActivityData`, `WhatsAppActivityUpdatePayload`
- `src/close/client.ts` — contains `updateWhatsAppActivity`, `getLeadContacts`
- Commit `5b5516b` — EXISTS
- Commit `6e024ec` — EXISTS
- `npx tsc --noEmit` — PASS (no errors)
- `grep -c timingSafeEqual webhookHandler.ts` = 2
- `grep -c external_whatsapp_message_id webhookHandler.ts` = 5 (>= 2 required)
