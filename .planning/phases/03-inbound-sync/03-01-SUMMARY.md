---
phase: 03-inbound-sync
plan: "01"
subsystem: message-sync
tags: [whatsapp, close-api, inbound, postgresql, baileys]
dependency_graph:
  requires:
    - 01-foundation (pool, config, schema)
    - 02-whatsapp-session (sessionManager, usePgAuthState, normalizeJid, phoneCache)
  provides:
    - inbound message pipeline (WhatsApp -> DB -> Close CRM)
    - WhatsAppActivityPayload type
    - postWhatsAppActivity Close API method
    - messageHandler singleton
  affects:
    - src/index.ts (event wiring added)
    - src/close/types.ts (new interfaces)
    - src/close/client.ts (new method)
tech_stack:
  added: []
  patterns:
    - parameterized SQL queries for all DB writes (T-03-01 mitigation)
    - ON CONFLICT (id) DO NOTHING for WhatsApp message dedup (SYNC-04)
    - async handler + .catch() to avoid blocking Baileys event loop
    - phoneCache.lookup() for all lead resolution (1-hour cache, rate-limit safe)
key_files:
  created:
    - src/whatsapp/messageHandler.ts
  modified:
    - src/close/types.ts
    - src/close/client.ts
    - src/index.ts
decisions:
  - "postWhatsAppActivity field names (external_whatsapp_message_id, message_markdown) sourced from WebSearch snippets — medium confidence; single-file fix if Close API returns 400"
  - "extractBody returns null for unknown message types, empty string fallback applied only at Close API call site to keep DB body column nullable"
  - "Errors in steps 3-5 (I/O) are caught and logged; filter chain and extraction errors propagate to allow crash detection"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-09T18:32:54Z"
  tasks_completed: 3
  tasks_total: 3
  files_created: 1
  files_modified: 3
---

# Phase 3 Plan 01: Inbound Message Sync Pipeline Summary

**One-liner:** End-to-end inbound WhatsApp message pipeline — Baileys events to PostgreSQL persistence and Close CRM native WhatsApp Message activities, with text/media extraction, phone normalization, 1-hour lead cache, and duplicate guard.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add WhatsAppActivityPayload type and postWhatsAppActivity method | 3b5d6a2 | src/close/types.ts, src/close/client.ts |
| 2 | Create MessageHandler with extractBody, detectMediaType, and inbound pipeline | f26d6c0 | src/whatsapp/messageHandler.ts |
| 3 | Wire messageHandler to sessionManager message event in index.ts | e1e3463 | src/index.ts |

## What Was Built

### src/close/types.ts
Added `WhatsAppActivityPayload` (lead_id, direction, external_whatsapp_message_id, message_markdown) and `WhatsAppActivityResponse` (id) interfaces.

### src/close/client.ts
Added `postWhatsAppActivity(payload)` method to `CloseApiClient` — POSTs to `/activity/whatsapp_message/`, returns activity ID string or null. Inherits existing axiosRetry (3 retries, Retry-After header, exponential backoff).

### src/whatsapp/messageHandler.ts (new)
Three exports:

**`extractBody(msg)`** — Pure function. Priority order: conversation > extendedTextMessage > imageMessage caption > videoMessage caption > documentMessage caption > documentWithCaptionMessage > locationMessage (formatted coords) > contactMessage (formatted name) > audioMessage ("[Audio message]") > stickerMessage ("[Sticker]") > null.

**`detectMediaType(msg)`** — Pure function. Returns: image | video | audio | document | sticker | location | contact | null.

**`MessageHandler.handle(repId, msg)`** — 5-step pipeline:
1. Filter chain (group chats, outbound, system stubs, no key.id) — no I/O, returns early
2. Extract body, media type, E.164 phone, timestamp (seconds * 1000 conversion)
3. Lead lookup via phoneCache (1-hour cache, coalesced in-flight requests)
4. DB INSERT INTO messages ... ON CONFLICT (id) DO NOTHING — always runs (SYNC-03/SYNC-04)
5. Close API postWhatsAppActivity — only when lead matched AND row inserted (SYNC-01); updates close_activity_id in DB on success

### src/index.ts
Added `messageHandler` import and `sessionManager.on('message')` listener with `.catch()` error logging immediately after `resumeAll()`.

## Threat Mitigations Applied

| Threat | Status |
|--------|--------|
| T-03-01: SQL injection via message body | Mitigated — all queries use parameterized $1/$2 placeholders |
| T-03-02: lead_id spoofing via message content | Mitigated — lead_id comes only from phoneCache.lookup() (Close API search), never from message |
| T-03-03: DoS via outbound echo / group floods | Mitigated — fromMe and @g.us filters run before any I/O |
| T-03-04: Info disclosure via logging | Accepted — body logged only at error level on failure |
| T-03-05: Close API auth spoofing | Mitigated — existing Basic auth config used, no new surface |
| T-03-06: Repudiation | Mitigated — DB insert (with timestamp, rep_id, wa_message_id) precedes any Close API call |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all data flows are wired end-to-end. The `postWhatsAppActivity` field names are medium-confidence (sourced from WebSearch; docs URL returns 404) but this is a known risk documented in the plan, not a stub.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes beyond what the plan specified.

## Self-Check

Files created/modified:
- src/whatsapp/messageHandler.ts: exists
- src/close/types.ts: contains WhatsAppActivityPayload
- src/close/client.ts: contains postWhatsAppActivity
- src/index.ts: contains messageHandler.handle

Commits:
- 3b5d6a2: feat(03-01): add WhatsAppActivityPayload type and postWhatsAppActivity method
- f26d6c0: feat(03-01): create MessageHandler with full inbound sync pipeline
- e1e3463: feat(03-01): wire messageHandler to sessionManager message event in index.ts

## Self-Check: PASSED
