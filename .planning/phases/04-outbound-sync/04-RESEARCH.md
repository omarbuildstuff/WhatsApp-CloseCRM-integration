# Phase 4: Outbound Sync - Research

**Researched:** 2026-04-09
**Domain:** Close CRM webhooks, Baileys outbound message sending, Express routing, loop guard pattern
**Confidence:** MEDIUM (Baileys send API HIGH from installed types; Close webhook payload structure LOW — docs blocked, derived from patterns)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Close webhook handler MUST check `external_whatsapp_message_id` to avoid infinite loops
- When our integration creates an inbound Close activity (Phase 3), it sets external_whatsapp_message_id
- When Close fires the webhook for that activity, we detect our own ID and silently drop it
- Outbound from Close: Listen for Close webhook on activity.whatsapp_message created, send via rep's Baileys session
- Must determine which rep's Baileys session to use for sending
- Close webhook payload includes the user who created the activity — map to rep via `close_user_id` column on `reps` table

### Claude's Discretion
Implementation details for webhook parsing, rep-to-session routing, error handling, and the outbound message sending flow are at Claude's discretion. Follow established patterns from prior phases.

### Deferred Ideas (OUT OF SCOPE)
None.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OUT-01 | When a rep creates an outgoing WhatsApp activity in Close, the message is delivered to the customer's WhatsApp | Baileys `sock.sendMessage(jid, { text })` — returns `proto.WebMessageInfo | undefined`; message ID in `result.key.id` |
| OUT-02 | The webhook handler checks `external_whatsapp_message_id` to prevent infinite send loops | Close webhook `data.external_whatsapp_message_id` field present on all WhatsApp activities we create — check before processing |
| OUT-03 | Outbound messages are stored in PostgreSQL and the Close activity is updated with the WhatsApp message ID | `messages` table has `direction`, `close_activity_id` columns; Close has a PUT endpoint at `/activity/whatsapp_message/{id}/` |
| DASH-05 | Close webhook endpoint receives and processes outbound message triggers | POST `/webhook/close` route added to Express app in `src/index.ts` |
</phase_requirements>

---

## Summary

Phase 4 wires the outbound direction: a rep creates a WhatsApp Message activity in Close CRM with `direction: outbound`, Close fires a webhook POST to our server, and our handler must (1) verify the request came from Close, (2) drop it immediately if it is a loop (we created it via the integration), (3) route to the correct rep's Baileys session, (4) send the message to the customer's WhatsApp, and (5) update the Close activity with the real WhatsApp message ID and persist the outbound record in PostgreSQL.

The loop guard is the #1 safety concern: every activity our integration creates via `closeClient.postWhatsAppActivity()` includes an `external_whatsapp_message_id` set to the original incoming Baileys message ID. When Close fires a webhook for that activity, the `data.external_whatsapp_message_id` will already be set — that is the sentinel that tells us to silently return `200` and do nothing more. For activities a rep genuinely created in Close's UI (outbound intent), the `external_whatsapp_message_id` will be absent or `null` at the moment the webhook fires, which is our signal to proceed with the send.

Rep routing uses `data.user_id` from the webhook payload. The `reps` table already has a `close_user_id TEXT` column. A simple `SELECT id FROM reps WHERE close_user_id = $1` maps the Close user to the internal rep, and `sessionManager.getSession(repId)` retrieves the live Baileys socket.

**Primary recommendation:** Add `POST /webhook/close` to Express, implement the five-step handler (verify HMAC → loop-guard check → rep lookup → Baileys send → persist + patch Close), and expose `CLOSE_WEBHOOK_SECRET` as a new required env var.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@whiskeysockets/baileys` | 6.7.x (pinned in package.json `^6.7.16`) | Send WhatsApp messages via rep's socket | Already installed, v7 has confirmed 100% connection failure bug |
| `express` | 4.21.x (already installed) | HTTP server, add POST /webhook/close route | Already in use in src/index.ts |
| `crypto` (Node built-in) | Node 22 built-in | HMAC-SHA256 signature verification for Close webhook | Required by Close webhook security spec |
| `pg` | 8.13.x (already installed) | Store outbound message in messages table | Already in use |
| `axios` | 1.x (already installed) | PATCH/PUT Close activity with WA message ID | Already in use via CloseApiClient |
| `pino` | 9.x (already installed) | Structured logging | Already in use |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `express.raw()` middleware | Built into Express 4.x | Parse raw body for HMAC verification | HMAC must be computed on the raw bytes before JSON.parse mutates the body |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Node built-in `crypto` for HMAC | `tweetnacl` or other | `crypto` is sufficient for SHA256 HMAC and has zero install cost |
| Manual HMAC verify | Skip HMAC verification | Skipping means any party can trigger outbound sends — unacceptable security risk |

**Installation:** No new packages needed. All dependencies already installed.

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── close/
│   └── webhookHandler.ts     # New: CloseWebhookHandler class
├── index.ts                  # Add POST /webhook/close route + raw body middleware
└── config.ts                 # Add CLOSE_WEBHOOK_SECRET env var
```

### Pattern 1: Express raw-body + JSON double parse for HMAC

**What:** Register `express.raw({ type: 'application/json' })` on the webhook route BEFORE `express.json()` parses it, so the handler receives the raw `Buffer` for HMAC verification and then manually calls `JSON.parse`.

**When to use:** Any webhook route that requires signature verification against the raw request body.

**Example:**
```typescript
// Source: Close webhook docs [CITED: developer.close.com/topics/webhooks/]
// Raw body needed for HMAC; express.json() already applied globally in index.ts
// Override for this specific route by using express.raw before express.json runs
// One correct pattern: register the route with raw middleware before global json middleware,
// OR use express.raw as route-level middleware:

app.post(
  '/webhook/close',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const rawBody = req.body as Buffer;
    const sigHash = req.headers['close-sig-hash'] as string;
    const sigTimestamp = req.headers['close-sig-timestamp'] as string;
    // compute HMAC then parse JSON
  }
);
```

**CRITICAL:** If `express.json()` is registered globally (it is in `src/index.ts`), you must register the webhook route BEFORE calling `app.use(express.json())`, or use route-level `express.raw` middleware that overrides the content-type handler for that path. [ASSUMED] — Express middleware ordering applies here; confirm that route-level middleware takes precedence.

### Pattern 2: Close HMAC-SHA256 Signature Verification

**What:** Concatenate `close-sig-timestamp` header + raw body string, compute SHA256 HMAC with the `signature_key` (the hex-encoded key from webhook subscription creation), compare timing-safely with `close-sig-hash`.

**When to use:** On every incoming Close webhook POST — the first thing the handler does before any business logic.

**Example:**
```typescript
// Source: Close API docs [CITED: developer.close.com/topics/webhooks/]
import { createHmac, timingSafeEqual } from 'crypto';

function verifyCloseSignature(
  rawBody: Buffer,
  sigTimestamp: string,
  sigHash: string,
  secretHex: string
): boolean {
  const data = sigTimestamp + rawBody.toString('utf8');
  const computed = createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(data, 'utf8')
    .digest('hex');
  return timingSafeEqual(Buffer.from(computed), Buffer.from(sigHash));
}
```

**Key:** `signature_key` is returned by Close's webhook subscription API when you create the subscription. Store it in env as `CLOSE_WEBHOOK_SECRET`. [ASSUMED] — The Close webhook subscription must be created manually or via API before this phase can be end-to-end tested.

### Pattern 3: Loop Guard Check

**What:** The `data.external_whatsapp_message_id` field on the parsed webhook payload is the loop sentinel. Our integration always sets this field when creating activities via `postWhatsAppActivity()`. A rep typing in Close's UI creates an activity where this field is absent/null.

**When to use:** First check after HMAC verification passes. Return `200` immediately without processing.

**Example:**
```typescript
// Loop guard — MUST be the first business logic check
const payload = JSON.parse(rawBody.toString('utf8'));
if (payload.data?.external_whatsapp_message_id) {
  logger.debug({ activityId: payload.data.id }, 'Loop guard triggered — dropping our own activity webhook');
  res.status(200).json({ ok: true });
  return;
}
```

### Pattern 4: Rep-to-Session Routing

**What:** The Close webhook payload includes `data.user_id` (the Close user who created the activity). Query `reps` table with `close_user_id = data.user_id` to get the internal `repId`, then call `sessionManager.getSession(repId)` to get the live Baileys socket.

**When to use:** After loop guard passes, before attempting send.

**Example:**
```typescript
const closeUserId = payload.data?.user_id;
const { rows } = await pool.query(
  "SELECT id FROM reps WHERE close_user_id = $1 AND status = 'connected'",
  [closeUserId]
);
if (rows.length === 0) {
  logger.warn({ closeUserId }, 'No connected rep for Close user — cannot send outbound');
  res.status(200).json({ ok: true }); // return 200 to avoid Close retrying
  return;
}
const repId = rows[0].id;
const sock = sessionManager.getSession(repId);
```

**Error handling:** Return `200` even on errors (not `500`) to prevent Close from infinitely retrying. Log the failure at `error` level for ops visibility.

### Pattern 5: Baileys sendMessage + message ID capture

**What:** Convert the customer's phone number (E.164) to a JID, call `sock.sendMessage`, capture the returned message ID for storage.

**When to use:** After rep session is confirmed live.

**Example:**
```typescript
// Source: Baileys types — installed @whiskeysockets/baileys@6.7.x
// sendMessage: (jid: string, content: AnyMessageContent, options?: ...) => Promise<proto.WebMessageInfo | undefined>

import { jidEncode } from '@whiskeysockets/baileys';

// E.164 "+1234567890" → strip leading + → "1234567890@s.whatsapp.net"
const digits = phoneE164.replace(/^\+/, '');
const jid = jidEncode(digits, 's.whatsapp.net');

const result = await sock.sendMessage(jid, { text: messageText });
const waMessageId = result?.key.id ?? null;
// result can be undefined if send fails silently — handle null case
```

### Pattern 6: Persist outbound + patch Close activity

**What:** Insert outbound message into `messages` table (direction='outgoing'), then PATCH/PUT the Close activity with `external_whatsapp_message_id` set to the real Baileys message ID.

**When to use:** After successful `sendMessage` call.

**Example:**
```typescript
// Step 1: persist
await pool.query(
  `INSERT INTO messages (id, rep_id, direction, wa_jid, phone_e164, lead_id, close_activity_id, body, timestamp)
   VALUES ($1, $2, 'outgoing', $3, $4, $5, $6, $7, NOW())
   ON CONFLICT (id) DO NOTHING`,
  [waMessageId, repId, jid, phoneE164, leadId, closeActivityId, messageText]
);

// Step 2: update Close activity with the real WA message ID
// PUT /activity/whatsapp_message/{id}/ with { external_whatsapp_message_id: waMessageId }
// [ASSUMED] Close uses PUT for full-replace on activity resources; verify exact HTTP method
await closeClient.updateWhatsAppActivity(closeActivityId, { external_whatsapp_message_id: waMessageId });
```

### Anti-Patterns to Avoid
- **Returning 500 on business logic failures:** Close will retry, potentially sending the same message multiple times. Always return `200` once the request is authenticated; log failures internally.
- **Parsing JSON before HMAC check:** HMAC must be computed against the raw body bytes. Parsing first mutates the representation.
- **Using `express.json()` globally before the webhook route:** This will consume `req.body` as an object before the raw buffer is available for HMAC. Register the webhook route with `express.raw` before the global middleware runs, or register the webhook route before `app.use(express.json())`.
- **Storing `messages.id` as the Close activity ID:** The `messages.id` is the Baileys `key.id` (WA message ID). The Close activity ID is a separate column `close_activity_id`.
- **Not guarding against `sendMessage` returning `undefined`:** The type is `Promise<proto.WebMessageInfo | undefined>`. Always null-check `result?.key.id`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HMAC signature verification | Custom timing-unsafe string compare | Node `crypto.timingSafeEqual` | String equality is vulnerable to timing attacks |
| Phone-to-JID conversion | String concatenation `phone + '@s.whatsapp.net'` | `jidEncode(digits, 's.whatsapp.net')` from Baileys | Handles edge cases in JID encoding; already exported by the installed package |
| Webhook retry idempotency | Custom dedup table | `ON CONFLICT (id) DO NOTHING` on `messages` table | The existing UNIQUE constraint on `messages.id` (Baileys key.id) handles duplicate webhook deliveries |

---

## Close Webhook Payload Structure

This is the critical area where live verification is needed. Based on research, the structure is [ASSUMED] for the `data` field shape, [CITED] for the envelope and signature headers:

```jsonc
// POST body from Close — headers include:
// close-sig-hash: <sha256 hex>
// close-sig-timestamp: <unix timestamp string>
// Content-Type: application/json
{
  "event": {
    "id": "ev_xxx",
    "date_created": "2026-04-09T12:00:00.000000+00:00",
    "date_updated": "2026-04-09T12:00:00.000000+00:00",
    "object_type": "activity.whatsapp_message",  // [ASSUMED] object_type value for WA
    "action": "created",
    "organization_id": "orga_xxx",
    "data": {
      "id": "actwh_xxx",                          // Close activity ID
      "lead_id": "lead_xxx",
      "user_id": "user_xxx",                      // Close user who created activity
      "direction": "outbound",
      "message_markdown": "Hello, how can I help?",
      "external_whatsapp_message_id": null,       // null for rep-typed; set for integration-created
      "date_created": "...",
      "date_updated": "..."
    }
  }
}
```

**HIGH confidence fields:** `close-sig-hash` and `close-sig-timestamp` headers — [CITED: developer.close.com/topics/webhooks/ via WebSearch]. Signature is SHA256 HMAC of `timestamp + rawBody` using hex-decoded `signature_key`.

**MEDIUM confidence:** `data.user_id`, `data.direction`, `data.message_markdown`, `data.lead_id` — these match the fields on the WhatsApp activity create payload (we send them, so they should echo back).

**LOW confidence / ASSUMED:** `object_type: "activity.whatsapp_message"` — inferred from Close's convention (e.g., `activity.call`, `activity.email`). **Must be verified with a live test payload before the filter in the webhook handler is finalized.**

**LOW confidence / ASSUMED:** The exact nesting (`event.data` vs `data` at top level) — [ASSUMED] based on Close's documented example for opportunity events showing top-level `action`, `data`, `organization_id`.

**Verification strategy:** The planner should include a Wave 0 task to register the webhook subscription and capture one live test payload using a tool like ngrok + requestbin, then update the handler's field paths accordingly.

---

## Close API: Update Activity After Send

To backfill `external_whatsapp_message_id` on the outbound activity after Baileys confirms delivery:

- **Endpoint:** `PUT /api/v1/activity/whatsapp_message/{id}/` [ASSUMED — Close typically uses PUT for full-replace on activity resources; verify this is not PATCH]
- **Payload:** `{ "external_whatsapp_message_id": "<baileys_msg_key_id>" }` [ASSUMED — consistent with POST payload fields]
- **Auth:** Same Basic auth pattern as existing `closeClient`

`CloseApiClient` needs a new method: `updateWhatsAppActivity(activityId: string, patch: Partial<WhatsAppActivityPayload>): Promise<void>`.

---

## Baileys: Sending Messages

**VERIFIED from installed package type declarations:**

```typescript
// src: node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.d.ts
sendMessage: (
  jid: string,
  content: AnyMessageContent,
  options?: MiscMessageGenerationOptions
) => Promise<proto.WebMessageInfo | undefined>
```

- `jid` format for individual users: `{digits}@s.whatsapp.net` (no `+` prefix, no hyphens)
- `jidEncode(digits, 's.whatsapp.net')` utility exported by Baileys [VERIFIED: npm registry, installed]
- Return value: `proto.WebMessageInfo | undefined` — message ID at `result.key.id` [VERIFIED: consistent with multiple sources + type definition]
- `sock` is obtained via `sessionManager.getSession(repId)` — already returns `WASocket | undefined`

**Outbound message direction in Baileys:** Baileys sets `key.fromMe = true` on sent messages. The `messages.upsert` event in `sessionManager.ts` will fire for these too. The existing `messageHandler.ts` already drops `fromMe` messages at the filter step — no changes needed to inbound handler.

---

## Common Pitfalls

### Pitfall 1: Express middleware ordering destroys raw body
**What goes wrong:** `express.json()` is registered globally in `index.ts` with `app.use(express.json())`. If the webhook route is registered after this, `req.body` is already a parsed object — the raw Buffer is gone and HMAC verification is impossible.
**Why it happens:** Express middleware runs in registration order.
**How to avoid:** Register `POST /webhook/close` with `express.raw({ type: 'application/json' })` as route-level middleware BEFORE the global `express.json()` call. In `index.ts`, add the webhook route before `app.use(express.json())`.
**Warning signs:** `req.body` is an object (not a Buffer) inside the webhook handler.

### Pitfall 2: Loop on the sent Baileys message triggering messageHandler
**What goes wrong:** `sock.sendMessage()` causes Baileys to emit a `messages.upsert` event with `msg.key.fromMe = true`. If the filter in `messageHandler.ts` is removed or incomplete, the outbound message re-enters the inbound pipeline.
**Why it happens:** Baileys echoes sent messages back through the event stream.
**How to avoid:** `messageHandler.ts` already has `if (msg.key.fromMe) return;` on line 69 — this is the guard. Do not remove it.
**Warning signs:** Outbound messages appearing in Close as inbound activities, or double Close activities.

### Pitfall 3: Close webhook fires for our own activity creation → infinite send loop
**What goes wrong:** We POST to Close to create an activity (Phase 3 inbound, Phase 4 activity-update). Close fires a webhook. Our handler processes it as a rep-typed outbound intent and sends a WhatsApp message to the customer.
**Why it happens:** Close webhooks fire for all matching activity creates, including programmatic ones.
**How to avoid:** The loop guard (Pitfall described in CONTEXT.md, pattern documented above). When `data.external_whatsapp_message_id` is non-null, drop the event. This is non-negotiable and must be the first business logic check.
**Warning signs:** Customer receives duplicate WhatsApp messages immediately after sending.

### Pitfall 4: `sendMessage` returns `undefined` — null message ID stored
**What goes wrong:** Baileys `sendMessage` can return `undefined` in some failure states. Code that blindly does `result.key.id` throws `TypeError: Cannot read properties of undefined`.
**Why it happens:** The return type is `Promise<proto.WebMessageInfo | undefined>`.
**How to avoid:** `const waMessageId = result?.key?.id ?? null;` — handle null and log a warning. Do not attempt to update Close activity if waMessageId is null.
**Warning signs:** Uncaught TypeError crashing the webhook handler.

### Pitfall 5: JID format includes `+` prefix
**What goes wrong:** `+15551234567@s.whatsapp.net` is not valid — the `+` is not part of the JID.
**Why it happens:** Phone numbers stored in E.164 include a `+` prefix.
**How to avoid:** Strip `+` before building JID: `phoneE164.replace(/^\+/, '')`. Or use `jidEncode()` which handles the encoding.
**Warning signs:** Baileys throws or the message delivers to nobody.

### Pitfall 6: `close_user_id` not populated in reps table
**What goes wrong:** Rep lookup `WHERE close_user_id = $1` returns 0 rows even for connected reps.
**Why it happens:** The `close_user_id` column exists on `reps` but is never set — it was declared in the schema but Phase 4 is the first phase that requires it to be populated.
**How to avoid:** The planner must include a task to populate `close_user_id` on rep records. This can be done via the existing dashboard API (a PUT to `/api/reps/:id`) or as part of rep setup in Phase 5. For Phase 4 testing, it must be manually set.
**Warning signs:** All outbound webhooks log "No connected rep for Close user" even though a rep is connected.

---

## Runtime State Inventory

> Phase 4 is not a rename/refactor phase. This section is not applicable.

N/A — no renaming or migration operations.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | 22.x (inferred from `@types/node: ^22.0.0`) | — |
| PostgreSQL (Neon) | messages table, reps lookup | Yes | Neon hosted | — |
| `@whiskeysockets/baileys` | sendMessage | Yes | 6.7.x | — |
| `express` | webhook route | Yes | 4.21.x | — |
| `crypto` (Node built-in) | HMAC verification | Yes | Built-in | — |
| Close API (external) | Activity update after send | External service | — | Log failure, continue |
| Close webhook subscription | End-to-end test | Not yet configured | — | Manual registration via Close UI/API required before live test |
| ngrok or similar | Local testing of webhook during dev | Not checked | — | Use `npm run dev` on a publicly reachable host, or deploy to staging |

**Missing dependencies with no fallback:**
- Close webhook subscription must be created (manually in Close UI or via `POST /api/v1/webhook/`) before Phase 4 can be end-to-end tested. The planner should include a Wave 0 task for this.

**Missing dependencies with fallback:**
- None critical to code delivery. Close webhook subscription is required for live testing only, not for code writing.

---

## Validation Architecture

> `workflow.nyquist_validation` key absent from `.planning/config.json` — treated as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None detected in package.json (no jest/vitest/mocha listed) |
| Config file | None — Wave 0 must add |
| Quick run command | `npx tsx --test src/**/*.test.ts` (Node test runner) or install vitest |
| Full suite command | Same |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OUT-02 | Loop guard drops webhook when `external_whatsapp_message_id` is set | unit | `npx vitest run tests/webhookHandler.test.ts` | No — Wave 0 |
| OUT-02 | Loop guard passes when `external_whatsapp_message_id` is null/absent | unit | same file | No — Wave 0 |
| OUT-01 | Rep routing finds correct rep by `close_user_id` | unit | same file | No — Wave 0 |
| DASH-05 | POST /webhook/close returns 200 for valid authenticated payload | integration | `npx vitest run tests/webhookRoute.test.ts` | No — Wave 0 |
| DASH-05 | POST /webhook/close returns 403 for invalid HMAC | integration | same file | No — Wave 0 |
| OUT-03 | Outbound message stored in messages table with direction=outgoing | unit/integration | same file | No — Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/webhookHandler.test.ts` (unit tests only, < 5s)
- **Per wave merge:** Full test suite
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/webhookHandler.test.ts` — covers OUT-01, OUT-02, OUT-03 (unit)
- [ ] `tests/webhookRoute.test.ts` — covers DASH-05 (integration — needs supertest)
- [ ] Install test framework: `npm install --save-dev vitest supertest @types/supertest`

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | — |
| V3 Session Management | No | — |
| V4 Access Control | Yes — reject unauthenticated webhook callers | HMAC-SHA256 via `close-sig-hash` + `close-sig-timestamp` using `crypto.timingSafeEqual` |
| V5 Input Validation | Yes | Validate payload shape before accessing nested fields; handle missing/null gracefully |
| V6 Cryptography | Yes | HMAC-SHA256 using Node `crypto` — never hand-roll |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Spoofed webhook from attacker triggering outbound WA sends | Spoofing | HMAC-SHA256 signature verification on every request |
| Timing attack on HMAC comparison | Tampering | `crypto.timingSafeEqual` — never `===` or `indexOf` for signature comparison |
| Replay attack using captured valid webhook | Tampering | Use `close-sig-timestamp` — reject if timestamp is more than N minutes old [ASSUMED: 5 minutes is convention] |
| Infinite send loop via activity creation | Elevation of Privilege | Loop guard on `external_whatsapp_message_id` — the #1 architecture rule |
| Missing `close_user_id` mapping causes wrong rep to send | Spoofing/Tampering | Strict `status='connected'` check in rep lookup; log and drop (200) if no match |

---

## Code Examples

### Complete Webhook Handler Skeleton
```typescript
// src/close/webhookHandler.ts
// Source: patterns derived from messageHandler.ts, Close signature docs [CITED]

import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { pool } from '../db/pool';
import { sessionManager } from '../whatsapp/sessionManager';
import { closeClient } from './client';
import { jidEncode } from '@whiskeysockets/baileys';
import pino from 'pino';

const logger = pino({ level: 'info' });
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

function verifySignature(rawBody: Buffer, timestamp: string, sigHash: string, secretHex: string): boolean {
  try {
    const data = timestamp + rawBody.toString('utf8');
    const computed = createHmac('sha256', Buffer.from(secretHex, 'hex'))
      .update(data, 'utf8')
      .digest('hex');
    return timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(sigHash, 'hex'));
  } catch {
    return false;
  }
}

export async function handleCloseWebhook(req: Request, res: Response, secret: string): Promise<void> {
  const rawBody = req.body as Buffer;
  const sigHash = req.headers['close-sig-hash'] as string;
  const sigTimestamp = req.headers['close-sig-timestamp'] as string;

  // Step 1: HMAC verification
  if (!sigHash || !sigTimestamp || !verifySignature(rawBody, sigTimestamp, sigHash, secret)) {
    res.status(403).json({ error: 'Invalid signature' });
    return;
  }

  // Step 2: Parse payload
  let event: any;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const data = event?.data ?? event?.event?.data;  // handle both nesting patterns until verified live
  const closeActivityId: string = data?.id;
  const externalWaId: string | null = data?.external_whatsapp_message_id ?? null;
  const direction: string = data?.direction;
  const closeUserId: string = data?.user_id;
  const leadId: string = data?.lead_id;
  const messageText: string = data?.message_markdown ?? '';

  // Step 3: Loop guard — MUST be first business logic check
  if (externalWaId) {
    logger.debug({ closeActivityId, externalWaId }, 'Loop guard: dropping our own activity');
    res.status(200).json({ ok: true });
    return;
  }

  // Step 4: Only process outbound activities created by a rep
  if (direction !== 'outbound') {
    res.status(200).json({ ok: true });
    return;
  }

  // Acknowledge early — send 200 before async work to avoid Close timeout retries
  res.status(200).json({ ok: true });

  // Step 5: async processing (errors here are fire-and-forget, logged but not retried)
  try {
    const { rows } = await pool.query(
      "SELECT id, wa_phone FROM reps WHERE close_user_id = $1 AND status = 'connected'",
      [closeUserId]
    );
    if (rows.length === 0) {
      logger.warn({ closeUserId }, 'No connected rep for Close user — outbound not sent');
      return;
    }
    const repId: string = rows[0].id;
    const sock = sessionManager.getSession(repId);
    if (!sock) {
      logger.warn({ repId }, 'No active Baileys session — outbound not sent');
      return;
    }

    // Step 6: Get phone from lead's contact — need phone from lead_id
    // [ASSUMED] phoneE164 is derivable from the lead; in practice, lead_id alone does not give us the phone.
    // The planner must address how to get phone_e164 for the outbound JID (see Open Questions).
    // Placeholder: attempt lookup via phoneCache or a dedicated lead contact fetch.
    const phoneE164 = await resolvePhoneForLead(leadId);
    if (!phoneE164) {
      logger.warn({ leadId }, 'Cannot resolve phone for lead — outbound not sent');
      return;
    }

    const digits = phoneE164.replace(/^\+/, '');
    const jid = jidEncode(digits, 's.whatsapp.net');

    // Step 7: Send via Baileys
    const result = await sock.sendMessage(jid, { text: messageText });
    const waMessageId = result?.key?.id ?? null;

    if (!waMessageId) {
      logger.error({ repId, closeActivityId }, 'sendMessage returned undefined — WA message ID unknown');
      return;
    }

    // Step 8: Persist
    await pool.query(
      `INSERT INTO messages (id, rep_id, direction, wa_jid, phone_e164, lead_id, close_activity_id, body, timestamp)
       VALUES ($1, $2, 'outgoing', $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [waMessageId, repId, jid, phoneE164, leadId, closeActivityId, messageText]
    );

    // Step 9: Update Close activity with real WA message ID
    await closeClient.updateWhatsAppActivity(closeActivityId, { external_whatsapp_message_id: waMessageId });
    logger.info({ repId, waMessageId, closeActivityId }, 'Outbound message sent and Close activity updated');
  } catch (err) {
    logger.error({ err, closeActivityId }, 'Outbound webhook processing failed');
  }
}
```

### Express Route Registration (in index.ts)
```typescript
// IMPORTANT: Register BEFORE app.use(express.json()) to preserve raw body
import { handleCloseWebhook } from './close/webhookHandler';

// This must come before: app.use(express.json())
app.post(
  '/webhook/close',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    handleCloseWebhook(req, res, config.closeWebhookSecret).catch((err) => {
      logger.error({ err }, 'Webhook handler threw unexpectedly');
      if (!res.headersSent) res.status(500).end();
    });
  }
);
```

### New config.ts entry
```typescript
export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  closeApiKey: required('CLOSE_API_KEY'),
  dashboardPassword: required('DASHBOARD_PASSWORD'),
  closeWebhookSecret: required('CLOSE_WEBHOOK_SECRET'),  // hex key from Close webhook subscription
};
```

### New CloseApiClient method
```typescript
// Add to CloseApiClient in src/close/client.ts
async updateWhatsAppActivity(
  activityId: string,
  patch: Partial<WhatsAppActivityPayload>
): Promise<void> {
  await this.http.put(`/activity/whatsapp_message/${activityId}/`, patch);
  // [ASSUMED] PUT is the correct method; verify against live Close API
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| TimelinesAI webhook passthrough | Custom Close webhook handler | Phase 4 (this phase) | Full control over loop guard and routing |
| Polling Close for new activities | Close push webhooks | Phase 4 | Near-realtime outbound send |

---

## Open Questions

1. **Exact Close webhook payload nesting (`event.data` vs top-level `data`)**
   - What we know: Close docs give an opportunity example; the field names are clear but the nesting is [ASSUMED]
   - What's unclear: Is the WA activity payload at `event.data` or at `data` at top level?
   - Recommendation: Wave 0 task — create a test webhook subscription pointing at ngrok, create a test activity in Close, capture the raw POST body. Parse it once and hardcode the correct path.

2. **How to get the customer phone number from a Close `lead_id` during outbound**
   - What we know: Webhook gives us `lead_id`. The `close_phone_cache` table maps phone → lead, not lead → phone. `CloseApiClient.findLeadByPhone` requires a phone to find a lead, not the reverse.
   - What's unclear: We need a `getLeadContacts(leadId)` call to fetch the phone from the lead's contacts.
   - Recommendation: Add `getLeadContacts(leadId: string): Promise<string[]>` to `CloseApiClient`. Response shape: `GET /api/v1/lead/{id}/` returns `contacts[].phones[].phone`. Cache result in a simple in-process Map (1-hour TTL, same pattern as phoneCache).

3. **HTTP method for updating a Close WhatsApp activity (PUT vs PATCH)**
   - What we know: Close docs mention filtering by `external_whatsapp_message_id` to update activities
   - What's unclear: The exact HTTP verb — PUT (full replace) vs PATCH (partial update)
   - Recommendation: [ASSUMED] Try PUT first (consistent with Close's REST conventions for other activities). If 405, fall back to PATCH. Document the finding.

4. **`object_type` value for WhatsApp Message activities in Close webhook events**
   - What we know: Close uses `activity.call`, `activity.email` convention
   - What's unclear: Is it `activity.whatsapp_message`, `whatsapp_message`, or another string?
   - Recommendation: Capture a live webhook and check the `object_type` field. The webhook subscription event filter should use the correct string; if wrong, no webhooks will fire.

5. **Whether to filter the webhook subscription to only `activity.whatsapp_message` events**
   - What we know: Webhook subscriptions can filter by `object_type` and `action`
   - What's unclear: Whether to subscribe only to WA activities or all activities
   - Recommendation: Subscribe narrowly — `object_type: activity.whatsapp_message, action: created`. Reject other event types in the handler defensively.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `object_type` in Close webhook for WA activities is `"activity.whatsapp_message"` | Webhook Payload Structure | Webhook subscription filter would not match; no events received |
| A2 | Webhook payload nesting is `data.user_id`, `data.external_whatsapp_message_id` (not `event.data.user_id`) | Webhook Payload Structure | Field access paths in handler wrong; loop guard and routing fail |
| A3 | Close uses `PUT /activity/whatsapp_message/{id}/` for updates (not PATCH) | Code Examples — updateWhatsAppActivity | Wrong HTTP method returns 405 from Close API |
| A4 | `external_whatsapp_message_id` is `null` (not absent key) in rep-typed outbound activity webhooks | Loop Guard Pattern | If field is absent, `data?.external_whatsapp_message_id` is `undefined` which is also falsy — loop guard still works, but logging message may differ |
| A5 | Outbound WA activity created by a rep in Close has `direction: "outbound"` | Webhook Payload Structure | Directional filter in handler may incorrectly drop or process the event |
| A6 | Replay attack window of 5 minutes on `close-sig-timestamp` is appropriate | Security Domain | Too narrow = false rejects on slow networks; too wide = replay window |

---

## Project Constraints (from CLAUDE.md)

The following directives from CLAUDE.md are mandatory and override any research recommendations:

1. **Loop guard is non-negotiable:** The Close webhook handler MUST check `external_whatsapp_message_id` to avoid infinite loops — this is in CLAUDE.md as an architecture rule.
2. **PostgreSQL auth state only:** Baileys auth state must persist in PostgreSQL (not filesystem) — already implemented; no changes needed.
3. **1-hour phone cache:** Phone number lookups against Close API MUST use the 1-hour cache — relevant if Phase 4 adds a `getLeadContacts()` method that fetches phones; that method needs the same caching discipline.
4. **All messages stored in DB:** All WhatsApp messages (including outbound) MUST be stored in the `messages` table — outbound INSERT is part of the handler pipeline.
5. **WebSocket for QR:** Not relevant to Phase 4.
6. **Dashboard is single HTML:** Not relevant to Phase 4.
7. **Conventional commits:** `feat:`, `fix:`, `refactor:`, `docs:` — all commits in this phase must follow this convention.
8. **Subagent commits use `--no-verify`:** Executor commits must pass `--no-verify`.

---

## Sources

### Primary (HIGH confidence)
- `node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.d.ts` — `sendMessage` exact signature: `(jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<proto.WebMessageInfo | undefined>`
- `node_modules/@whiskeysockets/baileys/lib/WABinary/jid-utils.d.ts` (inferred) — `jidEncode` exported and verified via `node -e` REPL
- `src/whatsapp/messageHandler.ts` — inbound handler pattern, loop guard via `fromMe`, existing pipeline structure
- `src/db/schema.ts` — confirmed `messages` table columns, `reps.close_user_id` column exists
- `src/close/client.ts` — confirmed `postWhatsAppActivity` and `axios-retry` pattern
- `src/config.ts` — confirmed env var loading pattern for new `CLOSE_WEBHOOK_SECRET`

### Secondary (MEDIUM confidence)
- [Mintlify Baileys JID docs](https://www.mintlify.com/whiskeysockets/Baileys/concepts/whatsapp-ids) — JID format `digits@s.whatsapp.net`, `jidEncode` usage
- [WebSearch: Close webhook HMAC](https://developer.close.com/topics/webhooks/) — `close-sig-hash` is SHA256 HMAC of `timestamp + rawBody` using hex-decoded `signature_key`; `timingSafeEqual` comparison pattern (Python example confirmed by WebSearch snippet)
- [WebSearch: Baileys sendMessage return](https://baileys.whiskeysockets.io) — `result.key.id` pattern for message ID capture, consistent with type declarations

### Tertiary (LOW confidence)
- [ASSUMED] Close webhook `object_type` for WA activities — inferred from `activity.call` / `activity.email` convention
- [ASSUMED] Webhook payload nesting (`data.*` vs `event.data.*`) — inferred from opportunity webhook example in Close docs
- [ASSUMED] `PUT` method for activity update — inferred from Close REST conventions

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified from installed `node_modules` and `package.json`
- Architecture patterns: MEDIUM — Baileys send HIGH; Close webhook payload shape LOW; routing pattern MEDIUM
- Pitfalls: HIGH — all derived from reading existing codebase and confirmed type declarations

**Research date:** 2026-04-09
**Valid until:** 2026-05-09 (stable stack; Close API webhook format may change — LOW confidence items need live verification)
