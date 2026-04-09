---
phase: 03-inbound-sync
reviewed: 2026-04-09T00:00:00Z
depth: standard
files_reviewed: 4
files_reviewed_list:
  - src/whatsapp/messageHandler.ts
  - src/close/client.ts
  - src/close/types.ts
  - src/index.ts
findings:
  critical: 2
  warning: 3
  info: 2
  total: 7
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-04-09
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Reviewed the four core inbound-sync source files: the WhatsApp message handler, the Close API client, the Close type definitions, and the application entry point. The pipeline architecture (filter → extract → lookup → persist → sync) is sound and the dedup/idempotency guard via `ON CONFLICT (id) DO NOTHING` is correct. Two critical issues were found: a protobuf `Long` type truncation bug that will produce `NaN` timestamps and crash the DB insert, and a missing `date` field in the Close activity payload that causes all synced activities to show the server-receipt time rather than the actual message time. Three warnings cover a duplicate-activity race on failed DB updates, a `Retry-After` header parsing gap in the HTTP client, and a false-safety `.catch()` that never fires.

---

## Critical Issues

### CR-01: `messageTimestamp` is a protobuf `Long` — `Number()` conversion produces `NaN`

**File:** `src/whatsapp/messageHandler.ts:79`

**Issue:** `msg.messageTimestamp` is typed as `number | Long | null | undefined` in the Baileys protobuf schema. When the field is a `Long` object (the common case for 64-bit timestamps), `Number(longValue)` returns `NaN` — not the numeric seconds value. `new Date(NaN * 1000)` produces an invalid `Date`, which PostgreSQL will reject at the `INSERT` on line 88 with a runtime error, causing every real inbound message to throw and be swallowed by the outer catch. The handler would silently drop every message.

**Fix:**
```typescript
// Replace line 79:
const tsSec = msg.messageTimestamp
  ? (typeof msg.messageTimestamp === 'number'
      ? msg.messageTimestamp
      : msg.messageTimestamp.toNumber())   // Long has .toNumber()
  : 0;
const timestamp = new Date(tsSec * 1000);
```

---

### CR-02: Close activity timestamp is always "now" — message time is not forwarded

**File:** `src/whatsapp/messageHandler.ts:97-102` and `src/close/types.ts:34-39`

**Issue:** The Close WhatsApp Message API accepts a `date` field (ISO 8601) to set the canonical activity timestamp. `WhatsAppActivityPayload` does not include this field, and `postWhatsAppActivity` never passes it. Every synced activity is timestamped to the moment the server processes it, not when the WhatsApp message was actually sent. For any delayed delivery, bulk import, or history restore, the Close timeline is wrong. This also violates the stated requirement that messages are synced as native WhatsApp activities (which implies faithful timestamps).

**Fix — step 1, add field to type:**
```typescript
// src/close/types.ts — WhatsAppActivityPayload
export interface WhatsAppActivityPayload {
  lead_id: string;
  direction: 'inbound' | 'outbound';
  external_whatsapp_message_id: string;
  message_markdown: string;
  date?: string;   // ISO 8601 — activity timestamp in Close
}
```

**Fix — step 2, pass the timestamp:**
```typescript
// src/whatsapp/messageHandler.ts — inside postWhatsAppActivity call
const activityId = await closeClient.postWhatsAppActivity({
  lead_id: lead.leadId,
  direction: 'inbound',
  external_whatsapp_message_id: waMessageId,
  message_markdown: body ?? '',
  date: timestamp.toISOString(),   // forward actual message time
});
```

---

## Warnings

### WR-01: Duplicate Close activity possible when `UPDATE messages SET close_activity_id` fails

**File:** `src/whatsapp/messageHandler.ts:103-108`

**Issue:** The activity is posted to Close (line 97) before the local DB is updated with `close_activity_id` (line 104). If the `UPDATE` fails (transient DB error), the outer `catch` logs and exits. On the next delivery of the same message, `ON CONFLICT (id) DO NOTHING` sets `rowCount = 0`, so `inserted = false`, and the Close sync is skipped — correctly. However, if the *original* DB `INSERT` (line 87) succeeded but the `UPDATE` did not, the `close_activity_id` column remains `NULL` for a message that *did* get posted to Close. There is no retry path for the update, and no way to detect the half-committed state. A future manual re-sync or debugging effort would incorrectly treat the message as unsynced.

The fix is to wrap both the activity post and the `close_activity_id` update in a single logical unit, or at minimum log a distinct warning so the orphaned state is observable:

```typescript
if (activityId) {
  try {
    await pool.query(
      'UPDATE messages SET close_activity_id = $1 WHERE id = $2',
      [activityId, waMessageId]
    );
  } catch (updateErr) {
    // Activity IS in Close but our DB record does not reflect it.
    // Log at error level with both IDs so ops can reconcile.
    logger.error(
      { repId, waMessageId, activityId, err: updateErr },
      'Close activity posted but DB close_activity_id update failed — manual reconciliation required'
    );
  }
}
```

---

### WR-02: `Retry-After` header parsed with `parseFloat` — silently breaks for date-format values

**File:** `src/close/client.ts:23`

**Issue:** The HTTP `Retry-After` header can be either a delay-seconds integer (`"30"`) or an HTTP-date string (`"Thu, 10 Apr 2026 01:00:00 GMT"`). `parseFloat("Thu, 10 ...")` returns `NaN`. `setTimeout(fn, NaN)` fires immediately (treated as 0 ms delay), defeating the rate-limit back-off entirely. This would cause the retry loop to hammer the Close API with no delay on 429 responses that use date-format headers.

**Fix:**
```typescript
retryDelay: (retryCount, err) => {
  const retryAfter = err.response?.headers?.['retry-after'];
  if (retryAfter) {
    const seconds = parseFloat(retryAfter);
    if (!isNaN(seconds)) return seconds * 1000;
    // HTTP-date format fallback
    const targetMs = Date.parse(retryAfter);
    if (!isNaN(targetMs)) return Math.max(0, targetMs - Date.now());
  }
  return axiosRetry.exponentialDelay(retryCount);
},
```

---

### WR-03: Inner `try/catch` in `handle()` swallows all errors — outer `.catch()` in `index.ts` never fires

**File:** `src/index.ts:21-23` cross-referencing `src/whatsapp/messageHandler.ts:110-112`

**Issue:** `MessageHandler.handle()` wraps the entire async body in a `try/catch` that logs and returns `undefined` on any error. The `.catch()` attached in `index.ts` line 21 therefore never receives any rejection. This is not a crash risk, but it means any future refactor that removes the inner catch (or any error thrown in the filter chain before line 82) would silently vanish rather than surface to the outer handler. The code comment in `index.ts` implies the `.catch()` is a safety net, but it provides no actual protection today.

**Fix:** Either remove the redundant outer `.catch()` and rely solely on the inner handler, or narrow the inner `try/catch` to cover only Steps 3-5 (the async operations) so errors in extraction would propagate naturally:

```typescript
// index.ts — document the behavior clearly
sessionManager.on('message', ({ repId, msg }) => {
  // handle() catches and logs all processing errors internally
  void messageHandler.handle(repId, msg);
});
```

---

## Info

### IN-01: `body ?? ''` sends empty `message_markdown` to Close for future unrecognised message types

**File:** `src/whatsapp/messageHandler.ts:101`

**Issue:** `extractBody` returns `null` for unrecognised message types. The fallback `body ?? ''` sends an empty string to Close. Current known types all return non-null (text, image, video, audio return placeholders), so this does not trigger today. But as WhatsApp adds new message types, Close activities with blank body would be created without any indication of what the original message was. Consider a consistent placeholder:

```typescript
message_markdown: body ?? '[Unsupported message type]',
```

---

### IN-02: `app.listen` return value is not retained — no graceful shutdown path

**File:** `src/index.ts:35`

**Issue:** The `http.Server` returned by `app.listen()` is discarded. There is no `SIGTERM`/`SIGINT` handler to drain in-flight requests, close the DB pool, or tear down active Baileys sockets cleanly. For a container environment (Neon.tech + Docker), abrupt termination can leave DB connections open until server-side timeout. This is expected to be addressed in a later phase, but the hook point should be wired now:

```typescript
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'Server started');
});

process.on('SIGTERM', async () => {
  server.close();
  await pool.end();
  process.exit(0);
});
```

---

_Reviewed: 2026-04-09_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
