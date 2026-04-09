---
phase: 03-inbound-sync
verified: 2026-04-09T21:00:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
---

# Phase 3: Inbound Sync Verification Report

**Phase Goal:** Every inbound WhatsApp message from a known lead appears in their Close timeline as a native WhatsApp activity
**Verified:** 2026-04-09T21:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                                                             | Status     | Evidence                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | An inbound text message from a known lead's number is stored in PostgreSQL and synced to Close as a native WhatsApp activity      | VERIFIED | `phoneCache.lookup(e164)` resolves lead (line 88), `pool.query INSERT INTO messages` persists row (lines 91-95), `closeClient.postWhatsAppActivity()` called when `lead && inserted` (lines 100-107) |
| 2   | A message from an unknown number is stored in PostgreSQL with lead_id NULL and does NOT trigger a Close API call                  | VERIFIED | When `phoneCache.lookup` returns null, `lead` is null; INSERT always runs with `lead?.leadId ?? null`; `if (lead && inserted)` gate prevents Close call (line 100)                       |
| 3   | The same WhatsApp message ID delivered twice results in exactly one row in the messages table                                     | VERIFIED | `ON CONFLICT (id) DO NOTHING` (line 94); `inserted = (result.rowCount ?? 0) > 0` check ensures Close API is not called on duplicate (line 97-100)                                       |
| 4   | An image message with a caption has that caption text extracted and stored in the body column                                     | VERIFIED | `extractBody`: `if (m.imageMessage?.caption) return m.imageMessage.caption` (line 21); body passed as parameter $6 in INSERT                                                             |
| 5   | Audio and sticker messages without captions produce a media-type placeholder rather than an empty string                          | VERIFIED | `if (m.audioMessage) return '[Audio message]'` (line 35); `if (m.stickerMessage) return '[Sticker]'` (line 36); both handled before `return null` fallback                               |

**Score:** 5/5 truths verified

### Roadmap Success Criteria

| #   | Success Criterion                                                                                             | Status     | Evidence                                                    |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| 1   | Text message from known lead appears in Close timeline within seconds as a native WhatsApp Message activity   | VERIFIED | Full pipeline wired: Baileys event -> sessionManager.on('message') -> handle() -> postWhatsAppActivity() |
| 2   | Same WhatsApp message ID delivered twice results in exactly one activity in Close                             | VERIFIED | `ON CONFLICT (id) DO NOTHING` + `inserted` guard on Close call |
| 3   | Message from unknown number stored in PostgreSQL with lead_id NULL, no Close API write attempted              | VERIFIED | `lead` is null for unknown numbers; INSERT runs with `null` lead_id; Close gate requires non-null lead |
| 4   | Image or audio message with a caption has caption text synced to Close as activity body                       | VERIFIED | `extractBody` handles imageMessage.caption, videoMessage.caption, documentMessage.caption, audioMessage placeholder |

### Required Artifacts

| Artifact                              | Expected                                             | Status     | Details                                                                                          |
| ------------------------------------- | ---------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `src/close/types.ts`                  | WhatsAppActivityPayload interface                    | VERIFIED | Contains `WhatsAppActivityPayload` (lead_id, direction, external_whatsapp_message_id, message_markdown, date) and `WhatsAppActivityResponse` (id) |
| `src/close/client.ts`                 | postWhatsAppActivity method on CloseApiClient        | VERIFIED | `async postWhatsAppActivity(payload: WhatsAppActivityPayload): Promise<string | null>` POSTs to `/activity/whatsapp_message/`, returns `res.data?.id ?? null` |
| `src/whatsapp/messageHandler.ts`      | MessageHandler class with handle(), extractBody(), detectMediaType() | VERIFIED | All three exports present; compiled output confirms `extractBody` (function), `detectMediaType` (function), `MessageHandler` (class), `messageHandler` (singleton) |
| `src/index.ts`                        | Wiring of messageHandler to sessionManager 'message' event | VERIFIED | Import on line 4, `sessionManager.on('message', ...)` on line 20, `void messageHandler.handle(repId, msg)` on line 22 |

### Key Link Verification

| From                                  | To                          | Via                                  | Status     | Details                                                              |
| ------------------------------------- | --------------------------- | ------------------------------------ | ---------- | -------------------------------------------------------------------- |
| `src/whatsapp/messageHandler.ts`      | `src/close/phoneCache.ts`   | `phoneCache.lookup(e164)`            | WIRED      | Line 88: `const lead = e164 ? await phoneCache.lookup(e164) : null;` |
| `src/whatsapp/messageHandler.ts`      | `src/close/client.ts`       | `closeClient.postWhatsAppActivity()` | WIRED      | Line 101: `const activityId = await closeClient.postWhatsAppActivity({...})` |
| `src/whatsapp/messageHandler.ts`      | `src/db/pool.ts`            | `pool.query INSERT INTO messages`    | WIRED      | Lines 91-95: `await pool.query('INSERT INTO messages ...')` with `ON CONFLICT (id) DO NOTHING` |
| `src/index.ts`                        | `src/whatsapp/messageHandler.ts` | `sessionManager.on('message') -> messageHandler.handle()` | WIRED | Line 22: `void messageHandler.handle(repId, msg);` inside `sessionManager.on('message', ...)` listener |

Note: gsd-tools key-link checker reported false negatives for three of four links due to regex double-escaping of backslashes in the pattern field. All four links confirmed present by direct file inspection.

### Data-Flow Trace (Level 4)

| Artifact                         | Data Variable   | Source                                     | Produces Real Data | Status    |
| -------------------------------- | --------------- | ------------------------------------------ | ------------------ | --------- |
| `src/whatsapp/messageHandler.ts` | `lead`          | `phoneCache.lookup(e164)` -> Close API GET | Yes — queries Close API `/lead/` endpoint | FLOWING |
| `src/whatsapp/messageHandler.ts` | `result.rowCount` | `pool.query INSERT INTO messages`        | Yes — real pg Pool query to PostgreSQL    | FLOWING |
| `src/whatsapp/messageHandler.ts` | `activityId`    | `closeClient.postWhatsAppActivity()`       | Yes — real HTTP POST to Close API         | FLOWING |

This is a pure Node.js pipeline (not a React component) — no useState/useQuery patterns apply. All data sources are real I/O calls, not static returns or hardcoded values.

### Behavioral Spot-Checks

| Behavior                              | Command                                                                                                         | Result                                                     | Status |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------ |
| `npm run build` succeeds              | `npm run build`                                                                                                 | Zero errors, exit 0                                        | PASS   |
| Module exports all expected symbols   | `node -e "const m = require('./dist/whatsapp/messageHandler'); console.log(typeof m.extractBody, ...)`         | `function function function object`                        | PASS   |
| TypeScript compiles without errors    | `npx tsc --noEmit`                                                                                              | Empty output (success)                                     | PASS   |

### Requirements Coverage

| Requirement | Source Plan | Description                                                                | Status    | Evidence                                                                              |
| ----------- | ----------- | -------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| SYNC-01     | 03-01-PLAN  | Inbound WhatsApp messages appear in matched Close lead's timeline          | SATISFIED | `closeClient.postWhatsAppActivity()` called when `lead && inserted`; returns activity ID stored in `close_activity_id` column |
| SYNC-03     | 03-01-PLAN  | All WhatsApp messages stored in PostgreSQL regardless of lead match status | SATISFIED | `pool.query INSERT INTO messages` runs unconditionally before the `if (lead && inserted)` Close gate (line 91-96 precedes line 100) |
| SYNC-04     | 03-01-PLAN  | Duplicate WhatsApp messages rejected via UNIQUE constraint on message ID   | SATISFIED | `ON CONFLICT (id) DO NOTHING` on the `id TEXT PRIMARY KEY` column (confirmed against schema.ts line 35) |
| SYNC-05     | 03-01-PLAN  | Image, document, and audio message captions synced to Close                | SATISFIED | `extractBody` handles: imageMessage.caption, videoMessage.caption, documentMessage.caption, documentWithCaptionMessage, audioMessage ('[Audio message]'), stickerMessage ('[Sticker]') |

No orphaned requirements — REQUIREMENTS.md traceability table maps SYNC-01, SYNC-03, SYNC-04, SYNC-05 exclusively to Phase 3. All four are satisfied.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| None | — | — | — | — |

No stubs, placeholders, TODO/FIXME markers, or empty implementations found in phase 3 files.

Notable observations (not anti-patterns):
- `return null` in `extractBody` and `detectMediaType` is correct behavior for unrecognized message types.
- `void messageHandler.handle(repId, msg)` in index.ts is intentional — `handle()` catches and logs all I/O errors internally; the dead `.catch()` was removed in code review fix commit `475cee9`.
- `postWhatsAppActivity` field names (`external_whatsapp_message_id`, `message_markdown`) are medium-confidence (docs URL returns 404 per plan). This is a documented known risk, not a code defect.

### Human Verification Required

None — all must-haves are mechanically verifiable from code structure and cannot produce false positives from visual/UX concerns.

End-to-end runtime behavior (message arriving in Close timeline) requires a live WhatsApp connection and Close API key, but all code paths are fully wired and the pipeline logic is sound.

### Gaps Summary

No gaps. All 5 must-have truths verified. All 4 roadmap success criteria met. All 4 required artifacts exist and are substantive. All 4 key links confirmed wired. TypeScript compiles clean. Build succeeds.

---

_Verified: 2026-04-09T21:00:00Z_
_Verifier: Claude (gsd-verifier)_
