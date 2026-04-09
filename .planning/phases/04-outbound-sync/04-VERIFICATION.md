---
phase: 04-outbound-sync
verified: 2026-04-09T00:00:00Z
status: human_needed
score: 4/4 must-haves verified
overrides_applied: 0
human_verification:
  - test: "End-to-end outbound send from Close UI"
    expected: "Creating a WhatsApp Message activity in Close for a lead with a connected rep triggers webhook, delivers the message to the customer's WhatsApp within seconds, and Close activity gains an external_whatsapp_message_id"
    why_human: "Requires a live Close webhook subscription, a connected Baileys session, and a real lead with a phone number — cannot be simulated with grep/static analysis"
  - test: "Infinite loop prevention"
    expected: "After the above send, the patched Close activity fires a second webhook — server logs show 'Loop guard: dropping webhook for our own activity' and no second sendMessage call occurs"
    why_human: "Requires observing two sequential webhook events from Close in a live environment"
  - test: "HMAC rejection for unsigned requests"
    expected: "curl -X POST http://localhost:3000/webhook/close -H 'Content-Type: application/json' -d '{\"test\":true}' returns HTTP 403 with body {\"error\":\"Invalid signature\"}"
    why_human: "Requires a running server — safe to test with a throwaway curl with no side effects"
---

# Phase 4: Outbound Sync Verification Report

**Phase Goal:** Reps can send WhatsApp messages from Close and the system never creates infinite send loops
**Verified:** 2026-04-09
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (from ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | When a rep creates an outgoing WhatsApp Message activity in Close, the message is delivered to the customer's WhatsApp within seconds | VERIFIED | `webhookHandler.ts` implements full pipeline: HMAC check -> loop guard -> direction filter -> early 200 -> rep routing (`reps WHERE close_user_id = $1 AND status = 'connected'`) -> phone resolution via `phoneCache.getLeadPhone()` -> `sock.sendMessage(jid, { text })` -> PostgreSQL persist -> `closeClient.updateWhatsAppActivity()` |
| 2 | A webhook from Close for an activity the integration itself created is detected via `external_whatsapp_message_id` and silently dropped — no second send occurs | VERIFIED | Line 107 of `webhookHandler.ts`: `if (data.external_whatsapp_message_id)` returns `200 { ok: true }` immediately — this check is Step 3, the first business logic after JSON parse, before any rep routing or sendMessage |
| 3 | The Close webhook endpoint is reachable and returns 200 for valid payloads | VERIFIED | `src/index.ts` lines 30-39 register `POST /webhook/close` with `express.raw({ type: 'application/json' })` at line 32; `app.use(express.json())` is at line 41 — correct ordering confirmed |
| 4 | After a successful outbound send, the Close activity is updated with the WhatsApp message ID and the message is stored in PostgreSQL | VERIFIED | Step 9: `INSERT INTO messages ... ON CONFLICT (id) DO NOTHING` at lines 185-190; Step 10: `closeClient.updateWhatsAppActivity(data.id, { external_whatsapp_message_id: waMessageId })` at lines 193-195 |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/close/webhookHandler.ts` | Complete outbound webhook handler with HMAC, loop guard, send, persist, patch | VERIFIED | 205 lines (exceeds 80-line minimum); exports `handleCloseWebhook`; all 10 pipeline steps implemented |
| `src/config.ts` | CLOSE_WEBHOOK_SECRET env var | VERIFIED | Line 22: `closeWebhookSecret: required('CLOSE_WEBHOOK_SECRET')` |
| `src/close/types.ts` | CloseWebhookPayload type | VERIFIED | Exports `CloseWebhookEvent`, `CloseWebhookActivityData`, `WhatsAppActivityUpdatePayload` |
| `src/close/client.ts` | updateWhatsAppActivity and getLeadContacts methods | VERIFIED | Both methods present at lines 74-100; `updateWhatsAppActivity` uses `PATCH` (correct REST semantics for partial update); `getLeadContacts` fetches `?_fields=contacts` and returns first phone |
| `src/index.ts` | Webhook route wired into Express | VERIFIED | `handleCloseWebhook` imported and registered at `POST /webhook/close` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/close/webhookHandler.ts` | `src/close/client.ts` | `closeClient.updateWhatsAppActivity` | WIRED | Line 193: `closeClient.updateWhatsAppActivity(data.id, ...)` — import confirmed at line 7 |
| `src/close/webhookHandler.ts` | `src/whatsapp/sessionManager.ts` | `sessionManager.getSession(repId)` | WIRED | Line 141: `sessionManager.getSession(repId)` — import confirmed at line 6 |
| `src/close/webhookHandler.ts` | `src/db/pool.ts` | `pool.query` for rep lookup and message insert | WIRED | Lines 131, 162, 185: three `pool.query` calls — import confirmed at line 5 |
| `src/index.ts` | `src/close/webhookHandler.ts` | import and route handler call | WIRED | Line 5: `import { handleCloseWebhook }`, line 34: `handleCloseWebhook(req, res)` |
| `src/index.ts` | `express.raw` | route-level middleware on /webhook/close | WIRED | Line 32: `express.raw({ type: 'application/json' })` registered before `express.json()` at line 41 |

**Note on `getLeadContacts` wiring:** The plan specified a direct key link from `webhookHandler.ts` to `client.ts` via `closeClient.getLeadContacts`. The actual implementation routes through `phoneCache.getLeadPhone()` (line 148), which internally calls `closeClient.getLeadContacts()` as its API fallback and adds a 1-hour in-memory + DB cache layer. This is a conforming deviation: CLAUDE.md mandates "Phone number lookups against Close API MUST use the 1-hour cache" — the phoneCache satisfies that requirement and is a stricter implementation of the same intent. `closeClient.getLeadContacts()` is still called; it is just intermediated by the cache.

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `webhookHandler.ts` | `rows` (rep lookup) | `pool.query` — `SELECT id FROM reps WHERE close_user_id = $1 AND status = 'connected'` | Yes — parameterized DB query | FLOWING |
| `webhookHandler.ts` | `phoneE164` | `phoneCache.getLeadPhone(data.lead_id)` → `closeClient.getLeadContacts()` → Close API `/lead/{id}/?_fields=contacts` | Yes — live API call with cache | FLOWING |
| `webhookHandler.ts` | `waMessageId` | `sock.sendMessage(jid, { text })` → `result?.key?.id` | Yes — Baileys real send result | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compiles without errors | `npx tsc --noEmit` | No output (exit 0) | PASS |
| npm run build succeeds | `npm run build` | Exit 0, no errors | PASS |
| `handleCloseWebhook` exported and importable | Module structure check | `export async function handleCloseWebhook` at line 53 | PASS |
| `timingSafeEqual` used (not string ===) | grep count | Found at lines 1 and 33 (2 occurrences) | PASS |
| `external_whatsapp_message_id` checked ≥2 times | grep count | Lines 67, 107, 109, 188, 194 (5 occurrences) | PASS |
| Webhook route before express.json() | Line number comparison | `express.raw` at line 32, `express.json()` at line 41 | PASS |
| Live end-to-end delivery | Requires running server + Close webhook | Not runnable statically | SKIP → human_needed |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| OUT-01 | 04-01, 04-02 | When a rep creates an outgoing WhatsApp activity in Close, the message is delivered to the customer's WhatsApp | SATISFIED | Full send pipeline in `webhookHandler.ts` Steps 6-10 |
| OUT-02 | 04-01, 04-02 | Webhook handler checks `external_whatsapp_message_id` to prevent infinite send loops | SATISFIED | Loop guard at line 107 — first business logic check after parse, returns 200 immediately |
| OUT-03 | 04-01 | Outbound messages stored in PostgreSQL and Close activity updated with WA message ID | SATISFIED | Step 9 INSERT at line 185, Step 10 `updateWhatsAppActivity` at line 193 |
| DASH-05 | 04-01, 04-02 | Close webhook endpoint receives and processes outbound message triggers | SATISFIED | `POST /webhook/close` wired in `index.ts` with HMAC verification and correct middleware ordering |

**Orphaned requirements check:** REQUIREMENTS.md maps OUT-01, OUT-02, OUT-03, DASH-05 to Phase 4. All four are claimed by the plans and verified above. No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/close/client.ts` | 62, 98 | `return null` | Info | Legitimate error fallbacks in try/catch — `findLeadByPhone` returns null for no-match (correct), `getLeadContacts` returns null on API failure (correct) |
| `src/close/webhookHandler.ts` | 177 | `const waMessageId = result?.key?.id ?? null` | Info | Null guard for undefined Baileys return — correctly handled: lines 179-182 check for null and log error before returning |

No blocker or warning anti-patterns found.

### Human Verification Required

#### 1. End-to-End Outbound Send

**Test:** With `CLOSE_WEBHOOK_SECRET` set, server running (`npm run dev`), a rep connected via Baileys, and a Close webhook subscription targeting `POST /webhook/close` for WhatsApp Message activity events:
1. In Close, find a lead with a phone number that matches the rep's WhatsApp contact
2. Create a new WhatsApp Message activity (outbound) for that lead
3. Observe server logs for webhook receipt and processing
4. Check the customer's WhatsApp for the delivered message

**Expected:** Message appears on the customer's WhatsApp within seconds. Server logs show: `'Outbound message sent and Close activity updated'` with `repId`, `waMessageId`, and `closeActivityId`.

**Why human:** Requires a live Close webhook subscription, connected Baileys session, and a real E.164 lead phone number. Cannot be simulated with static analysis.

#### 2. Infinite Loop Prevention

**Test:** Immediately after the above test, observe the second webhook Close fires when the activity is patched with `external_whatsapp_message_id`.

**Expected:** Server logs show `'Loop guard: dropping webhook for our own activity'` and no second `sendMessage` call. Customer does not receive a duplicate message.

**Why human:** Requires observing two sequential live webhook events from Close. The loop guard code is verified statically but behavioral correctness requires live observation.

#### 3. HMAC Rejection

**Test:** `curl -X POST http://localhost:3000/webhook/close -H "Content-Type: application/json" -d '{"test":true}'`

**Expected:** HTTP 403, body `{"error":"Invalid signature"}`

**Why human:** Requires a running server. This is a safe read-only test — no messages sent, no state changed.

### Gaps Summary

No gaps. All four ROADMAP success criteria are fully implemented and verified at the code level. The phase goal — "Reps can send WhatsApp messages from Close and the system never creates infinite send loops" — is achieved by the implementation. Three human verification items remain for behavioral confirmation in a live environment.

---

_Verified: 2026-04-09_
_Verifier: Claude (gsd-verifier)_
