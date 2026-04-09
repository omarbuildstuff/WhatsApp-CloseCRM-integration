---
phase: 04-outbound-sync
reviewed: 2026-04-09T00:00:00Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - src/close/webhookHandler.ts
  - src/close/client.ts
  - src/close/types.ts
  - src/index.ts
  - src/config.ts
findings:
  critical: 4
  warning: 3
  info: 3
  total: 10
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-04-09
**Depth:** standard
**Files Reviewed:** 5
**Status:** issues_found

## Summary

Reviewed five files implementing the outbound sync pipeline: the Close webhook handler, the Close API client, shared types, the Express entry point, and config. The core HMAC signature verification and loop guard logic are well-constructed. However, there are four critical issues that will cause failures in production: the outbound pipeline bypasses the mandatory phone cache (a CLAUDE.md architecture rule violation that will cause rate-limit exhaustion), mixed logging conventions (`console.error` vs pino), unvalidated phone number format before JID construction, and unvalidated `message_markdown` content before it is sent to Baileys. Additionally, there is no idempotency guard against double-sends on webhook retries.

---

## Critical Issues

### CR-01: `getLeadContacts` bypasses the phone cache — CLAUDE.md architecture violation

**File:** `src/close/client.ts:86-97`
**Issue:** `webhookHandler.ts` calls `closeClient.getLeadContacts(data.lead_id)` on every outbound webhook event. This makes a live HTTP request to the Close API (`GET /lead/{id}/`) with no caching. CLAUDE.md explicitly mandates: "Phone number lookups against Close API MUST use the 1-hour cache to respect rate limits." At any volume of outbound activity, this will exhaust Close API rate limits and cause 429s that block the entire outbound pipeline.

The `PhoneCache` class in `src/close/phoneCache.ts` provides the required two-tier (memory + PostgreSQL) caching but is not used in this code path. The cache is currently keyed by E.164 phone number, not lead ID; a lead-ID-keyed cache or a reverse lookup needs to be added.

**Fix:** Add lead-ID keyed caching to `PhoneCache` (or a separate `LeadCache`) and route the outbound pipeline through it:

```typescript
// In src/close/phoneCache.ts — add lead-ID lookup method
private readonly leadMem = new Map<string, { phone: string | null; expiresAt: number }>();

async getLeadPhone(leadId: string): Promise<string | null> {
  const memHit = this.leadMem.get(leadId);
  if (memHit && memHit.expiresAt > Date.now()) return memHit.phone;

  // DB cache check
  const dbResult = await pool.query<{ phone_e164: string | null }>(
    `SELECT phone_e164 FROM close_phone_cache WHERE lead_id = $1 AND cached_at > NOW() - INTERVAL '1 hour'`,
    [leadId]
  );
  if (dbResult.rows.length > 0) {
    const phone = dbResult.rows[0].phone_e164 ?? null;
    this.leadMem.set(leadId, { phone, expiresAt: Date.now() + ONE_HOUR_MS });
    return phone;
  }

  // Fallback to live API — then cache result
  const phone = await closeClient.getLeadContacts(leadId);
  this.leadMem.set(leadId, { phone, expiresAt: Date.now() + ONE_HOUR_MS });
  return phone;
}

// In webhookHandler.ts Step 7 — replace:
const phoneE164 = await closeClient.getLeadContacts(data.lead_id);
// With:
const phoneE164 = await phoneCache.getLeadPhone(data.lead_id);
```

---

### CR-02: Phone number not validated as E.164 before JID construction — can send to wrong recipient

**File:** `src/close/webhookHandler.ts:152-153`
**Issue:** The value returned by `getLeadContacts` is taken directly from the Close API response (`contacts[0].phones[0].phone`). Close stores phone numbers in user-entered formats — they may be `(555) 555-0100`, `+1-555-555-0100`, `555.555.0100`, or other local formats. The code only strips a leading `+`:

```typescript
const digits = phoneE164.replace(/^\+/, '');
const jid = jidEncode(digits, 's.whatsapp.net');
```

If `phoneE164` contains spaces, dashes, parentheses, or no country code, `jidEncode` will silently construct a malformed JID. Baileys will attempt to send; WhatsApp will silently fail or deliver to the wrong number. This is a data integrity issue — messages could be misdelivered.

**Fix:** Normalize the phone number to strict E.164 digits-only before encoding. Consider using a library like `libphonenumber-js`, or at minimum strip all non-digit characters and validate the result:

```typescript
// Normalize: remove all non-digit characters
const digits = phoneE164.replace(/\D/g, '');
if (!digits || digits.length < 7 || digits.length > 15) {
  logger.error({ leadId: data.lead_id, phoneE164 }, 'Invalid phone number format — cannot construct JID');
  return;
}
const jid = jidEncode(digits, 's.whatsapp.net');
```

---

### CR-03: `message_markdown` not validated before sending — can send empty or null messages

**File:** `src/close/webhookHandler.ts:156`
**Issue:** `data.message_markdown` is passed directly to Baileys without any validation:

```typescript
const result = await sock.sendMessage(jid, { text: data.message_markdown });
```

The `CloseWebhookActivityData` type declares `message_markdown: string`, but JSON deserialization at runtime could produce `null`, `undefined`, or an empty string if the Close payload is malformed or the field is absent. Sending `{ text: "" }` to Baileys sends an empty WhatsApp message to the recipient; sending `{ text: null }` may throw inside Baileys or produce undefined behavior. Neither case is caught before reaching the send call.

**Fix:** Add an explicit guard:

```typescript
if (!data.message_markdown || typeof data.message_markdown !== 'string') {
  logger.error({ closeActivityId: data.id }, 'Empty or missing message_markdown — dropping');
  return;
}
const result = await sock.sendMessage(jid, { text: data.message_markdown });
```

---

### CR-04: `console.error` used instead of pino logger — loses structured logging

**File:** `src/close/client.ts:79`, `src/close/client.ts:93`
**Issue:** Two error paths in `CloseApiClient` use raw `console.error`:

```typescript
// Line 79
console.error({ activityId, err }, 'Failed to update Close activity with WA message ID — non-critical');

// Line 93
console.error({ leadId, err }, 'Failed to fetch lead contacts from Close');
```

`console.error` with an object first argument does not serialize the object as JSON — it prints `[object Object]` followed by the string in most Node.js environments. The rest of the codebase uses `pino` for structured JSON logging. These two paths will produce unparseable log output in production, making it impossible to correlate errors by `activityId` or `leadId` in a log aggregator.

**Fix:** Import and use pino:

```typescript
import pino from 'pino';
const logger = pino({ level: 'info' });

// In updateWhatsAppActivity catch block:
logger.error({ activityId, err }, 'Failed to update Close activity with WA message ID — non-critical');

// In getLeadContacts catch block:
logger.error({ leadId, err }, 'Failed to fetch lead contacts from Close');
```

---

## Warnings

### WR-01: No idempotency guard — double-send on webhook retry

**File:** `src/close/webhookHandler.ts:156-169`
**Issue:** There is no check for an existing row in the `messages` table with `close_activity_id = data.id` before calling `sock.sendMessage`. Close will retry the webhook if it does not receive a 200 within its timeout window (the 200 is sent at Step 5, so retries are unlikely for normal operation — but if the server restarts between Steps 8 and 9, the message is sent but not persisted, and a retry will send it again). Because each `sock.sendMessage` call returns a new unique `waMessageId`, the `ON CONFLICT (id) DO NOTHING` on line 165 will not protect against this — both inserts will succeed.

**Fix:** Add a pre-send idempotency check:

```typescript
// Before Step 8 (sendMessage)
const existing = await pool.query(
  'SELECT id FROM messages WHERE close_activity_id = $1',
  [data.id]
);
if (existing.rows.length > 0) {
  logger.info({ closeActivityId: data.id }, 'Already processed — skipping duplicate webhook');
  return;
}
```

---

### WR-02: `updateWhatsAppActivity` uses `PUT` — may overwrite activity fields

**File:** `src/close/client.ts:76`
**Issue:** The method uses `http.put(...)` to send only `{ external_whatsapp_message_id: waMessageId }`. Depending on the Close API's semantics for `PUT /activity/whatsapp_message/{id}/`, a full-replacement PUT with a partial payload may clear other fields on the activity (e.g., `message_markdown`, `date_created`, `lead_id`). The Close documentation for WhatsApp activities should be consulted to confirm whether `PUT` is a partial or full replacement. If full replacement is required, all current activity fields must be fetched and re-included in the payload.

**Fix:** If Close supports `PATCH` for partial updates, prefer it:

```typescript
await this.http.patch(`/activity/whatsapp_message/${activityId}/`, patch);
```

If only `PUT` is available, fetch the current activity first and merge the patch into the full payload before sending.

---

### WR-03: `PORT` env var silently produces `NaN` or random port on invalid input

**File:** `src/config.ts:13`
**Issue:** `Number(process.env.PORT ?? 3000)` returns `NaN` when `PORT` is set to a non-numeric string (e.g., `PORT=abc`) and returns `0` when `PORT` is set to an empty string. `app.listen(NaN)` or `app.listen(0)` in Node.js does not throw — it listens on a random available port, making the server unreachable. This will surface as a silent misconfiguration in deployment.

**Fix:** Validate the port value at startup:

```typescript
const rawPort = process.env.PORT ?? '3000';
const port = parseInt(rawPort, 10);
if (isNaN(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT env var: "${rawPort}"`);
}

export const config = {
  // ...
  port,
  // ...
};
```

---

## Info

### IN-01: Dual webhook envelope shape parsing is undetected in production

**File:** `src/close/webhookHandler.ts:92-95`
**Issue:** The code simultaneously accepts two incompatible JSON envelope shapes with the comment "Support both nesting shapes until live verification confirms one." There is no logging when either shape is matched, so it is impossible to determine from logs which shape Close is actually sending in production. If neither shape matches, the event is silently dropped with a 200.

**Fix:** Add a debug log indicating which shape was matched, and add a log (at warn level) when neither shape matches:

```typescript
const eventData = (parsed as { event?: { data?: CloseWebhookActivityData } })?.event?.data;
const flatData = (parsed as { data?: CloseWebhookActivityData })?.data;
const data = eventData ?? flatData;

if (eventData) logger.debug({ activityId: data?.id }, 'Envelope shape: nested event.data');
else if (flatData) logger.debug({ activityId: data?.id }, 'Envelope shape: flat data');
else logger.warn({ parsed }, 'Unrecognized webhook envelope shape');
```

---

### IN-02: Log level hardcoded to `'info'` in two modules

**File:** `src/close/webhookHandler.ts:11`, `src/index.ts:9`
**Issue:** Both modules instantiate `pino({ level: 'info' })` with the level hardcoded. This makes it impossible to enable debug logging in production without a code change, and means debug-level logs (e.g., the loop guard log at line 107) are silently dropped in production even when troubleshooting is needed.

**Fix:** Drive log level from an environment variable:

```typescript
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
```

---

### IN-03: `findLeadByPhone` sends raw E.164 string in Close query without URL encoding awareness

**File:** `src/close/client.ts:44-50`
**Issue:** The search query is built as `phone:${e164}` where `e164` begins with `+`. The `+` character is meaningful in URL query strings (it encodes a space). While axios's `params` serialization will percent-encode the `+` correctly, the Close query parser's handling of `%2B` vs `+` in the `query` field has not been verified. If Close normalizes the query before parsing, the `+` prefix on the phone number may be dropped, causing lookup mismatches.

**Fix:** Verify this behavior against the Close API in integration testing. As a defensive measure, test that a search for `+15551234567` returns the expected lead, and document the result in a comment.

---

_Reviewed: 2026-04-09_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
