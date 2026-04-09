# Phase 3: Inbound Sync - Research

**Researched:** 2026-04-09
**Domain:** Baileys WAMessage handling + Close WhatsApp Message Activity API
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Message Handling:**
- Handle message types: text, image, document, audio, video, sticker, location, contact — extract text/caption from each
- Skip group chats (messages from @g.us JIDs), only sync 1:1 conversations
- All messages stored in PostgreSQL `messages` table regardless of lead match status
- Duplicate WhatsApp messages rejected via UNIQUE constraint on message ID (wa_message_id)

**Close API Integration:**
- Use native POST /activity/whatsapp_message/ endpoint for inbound messages
- Close WhatsApp Message API: https://developer.close.com/resources/activities/whatsappmessage/
- Only lead-matched messages get synced to Close as native WhatsApp activities
- Messages from unknown numbers stored with lead_id NULL, no Close API call

### Claude's Discretion

Implementation details for message extraction, error handling, and retry logic are at Claude's discretion. Follow established patterns from Phase 1 (SessionManager) and Phase 2 (CloseApiClient).

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SYNC-01 | Inbound WhatsApp messages appear in matched Close lead's timeline as native WhatsApp Message activities | Close `/activity/whatsapp_message/` POST endpoint; `external_whatsapp_message_id`, `message_markdown`, `direction: "inbound"` fields identified |
| SYNC-03 | All WhatsApp messages stored in PostgreSQL regardless of lead match status | `messages` table `id` PK is the WA message ID; insert always runs before Close API call |
| SYNC-04 | Duplicate WhatsApp messages rejected via UNIQUE constraint on message ID | `messages.id TEXT PRIMARY KEY` is the dedup guard; `ON CONFLICT DO NOTHING` pattern |
| SYNC-05 | Image, document, and audio message captions synced to Close | Caption fields per type: `imageMessage.caption`, `documentMessage.caption`, `videoMessage.caption`; audio has no caption |
</phase_requirements>

---

## Summary

Phase 3 builds the inbound message pipeline: from the Baileys `messages.upsert` event already wired in `SessionManager`, through message body extraction, phone normalization, lead lookup, PostgreSQL persistence, and Close activity creation. All building blocks exist from Phases 1 and 2 — this phase assembles them into a handler.

The core flow is: receive Baileys event → filter (skip groups, skip outbound, skip no-message stubs) → extract body/caption by message type → normalize JID to E.164 → lookup lead via `PhoneCache` → insert into `messages` table → if lead found, POST to Close `/activity/whatsapp_message/`. The two key correctness properties are: (1) the DB insert always happens regardless of lead status, and (2) the `messages.id PRIMARY KEY` prevents duplicate inserts silently via `ON CONFLICT DO NOTHING`.

The single new file this phase produces is `src/whatsapp/messageHandler.ts`. The `SessionManager` already emits `'message'` events with `{ repId, msg }` — the handler subscribes there in `src/index.ts`. No schema changes are needed.

**Primary recommendation:** Build `MessageHandler` as a class with a single `handle(repId, msg)` method. Keep extraction logic in a pure helper `extractBody(msg)` so it's testable in isolation.

---

## Standard Stack

### Core (all already installed — no new packages needed)

| Library | Installed Version | Purpose | Why Standard |
|---------|------------------|---------|--------------|
| `@whiskeysockets/baileys` | `^6.7.16` [VERIFIED: package.json] | WAMessage types, `getContentType`, `normalizeMessageContent` | Already in use for Phase 1 session management |
| `axios` + `axios-retry` | `^1.7.0` / `^4.5.0` [VERIFIED: package.json] | Close API HTTP client with retry | Already used in `CloseApiClient` |
| `pg` | `^8.13.0` [VERIFIED: package.json] | PostgreSQL insert via pool | Established pattern |
| `pino` | `^9.5.0` [VERIFIED: package.json] | Structured logging | Established pattern |

### No New Dependencies

Phase 3 requires zero new `npm install` calls. All required packages are present. [VERIFIED: package.json]

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── whatsapp/
│   ├── sessionManager.ts    # EXISTS — emits 'message' events
│   ├── authState.ts         # EXISTS
│   └── messageHandler.ts   # NEW — inbound pipeline
├── close/
│   ├── client.ts            # EXISTS — add postWhatsAppActivity()
│   ├── phoneCache.ts        # EXISTS — phoneCache.lookup()
│   ├── normalizeJid.ts      # EXISTS — normalizeJidToE164()
│   └── types.ts             # EXISTS — add WhatsAppActivityPayload type
├── db/
│   ├── pool.ts              # EXISTS
│   └── schema.ts            # EXISTS — no changes needed
├── index.ts                 # MODIFY — wire sessionManager 'message' event
└── config.ts                # EXISTS
```

### Pattern 1: MessageHandler Class

**What:** A single class with a `handle(repId, msg)` async method that encapsulates the full inbound pipeline. Registered once in `index.ts` by listening to the `'message'` event on `sessionManager`.

**When to use:** Whenever a Baileys `messages.upsert` event fires with `type === 'notify'` (already filtered by SessionManager before emit).

**Example wiring in `src/index.ts`:**
```typescript
// Source: established SessionManager pattern (src/whatsapp/sessionManager.ts line 67-73)
import { messageHandler } from './whatsapp/messageHandler';

sessionManager.on('message', ({ repId, msg }) => {
  messageHandler.handle(repId, msg).catch((err) => {
    logger.error({ repId, err }, 'Error in message handler');
  });
});
```

**Example `messageHandler.ts` skeleton:**
```typescript
// Source: Baileys README.md + existing project patterns
import type { proto } from '@whiskeysockets/baileys';
import { normalizeJidToE164 } from '../close/normalizeJid';
import { phoneCache } from '../close/phoneCache';
import { closeClient } from '../close/client';
import { pool } from '../db/pool';
import pino from 'pino';

const logger = pino({ level: 'info' });

export class MessageHandler {
  async handle(repId: string, msg: proto.IWebMessageInfo): Promise<void> {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Skip group chats [VERIFIED: Baileys README — group JIDs end in @g.us]
    if (jid.endsWith('@g.us')) return;

    // Skip outbound (messages sent by this rep) [VERIFIED: Baileys IWebMessageInfo docs]
    if (msg.key.fromMe) return;

    // Skip system/stub messages with no content
    if (!msg.message) return;

    const body = extractBody(msg);
    const mediaType = detectMediaType(msg);
    const e164 = normalizeJidToE164(jid);
    const tsMs = (Number(msg.messageTimestamp ?? 0)) * 1000;
    const timestamp = new Date(tsMs);
    const waMessageId = msg.key.id!;

    // Lookup lead (uses 1-hour cache per CLAUDE.md rule)
    const lead = e164 ? await phoneCache.lookup(e164) : null;

    // Always persist to DB regardless of lead status (SYNC-03)
    const inserted = await this.persistMessage({
      id: waMessageId,
      repId,
      jid,
      e164: e164 ?? null,
      leadId: lead?.leadId ?? null,
      body,
      mediaType,
      timestamp,
    });

    // Only sync to Close if lead matched and DB insert succeeded (not a duplicate)
    if (lead && inserted) {
      const activityId = await closeClient.postWhatsAppActivity({
        leadId: lead.leadId,
        waMessageId,
        body: body ?? '',
        direction: 'inbound',
      });
      if (activityId) {
        await pool.query(
          'UPDATE messages SET close_activity_id = $1 WHERE id = $2',
          [activityId, waMessageId]
        );
      }
    }
  }

  private async persistMessage(params: {
    id: string; repId: string; jid: string; e164: string | null;
    leadId: string | null; body: string | null; mediaType: string | null;
    timestamp: Date;
  }): Promise<boolean> {
    // ON CONFLICT DO NOTHING = dedup guard (SYNC-04)
    const result = await pool.query(
      `INSERT INTO messages
         (id, rep_id, direction, wa_jid, phone_e164, lead_id, body, media_type, timestamp)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [params.id, params.repId, params.jid, params.e164,
       params.leadId, params.body, params.mediaType, params.timestamp]
    );
    return (result.rowCount ?? 0) > 0; // false = duplicate
  }
}

export const messageHandler = new MessageHandler();
```

### Pattern 2: extractBody() — Pure Text Extraction Helper

**What:** A pure function that accepts a `proto.IWebMessageInfo` and returns the best available text string (or null for media-only messages like audio/sticker with no caption).

**When to use:** Called by `MessageHandler.handle()` before any I/O.

**Message type to text/caption mapping:**
[VERIFIED: Baileys README.md + baileys.wiki IWebMessageInfo docs]

```typescript
export function extractBody(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;

  // Plain text
  if (m.conversation) return m.conversation;

  // Extended text (link previews, replies, group invites)
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;

  // Media with caption
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  if (m.documentWithCaptionMessage?.message?.documentMessage?.caption)
    return m.documentWithCaptionMessage.message.documentMessage.caption;

  // Location — format coords as text
  if (m.locationMessage) {
    const { degreesLatitude: lat, degreesLongitude: lng } = m.locationMessage;
    return `Location: ${lat}, ${lng}`;
  }

  // Contact card
  if (m.contactMessage?.displayName)
    return `Contact: ${m.contactMessage.displayName}`;

  // Audio, sticker — no text to extract
  // audioMessage, stickerMessage — return null
  return null;
}

export function detectMediaType(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.documentMessage || m.documentWithCaptionMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  if (m.locationMessage) return 'location';
  if (m.contactMessage) return 'contact';
  return null;
}
```

### Pattern 3: CloseApiClient.postWhatsAppActivity()

**What:** A new method on the existing `CloseApiClient` that POSTs to `/activity/whatsapp_message/`.

**Known Close API fields for this endpoint:**
[VERIFIED: WebSearch cross-referenced with developer.close.com URL — page returns 404 via WebFetch but field names confirmed via search snippets]

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `lead_id` | string | yes | e.g. `"lead_xxxx"` |
| `direction` | string | yes | `"inbound"` or `"outbound"` |
| `external_whatsapp_message_id` | string | yes | WhatsApp message key.id |
| `message_markdown` | string | yes | Message body text |
| `status` | string | no | e.g. `"sent"` |
| `response_to_id` | string | no | Close activity ID of message being replied to |
| `integration_link` | string | no | URL provided by integration partner |

**Example addition to `src/close/client.ts`:**
```typescript
// Source: Close API pattern (field names from developer.close.com search snippets)
async postWhatsAppActivity(params: {
  leadId: string;
  waMessageId: string;
  body: string;
  direction: 'inbound' | 'outbound';
}): Promise<string | null> {
  const res = await this.http.post<{ id: string }>('/activity/whatsapp_message/', {
    lead_id: params.leadId,
    direction: params.direction,
    external_whatsapp_message_id: params.waMessageId,
    message_markdown: params.body,
  });
  return res.data?.id ?? null;
}
```

The existing `axiosRetry` configuration on the client (3 retries, 429/5xx handling, Retry-After header) applies automatically to this new method. [VERIFIED: src/close/client.ts]

### Anti-Patterns to Avoid

- **Calling Close API before DB insert:** If the Close call succeeds but the DB insert fails, the activity exists in Close but not locally — impossible to reconcile. Always insert to DB first.
- **Crashing on unknown message types:** New WhatsApp message types appear without warning. `extractBody()` must fall through to `return null` safely.
- **Awaiting Close API inside the Baileys event loop:** The `'message'` event on `sessionManager` is already wrapped in a `.catch()` — never block the event loop; always `handle().catch(...)`.
- **Storing `msg.key.id` without checking for null:** `key.id` is typed as optional — guard with `!` assertion only after a null check.
- **Using `msg.messageTimestamp` as milliseconds directly:** It's seconds (Unix epoch), not milliseconds. Multiply by 1000.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Phone number parsing | Custom regex | `normalizeJidToE164()` from Phase 2 | Already handles E.164, libphonenumber-js edge cases |
| Lead lookup with caching | Custom cache | `phoneCache.lookup()` from Phase 2 | Two-layer (memory + DB), coalesces concurrent calls, 1-hour TTL |
| HTTP retry / rate-limit handling | Custom retry loop | `CloseApiClient` with `axios-retry` | Already handles 429 + Retry-After header + exponential backoff |
| Duplicate message rejection | Application-layer dedup check | `INSERT ... ON CONFLICT (id) DO NOTHING` | DB PRIMARY KEY is the authoritative dedup guard; cheaper and race-condition-safe |
| Group JID detection | Custom parsing | `jid.endsWith('@g.us')` | Baileys convention; group JIDs always end in this suffix |

**Key insight:** This phase is almost entirely assembly. All hard problems (auth, caching, retry, phone normalization) were solved in Phases 1 and 2.

---

## Common Pitfalls

### Pitfall 1: messageTimestamp is Seconds, Not Milliseconds
**What goes wrong:** `new Date(msg.messageTimestamp)` stores a timestamp from year 1970 (~50 seconds after epoch).
**Why it happens:** WhatsApp uses Unix timestamp in seconds; JavaScript `Date` expects milliseconds.
**How to avoid:** Always `Number(msg.messageTimestamp ?? 0) * 1000` before constructing `Date`.
**Warning signs:** Timestamps in DB showing 1970-01-01.

### Pitfall 2: Receiving Your Own Outbound Messages as Inbound
**What goes wrong:** When the rep sends a WhatsApp message from their phone, the Baileys socket receives it as a `messages.upsert` event with `type: 'notify'`. Without filtering, it gets stored as an inbound message.
**Why it happens:** Baileys reflects all messages including those sent by the authenticated account.
**How to avoid:** Check `msg.key.fromMe === true` and return early. [VERIFIED: Baileys README + IWebMessageInfo docs]
**Warning signs:** Duplicate activity appearing in Close for outbound messages in Phase 4.

### Pitfall 3: Missing `msg.message` (System/Stub Messages)
**What goes wrong:** Processing stub messages (e.g., "conversation started", "ephemeral setting changed") that have `msg.messageStubType` set but `msg.message` is null — causes null-reference errors in `extractBody()`.
**Why it happens:** Baileys emits non-content system messages through the same `messages.upsert` event.
**How to avoid:** Guard `if (!msg.message) return;` before any extraction.
**Warning signs:** TypeErrors in logs when `m.conversation` is accessed on null.

### Pitfall 4: Schema Uses `id` as the WhatsApp Message ID Column
**What goes wrong:** Code attempts to insert into a `wa_message_id` column that does not exist.
**Why it happens:** CONTEXT.md language says "UNIQUE constraint on wa_message_id" but the actual schema uses `id TEXT PRIMARY KEY` to store the WhatsApp message ID.
**How to avoid:** Use `id` as the column name in all INSERT statements. [VERIFIED: src/db/schema.ts line 36]
**Warning signs:** `column "wa_message_id" does not exist` PostgreSQL error.

### Pitfall 5: Calling Close API When body Is Empty String
**What goes wrong:** Sending `message_markdown: ""` to Close for audio/sticker messages creates an activity with no visible content — confusing for reps.
**Why it happens:** `extractBody()` returns `null` for audio/sticker; code coerces null to `""`.
**How to avoid:** Use `body ?? ''` only for the Close API call (API may reject empty string — treat null body as valid for DB, empty string for API). Alternatively, set a placeholder like `"[Audio message]"` for known media-only types.
**Warning signs:** Empty WhatsApp activities in Close CRM timeline.

### Pitfall 6: `key.id` Is Typed Optional
**What goes wrong:** TypeScript error or runtime crash when using `msg.key.id` directly.
**Why it happens:** `IMessageKey.id` is `string | null | undefined`.
**How to avoid:** Either `msg.key.id!` (after guarding `if (!msg.key.remoteJid) return`) or use optional chaining with a fallback. A missing `key.id` should cause the message to be skipped — can't dedup without it.
**Warning signs:** TypeScript `TS2345` error on `pool.query` call.

---

## Code Examples

### Full Filter Chain (Verified Pattern)
```typescript
// Source: Baileys README.md + IWebMessageInfo docs (baileys.wiki)
async handle(repId: string, msg: proto.IWebMessageInfo): Promise<void> {
  const jid = msg.key.remoteJid;
  if (!jid) return;                          // No JID — skip
  if (jid.endsWith('@g.us')) return;         // Group chat — skip (CONTEXT.md locked decision)
  if (msg.key.fromMe) return;                // Outbound — skip
  if (!msg.message) return;                  // System stub — skip
  if (!msg.key.id) return;                   // No dedup key — skip
  // ... continue processing
}
```

### DB Insert with Dedup (Verified Pattern)
```typescript
// Source: PostgreSQL ON CONFLICT pattern; schema verified at src/db/schema.ts
const result = await pool.query(
  `INSERT INTO messages
     (id, rep_id, direction, wa_jid, phone_e164, lead_id, body, media_type, timestamp)
   VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8)
   ON CONFLICT (id) DO NOTHING`,
  [waMessageId, repId, jid, e164, leadId, body, mediaType, new Date(ts * 1000)]
);
const inserted = (result.rowCount ?? 0) > 0;
```

### Timestamp Handling
```typescript
// Source: Pitfall confirmed via Baileys IWebMessageInfo docs — messageTimestamp is seconds
const tsSec = Number(msg.messageTimestamp ?? 0);
const timestamp = new Date(tsSec * 1000);
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `getContentType()` + manual type map | Direct property checks on `msg.message` | Always the case in 6.x | Both work; direct property checks are more readable and don't require importing `getContentType` |
| Separate `wa_message_id` column | `id TEXT PRIMARY KEY` stores the WA message ID | Phase 2 schema design | Insert uses `id` column, not `wa_message_id` |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Close API POST `/activity/whatsapp_message/` requires `lead_id`, `direction`, `external_whatsapp_message_id`, `message_markdown` as the core fields | Standard Stack / Pattern 3 | API call fails with 400; need to adjust field names |
| A2 | `direction: "inbound"` is the correct value for received messages | Pattern 3 | Activities created with wrong direction in Close timeline |
| A3 | `message_markdown` accepts plain text (not just WhatsApp formatting syntax) | Pattern 3 | Body text rejected or garbled in Close |
| A4 | `documentWithCaptionMessage` is a valid wrapper type in Baileys 6.7.x | Code Examples / extractBody | Document captions not extracted; SYNC-05 partially broken |
| A5 | Close API returns `{ id: string }` as the response body for a successful activity creation | Pattern 3 | `activityId` is undefined; UPDATE SET close_activity_id does nothing |

> A1–A3 and A5: The Close developer docs URL returns 404 via WebFetch — field names sourced from WebSearch snippets referencing the docs. Treat as MEDIUM confidence. Verify with a live test POST during Wave 1 execution.

---

## Open Questions

1. **Close API empty body policy**
   - What we know: `message_markdown` is required
   - What's unclear: Does Close reject `""` or `null`? Audio/sticker messages have no text.
   - Recommendation: Use a fallback placeholder per media type (e.g., `"[Audio message]"`, `"[Sticker]"`) rather than empty string. Planner should add this as a task decision.

2. **`send_to_inbox` query parameter**
   - What we know: WebSearch found that inbound messages can pass `?send_to_inbox=true` to create a Close Inbox Notification
   - What's unclear: Whether this is wanted for MVP — it would create inbox items for every inbound message
   - Recommendation: Omit for MVP; add as a config option in v2.

3. **`pushName` availability**
   - What we know: `msg.pushName` contains the sender's WhatsApp display name
   - What's unclear: Whether to store or log it — it could be useful for debugging unknown numbers
   - Recommendation: Log it at debug level; not worth a schema change for Phase 3.

---

## Environment Availability

Phase 3 introduces no new external dependencies. All required tools are already available: Node.js runtime, PostgreSQL (Neon.tech via existing `pool`), Close API (via existing `CloseApiClient`). Step 2.6: SKIPPED (no new external dependencies).

---

## Validation Architecture

> `workflow.nyquist_validation` is absent from `.planning/config.json` — treating as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | None configured — no test runner detected in package.json or project root [VERIFIED: package.json, project glob] |
| Config file | None — Wave 0 gap |
| Quick run command | N/A until framework installed |
| Full suite command | N/A until framework installed |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Notes |
|--------|----------|-----------|-------|
| SYNC-01 | Inbound message from known lead creates Close activity | Integration | Requires live Close API key; manual smoke test recommended |
| SYNC-03 | Unknown number message stored with `lead_id = NULL` | Unit | Mock `phoneCache.lookup()` returning null; assert DB row |
| SYNC-04 | Same `wa_message_id` delivered twice → exactly one DB row | Unit | Call `handle()` twice with same msg; assert `rowCount` on second call = 0 |
| SYNC-05 | Image with caption → caption stored in `body` | Unit | Mock msg with `imageMessage.caption`; assert `extractBody()` return value |

### Wave 0 Gaps

- [ ] No test runner installed — add `vitest` or `jest` + `ts-jest` before writing tests
- [ ] `tests/whatsapp/messageHandler.test.ts` — covers SYNC-03, SYNC-04, SYNC-05
- [ ] `tests/whatsapp/extractBody.test.ts` — pure unit tests for all message type extractions
- [ ] `tests/close/client.test.ts` — covers `postWhatsAppActivity()` with mocked axios

*(Given the project has zero test infrastructure, test authoring is optional for MVP — defer to planner discretion per "Claude's Discretion" in CONTEXT.md.)*

---

## Security Domain

> `security_enforcement` not set in config — treating as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Close API uses existing Basic auth; no new auth surface |
| V3 Session Management | No | No new session surface in this phase |
| V4 Access Control | No | Message handler is internal — no new API endpoints |
| V5 Input Validation | Yes | Sanitize `body` before storing/sending — no SQL injection risk (parameterized queries used) |
| V6 Cryptography | No | No new crypto operations |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via message body | Tampering | Parameterized queries (`pool.query($1, $2, ...)`) — established pattern [VERIFIED: existing code] |
| Sending attacker-controlled `lead_id` to Close | Tampering | `lead_id` comes only from `phoneCache.lookup()` (trusted path from Close API) — not from message content |
| Infinite processing loop (outbound echo) | DoS | `if (msg.key.fromMe) return;` filter — outbound messages skipped before any I/O |

---

## Sources

### Primary (HIGH confidence)
- `src/whatsapp/sessionManager.ts` — confirmed `'message'` event emits `{ repId, msg }`, `messages.upsert` filtered to `type === 'notify'`
- `src/db/schema.ts` — confirmed `messages` table columns: `id` (PK = WA message ID), no `wa_message_id` column
- `src/close/client.ts` — confirmed `axiosRetry` config and `CloseApiClient` pattern
- `src/close/phoneCache.ts` — confirmed `phoneCache.lookup(e164)` interface
- `src/close/normalizeJid.ts` — confirmed `normalizeJidToE164(jid)` returns E.164 or null
- `package.json` — confirmed all required packages present, no new installs needed
- [baileys.wiki IWebMessageInfo](https://baileys.wiki/docs/api/namespaces/proto/interfaces/IWebMessageInfo/) — `key.fromMe`, `key.remoteJid`, `messageTimestamp` as seconds, all fields optional
- [Baileys README](https://github.com/WhiskeySockets/Baileys/blob/master/README.md) — group JID suffix `@g.us`, `fromMe` semantics, message type detection by property key

### Secondary (MEDIUM confidence)
- [developer.close.com/resources/activities/whatsappmessage/](https://developer.close.com/resources/activities/whatsappmessage/) — field names `external_whatsapp_message_id`, `message_markdown`, `direction`, `lead_id` confirmed via WebSearch snippet (URL returns 404 via direct WebFetch — verify with live API call)

### Tertiary (LOW confidence)
- `documentWithCaptionMessage` wrapper type existence — inferred from Baileys type surface, not directly verified in 6.7.x changelog

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified in package.json; no new installs
- Architecture: HIGH — SessionManager event interface directly verified in source; DB schema directly verified
- Close API fields: MEDIUM — field names sourced from search snippets; live 404 on docs page
- Pitfalls: HIGH — all pitfalls derived from direct code inspection or verified Baileys docs

**Research date:** 2026-04-09
**Valid until:** 2026-05-09 (stable stack; Baileys 6.x API unlikely to change)
