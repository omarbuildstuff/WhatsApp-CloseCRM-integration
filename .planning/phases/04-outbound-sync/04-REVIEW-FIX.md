---
phase: 04-outbound-sync
fixed_at: 2026-04-09T19:10:44Z
review_path: .planning/phases/04-outbound-sync/04-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 04: Code Review Fix Report

**Fixed at:** 2026-04-09T19:10:44Z
**Source review:** .planning/phases/04-outbound-sync/04-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (4 Critical + 3 Warning)
- Fixed: 7
- Skipped: 0

## Fixed Issues

### CR-04: `console.error` used instead of pino logger

**Files modified:** `src/close/client.ts`
**Commit:** f810e63
**Applied fix:** Added `import pino from 'pino'` and `const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })` at module level. Replaced both `console.error` calls (lines 79 and 94) with `logger.error` so structured JSON fields (`activityId`, `leadId`, `err`) are serialized correctly in production log aggregators. Also drove log level from `LOG_LEVEL` env var (addresses IN-02 for this file as a bonus).

---

### CR-01: `getLeadContacts` bypasses the phone cache — CLAUDE.md architecture violation

**Files modified:** `src/close/phoneCache.ts`, `src/close/webhookHandler.ts`
**Commit:** 1d49878
**Applied fix:** Added `LeadPhoneCacheEntry` interface and `leadMem` private map to `PhoneCache`. Added `getLeadPhone(leadId)` method with two-tier lookup: (1) in-memory 1-hour cache, (2) DB query against `close_phone_cache WHERE lead_id = $1`, (3) fallback to `closeClient.getLeadContacts()` with result cached in memory. In `webhookHandler.ts`, added `import { phoneCache } from './phoneCache'` and replaced `closeClient.getLeadContacts(data.lead_id)` with `phoneCache.getLeadPhone(data.lead_id)` at Step 7. This satisfies the CLAUDE.md mandate: "Phone number lookups against Close API MUST use the 1-hour cache."

---

### CR-02: Phone number not validated as E.164 before JID construction

**Files modified:** `src/close/webhookHandler.ts`
**Commit:** 8f04683
**Applied fix:** Replaced `phoneE164.replace(/^\+/, '')` (strips only leading `+`) with `phoneE164.replace(/\D/g, '')` (strips all non-digit characters). Added length guard: if digits is empty, shorter than 7, or longer than 15 characters, logs an error and returns early rather than constructing a malformed JID that could deliver to the wrong recipient.

---

### CR-03: `message_markdown` not validated before sending

**Files modified:** `src/close/webhookHandler.ts`
**Commit:** adf0017
**Applied fix:** Added an explicit guard immediately before `sock.sendMessage`: checks `!data.message_markdown || typeof data.message_markdown !== 'string'` and returns early with a structured error log if the condition holds. This prevents empty WhatsApp messages and potential Baileys undefined-behavior from a null/undefined payload field.

---

### WR-01: No idempotency guard — double-send on webhook retry

**Files modified:** `src/close/webhookHandler.ts`
**Commit:** 2ae286e
**Applied fix:** Added a pre-send DB check at Step 7.5 (after phone resolution, before `sendMessage`): `SELECT id FROM messages WHERE close_activity_id = $1`. If a matching row exists the handler logs at info level and returns early, preventing a second WhatsApp send when Close retries a webhook after a server restart between Steps 8 and 9.

---

### WR-02: `updateWhatsAppActivity` uses `PUT` — may overwrite activity fields

**Files modified:** `src/close/client.ts`
**Commit:** 036be2e
**Applied fix:** Changed `this.http.put(...)` to `this.http.patch(...)` in `updateWhatsAppActivity`. This sends only the `{ external_whatsapp_message_id }` partial payload as a PATCH, avoiding a full-replacement that could clear other activity fields (e.g., `message_markdown`, `lead_id`, `date_created`) on the Close side.

---

### WR-03: `PORT` env var silently produces `NaN` or random port on invalid input

**Files modified:** `src/config.ts`
**Commit:** ff6cae8
**Applied fix:** Replaced `Number(process.env.PORT ?? 3000)` with an explicit `parseInt(rawPort, 10)` followed by a startup-time validation: throws `Error('Invalid PORT env var: "..."')` if the result is `NaN`, less than 1, or greater than 65535. This converts a silent misconfiguration into a loud, immediate startup failure with a clear message.

---

## Skipped Issues

None — all findings were fixed.

---

_Fixed: 2026-04-09T19:10:44Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
