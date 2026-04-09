# Pitfalls Research

**Domain:** Multi-rep WhatsApp ↔ Close CRM integration (Baileys + Node.js + PostgreSQL)
**Researched:** 2026-04-09
**Confidence:** HIGH (Baileys session/reconnection pitfalls confirmed via GitHub issues + official docs; Close API rate limit behavior confirmed via engineering blog; WhatsApp ban risk confirmed via multiple community reports)

---

## Critical Pitfalls

### Pitfall 1: Using `useMultiFileAuthState` in Production

**What goes wrong:**
Baileys ships with `useMultiFileAuthState`, a helper that saves credentials and Signal session keys to the local filesystem. On Render.com (and any container host), the filesystem is ephemeral — every deploy, crash, or scale-to-zero event wipes these files. Every rep loses their session and must re-scan a QR code.

**Why it happens:**
Developers copy the Baileys quickstart example verbatim. The example works locally, but the filesystem assumption breaks immediately in any hosted environment.

**How to avoid:**
Implement a custom auth state adapter backed by PostgreSQL from day one. The `authState.keys.set()` callback must write to the DB on every call — Signal protocol rotates keys on every message exchange, so any missed write causes decryption failures on restart. Reference the `useMultiFileAuthState` source as a structural template only; replace all `fs` calls with `pg` queries.

**Warning signs:**
- Reps report needing to re-scan QR codes after every deploy
- Logs show "bad session" or decryption errors after service restarts
- `creds.json` files appear in project root or `/tmp`

**Phase to address:**
Phase 1 — Database + Auth State layer. Must be correct before any rep connects.

---

### Pitfall 2: Infinite Loop Between Close Webhook and Activity Creation

**What goes wrong:**
When the integration creates an outbound WhatsApp Message activity in Close (rep sends a message from Close), Close fires an `activity.created` webhook back to the integration. The handler then tries to send that message again via Baileys — creating an infinite send loop that spams the recipient and burns through Close API rate limits.

**Why it happens:**
Webhook handlers that filter only on `activity_type == "WhatsApp"` without checking whether the activity originated from this integration will catch both human-initiated and self-created activities.

**How to avoid:**
The Close webhook handler must check for the presence of `external_whatsapp_message_id` on incoming activity events. Activities the integration creates will carry this field (set to the Baileys message ID). Activities created by a human clicking "Send" in Close will not have it initially — but the integration sets it, so any activity already having it means the integration owns it. Skip processing entirely if `external_whatsapp_message_id` is already set. Additionally, filter webhook subscriptions to only fire on `created` events where the activity source is not this integration.

**Warning signs:**
- Recipients report receiving the same message multiple times
- Close activity feed shows duplicate WhatsApp activities
- API rate limit 429 errors spike immediately after a rep sends a message

**Phase to address:**
Phase 3 — Outbound message flow (Close → WhatsApp). Must be implemented before outbound is enabled.

---

### Pitfall 3: Signal Key Persistence Race Condition

**What goes wrong:**
When two messages arrive for the same rep in rapid succession (common in active WhatsApp chats), the Signal key update from message 1 may not yet be committed to PostgreSQL before message 2 triggers another key rotation. If message 2's handler reads stale keys and overwrites the DB with them, message 1's key update is lost — causing decryption failures for subsequent messages in that session.

**Why it happens:**
Baileys' `authState.keys.set()` is called synchronously in the event handler, but if the database write is async and not awaited properly, concurrent handlers race each other on the same key rows.

**How to avoid:**
Use PostgreSQL `INSERT ... ON CONFLICT DO UPDATE` (upsert) for all Signal key writes — never plain INSERT or overwrite. Use a per-rep key-write mutex or serialize key writes through a single async queue. Test by sending 5 messages in rapid succession to a connected rep and verifying no decryption errors appear.

**Warning signs:**
- Intermittent "message could not be decrypted" errors
- Errors correlate with high-traffic periods, not quiet periods
- Problem disappears after rep re-scans QR (fresh key material)

**Phase to address:**
Phase 1 — Database + Auth State layer. The upsert pattern must be baked into the initial schema design.

---

### Pitfall 4: Phone Number Format Mismatch Causing Silent Lead Miss

**What goes wrong:**
Baileys delivers message sender IDs in WhatsApp JID format (e.g., `15551234567@s.whatsapp.net`). Close stores phone numbers in whatever format the sales team entered them — `+1 (555) 123-4567`, `555-123-4567`, `15551234567`, etc. A naive exact-match lookup against Close's contact search API fails silently: no lead match, no sync, no error. The rep thinks Close is broken; messages are stored in the DB but never appear in the CRM.

**Why it happens:**
Developers test with their own number, which they entered in Close in E.164 format (`+15551234567`). Everything works in testing. Production contacts were entered by sales reps in various ad-hoc formats.

**How to avoid:**
Normalize all phone numbers to E.164 before any Close API lookup. Strip the JID suffix from Baileys (`@s.whatsapp.net`, `@c.us`), then normalize by: removing all non-digit characters, prepending `+` and the country code if missing. Use the `libphonenumber-js` library for reliable normalization across international numbers. When querying Close, try both the normalized form and common variants (e.g., with and without leading `+`). Log every failed lookup with the raw JID so silent failures surface immediately.

**Warning signs:**
- Messages stored in `whatsapp_messages` table but never synced to Close
- `lead_id` column is consistently NULL for certain phone numbers
- Sales team reports "I can see texts on my phone but not in Close"

**Phase to address:**
Phase 2 — Lead matching + Close sync. Must be solved before sync goes live.

---

### Pitfall 5: Reconnect Loop on Permanent Disconnect Reasons

**What goes wrong:**
The naive reconnection pattern is: "on any `connection.update` with `connection === 'close'`, create a new socket." This causes infinite reconnect loops when the disconnect reason is terminal (loggedOut, badSession, forbidden, multideviceMismatch). The service hammers WhatsApp servers, triggering abuse detection, and the rep's number gets flagged or banned.

**Why it happens:**
The Baileys quickstart shows a single `shouldReconnect` boolean without explaining which `DisconnectReason` values are terminal.

**How to avoid:**
Branch explicitly on `DisconnectReason`:
- **Reconnect:** `connectionLost` (408), `timedOut` (408), `restartRequired` (515), `unavailableService` (503), `connectionClosed` (428)
- **Terminal — do NOT reconnect:** `loggedOut` (401), `badSession` (500), `forbidden` (403), `connectionReplaced` (440), `multideviceMismatch` (411)

For terminal reasons: mark the rep as `status = 'disconnected'` in the DB, delete stored credentials, surface a "re-authentication required" alert on the dashboard, and stop all reconnect attempts.

Use exponential backoff (start at 2s, cap at 60s) for reconnectable reasons. Add a maximum attempt counter (e.g., 10 attempts) before giving up and marking as disconnected.

**Warning signs:**
- Log line "creating new socket" appears hundreds of times per minute
- CPU spikes for a disconnected rep's session
- WhatsApp ban warning email or "account at risk" notification

**Phase to address:**
Phase 1 — Baileys connection management. The reconnect logic must be correct before any rep goes live.

---

### Pitfall 6: Close API Rate Limit Cascade During Bulk Backfill or Startup

**What goes wrong:**
On startup with multiple connected reps, or during a historical message backfill, the integration fires hundreds of Close API requests simultaneously — one `GET /api/v1/contact/?query=phone:...` per incoming message. The per-API-key rate limit is hit within seconds. Close returns 429 responses. The handler retries immediately, making the cascade worse. The integration becomes unresponsive for minutes while rate limits reset.

**Why it happens:**
Each incoming Baileys `messages.upsert` event triggers an independent async Close API call. With 5 reps each receiving 20 messages at startup, that is 100 simultaneous requests before any 429 is seen.

**How to avoid:**
Three-layer defense:
1. **Cache:** Phone number → lead_id cache with 1-hour TTL. Most messages come from the same known contacts; cache hit rate should exceed 90% in steady state.
2. **Queue:** Process Close API calls through a serial or low-concurrency (max 2 parallel) queue, not raw `Promise.all`.
3. **Backoff:** On 429 response, read the `rate_reset` header value (seconds to wait), sleep that duration, then retry. Never retry immediately.

The per-org Close rate limit is 3x the per-key limit, so using multiple API keys doesn't help much — the org limit is the real ceiling.

**Warning signs:**
- 429 errors in logs with increasing frequency
- `rate_reset` values growing longer (compounding backoff)
- Messages arrive in Close with multi-minute delays

**Phase to address:**
Phase 2 — Lead matching + Close sync. The cache and queue must be designed before sync goes live.

---

### Pitfall 7: WhatsApp 14-Day Session Expiry with No User Alert

**What goes wrong:**
A rep's phone goes offline (vacation, dead battery, SIM swap) for 14+ days. WhatsApp automatically logs out all linked devices. The Baileys session becomes invalid (`loggedOut` disconnect), but the integration marks the rep as disconnected silently. The rep assumes their WhatsApp integration is still running. Leads are messaging them and getting no reply visible in Close for two weeks.

**Why it happens:**
There is no proactive monitoring for session health beyond reacting to disconnect events. If the service itself also restarts during this window, the disconnect event may never be received and processed.

**How to avoid:**
Store `last_connected_at` per rep in the DB. Run a daily cron job that checks any rep whose `last_connected_at` is older than 12 days and sends a dashboard alert. On the dashboard, display session age prominently with a warning color for sessions older than 10 days. On any `loggedOut` disconnect, immediately email the rep (or ping a Slack/webhook) rather than just updating the DB silently.

**Warning signs:**
- Rep status shows `connected` but `last_message_received_at` is days old
- No messages appearing in Close for a rep who is normally active
- Dashboard shows rep as connected but Baileys is not firing any events

**Phase to address:**
Phase 4 — Dashboard + operational monitoring.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| `useMultiFileAuthState` for auth | Zero implementation effort | All sessions lost on every deploy/restart | Never — use DB-backed auth from day one |
| In-memory phone number cache (Map) | Simple, no DB | Lost on restart; all cache misses on startup flood Close API | Never in production — use DB-backed cache with TTL |
| Skipping phone number normalization | Faster initial build | Silent lead miss for any non-standard number format | Never — one missing normalization step breaks entire sync |
| Immediate retry on 429 | Simpler code | Cascading rate limit failures, service becomes unresponsive | Never — always honor `rate_reset` |
| Single shared Close API key | No multi-key complexity | Shared org rate limit still hit; no key-level isolation | Acceptable for MVP (< 10 reps), rotate before scaling |
| Polling for QR code status | No WebSocket complexity | Poor UX, rep refresh cycles, missed QR expiry | Never — WebSocket already in dependencies |
| Storing auth state in `/tmp` | Works locally | Ephemeral on all container hosts | Never in hosted deployment |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Baileys auth state | Calling `saveState()` only on graceful shutdown | Save `authState.keys` on every `set()` call — WhatsApp rotates keys on every message |
| Baileys message events | Processing `messages.upsert` for all messages including own sent messages | Filter `msg.key.fromMe === false` for inbound-only sync, or handle both directions explicitly |
| Close API activity creation | Creating activity with `direction: 'outgoing'` for inbound messages | Always check `msg.key.fromMe` to set direction; inbound = `incoming`, outbound = `outgoing` |
| Close API phone lookup | Searching by raw Baileys JID (`15551234567@s.whatsapp.net`) | Strip JID suffix, normalize to E.164 before any Close API call |
| Close webhook handler | Processing all `activity.created` webhook events | Skip events where `external_whatsapp_message_id` is already set — those are integration-owned |
| Neon.tech free tier | Not using the `?sslmode=require` connection string parameter | Always append `?sslmode=require`; Neon rejects plaintext connections |
| Neon.tech free tier | Long-lived idle connections timing out silently | Configure `pg.Pool` with `idleTimeoutMillis: 10000` and `connectionTimeoutMillis: 5000`; use pooled connection string via PgBouncer |
| Render.com free tier | Relying on local filesystem for anything persistent | All persistent data must go to PostgreSQL; free tier filesystem is wiped on every restart |
| Close API pagination | Assuming a single lead search response contains all matching contacts | Always paginate Close API responses; a lead can have multiple phone contacts |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| One Close API call per inbound message, no cache | 429 rate limit within minutes of startup; 5+ min message delay | Phone number → lead_id cache with 1-hour TTL, DB-backed | At 2+ active reps with normal message volume |
| Synchronous Close API calls blocking Baileys event handler | Messages queue up in memory; Baileys event buffer grows; eventual OOM | Process sync async; never block the Baileys event callback | At moderate message volume (10+ msgs/min) |
| Multiple Baileys sockets for the same rep (duplicate socket on reconnect) | Duplicate activity entries in Close; double message sends | Always call `socket.end()` on old socket before creating new one | Immediately on any reconnect if not handled |
| Unbounded in-memory message queue | Memory grows linearly with backlog; OOM crash on free tier (512MB) | Use DB as queue; process from DB, not memory | After 1 hour of high message volume |
| Loading all messages from DB on startup for "missed messages" | Startup time grows; can hit Neon connection timeout | Only backfill last N minutes; not full history on startup | After 1 week of messages in DB |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing Close API key in plaintext in DB or logs | Key compromise → attacker can read/write all CRM data | Store in environment variable only; mask in all log lines |
| Logging full WhatsApp message bodies | PII exposure in log aggregators; GDPR/privacy risk | Log message ID and sender only; never log message content |
| No webhook signature validation on Close webhook endpoint | Any caller can POST fake activities; SSRF via crafted payloads | Validate `X-Close-Signature` header or restrict to Close's IP ranges |
| Shared Bearer token in plain HTTP | Token sniffable on network | Enforce HTTPS only; rotate token periodically |
| Exposing the QR code WebSocket endpoint without auth | Any script can initiate a Baileys session for any rep | Require Bearer token on WS upgrade handshake, not just HTTP routes |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| QR code displayed with no expiry timer | Rep doesn't know QR expired (30s TTL); sits waiting; thinks page is broken | Show countdown timer; auto-refresh QR before expiry; clear "Scan within X seconds" label |
| Silent lead miss (message not synced, no feedback) | Rep has no idea their WhatsApp conversation isn't in Close | Show a "unmatched contacts" count on dashboard; log every miss with the phone number |
| No rep-level connection status on dashboard | Rep has to send a test message to find out they're disconnected | Real-time status badge per rep (Connected / Reconnecting / Disconnected / Needs QR) |
| Session disconnected overnight, rep discovers at 9am | First customer messages of the day missing from Close | Proactive dashboard alert + notification when session goes to disconnected state |
| Outbound message failed silently (Baileys send threw) | Rep thinks message sent; lead never received it | Catch and display Baileys send errors on the dashboard; don't swallow exceptions |

---

## "Looks Done But Isn't" Checklist

- [ ] **QR code flow:** The dashboard shows a QR — but does it handle QR expiry (30s), re-generation, and the `restartRequired` disconnect that fires immediately after scan? Verify: scan QR, wait 30s without scanning, verify new QR auto-appears.
- [ ] **Auth state persistence:** Sessions survive a `npm restart` — but do they survive a container redeploy with a fresh filesystem? Verify: deploy to Render, restart service, confirm rep does not need to re-scan.
- [ ] **Signal key persistence:** Messages decrypt after restart — but do they decrypt after 50 rapid-fire messages to the same rep? Verify: send burst of messages, restart server, confirm no "could not decrypt" errors.
- [ ] **Phone number normalization:** Works for your test number — but does it work for `+44 7700 900000`, `00447700900000`, `(555) 123-4567`? Verify with intentionally malformatted numbers in Close.
- [ ] **Rate limit handling:** Handles one 429 — but does it handle sustained 429s with correct `rate_reset` backoff? Verify by artificially throttling the Close API key.
- [ ] **Infinite loop prevention:** The `external_whatsapp_message_id` check is present — but what if Close doesn't return it on the webhook payload? Test by inspecting the actual Close webhook payload structure.
- [ ] **14-day session expiry:** The `loggedOut` disconnect is handled — but is the rep notified? Verify the dashboard status changes AND some alerting mechanism fires.
- [ ] **Outbound from Close:** Close sends webhook → Baileys sends message — but does the same Close activity then re-trigger the webhook? Verify by checking for duplicate activities after sending from Close.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Auth state stored on filesystem (lost on redeploy) | HIGH | Re-implement DB-backed auth state; every rep re-scans QR once; no historical data loss if messages were already in DB |
| Infinite webhook loop triggered | MEDIUM | Disable Close webhook subscription immediately; identify and delete duplicate activities via Close API; add `external_whatsapp_message_id` check before re-enabling |
| Signal key corruption (decryption failures) | MEDIUM | Delete rep's stored keys from DB; rep re-scans QR (fresh key exchange); no message loss, but historical messages pre-reset are unreadable |
| Phone number mismatch (messages not synced) | LOW | Add normalization function; backfill: re-process messages from DB with correct normalization; re-create missing Close activities |
| Rate limit cascade (service unresponsive) | LOW | Restart service; the in-flight queue is rebuilt from DB; add `rate_reset` backoff before restarting |
| Rep session expired (14-day offline) | LOW | Rep re-scans QR; session restored; no data loss |
| Reconnect loop triggering ban | HIGH | Immediately stop the service; contact WhatsApp support if number is banned (often irreversible); fix reconnect logic before restarting with a fresh number |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Filesystem auth state loss | Phase 1 — DB + Auth State | Deploy to Render, restart, confirm no re-scan needed |
| Signal key race condition | Phase 1 — DB + Auth State | Send 50 rapid messages, restart, check for decryption errors |
| Reconnect loop on terminal disconnect | Phase 1 — Connection management | Simulate `loggedOut` event, verify service stops reconnecting |
| Rate limit cascade | Phase 2 — Lead matching + sync | Run with rate-limited test key, verify backoff + cache hit rate |
| Phone number format mismatch | Phase 2 — Lead matching + sync | Test with 5 phone number formats, verify all match same lead |
| Infinite Close webhook loop | Phase 3 — Outbound flow | Send from Close, verify exactly 1 WhatsApp delivery, no duplicate activities |
| 14-day session expiry with no alert | Phase 4 — Dashboard + monitoring | Simulate stale session, verify dashboard shows warning |
| QR code expiry UX | Phase 4 — Dashboard + monitoring | Let QR expire, verify auto-refresh without page reload |
| WhatsApp ban from reconnect loop | Phase 1 — Connection management | Code review of all DisconnectReason branches before first rep connects |
| Neon idle connection timeout | Phase 1 — DB setup | Restart app after 5 minutes idle, verify first query succeeds |

---

## Sources

- [Baileys GitHub — High number of bans on WhatsApp #1869](https://github.com/WhiskeySockets/Baileys/issues/1869)
- [Baileys GitHub — Session not persisting, bad session error #1976](https://github.com/WhiskeySockets/Baileys/issues/1976)
- [Baileys GitHub — Reconnect establishes socket but WhatsApp rejects session #2110](https://github.com/WhiskeySockets/Baileys/issues/2110)
- [Baileys GitHub — Connection Timeout 428 after 24 hours #1625](https://github.com/WhiskeySockets/Baileys/issues/1625)
- [Baileys GitHub — Too many reconnect attempts: 428|close #2249](https://github.com/WhiskeySockets/Baileys/issues/2249)
- [Baileys DisconnectReason enumeration — baileys.wiki](https://baileys.wiki/docs/api/enumerations/DisconnectReason/)
- [Baileys Connecting docs — baileys.wiki](https://baileys.wiki/docs/socket/connecting/)
- [Rate Limiting at Close — engineering blog](https://making.close.com/posts/rate-limiting-at-close/)
- [Close API Rate Limits — developer.close.com](https://developer.close.com/topics/rate-limits/)
- [Close API Webhooks — developer.close.com](https://developer.close.com/topics/webhooks/)
- [Close API WhatsApp Message Activity — developer.close.com](https://developer.close.com/resources/activities/whatsappmessage/)
- [WhatsApp linked devices 14-day policy — WhatsApp Help Center](https://faq.whatsapp.com/378279804439436/?cms_platform=android)
- [Neon.tech connection pooling docs](https://neon.com/docs/connect/connection-pooling)
- [Neon.tech connection latency and timeouts](https://neon.com/docs/connect/connection-latency)
- [Render.com free tier docs — ephemeral filesystem](https://render.com/docs/free)
- [WhatsApp Automation Using Baileys.js — Pally Systems](https://blog.pallysystems.com/2025/12/04/whatsapp-automation-using-baileys-js-a-complete-guide/)

---
*Pitfalls research for: Multi-rep WhatsApp ↔ Close CRM integration (Baileys + Node.js + PostgreSQL)*
*Researched: 2026-04-09*
