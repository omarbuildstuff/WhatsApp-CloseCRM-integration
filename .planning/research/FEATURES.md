# Feature Research

**Domain:** WhatsApp CRM Integration (multi-rep, sales team, replaces TimelinesAI)
**Researched:** 2026-04-09
**Confidence:** MEDIUM-HIGH (TimelinesAI + respond.io features confirmed; Close API behavior from docs/community; Baileys lifecycle from official docs)

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist in any WhatsApp CRM integration. Missing these makes the product feel broken or incomplete, regardless of other value.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| QR code connection per rep | TimelinesAI does this; it's the standard Baileys/WA Web onboarding flow | LOW | Must show live QR in browser; WebSocket streaming required; 60s TTL before QR expires |
| Inbound message sync to Close | Core value of the product; every competitor does this | MEDIUM | Must use Close native WhatsApp Message activity type; must store message in DB first then sync |
| Outbound message send from Close | Reps expect to reply from Close and have it delivered via WhatsApp | MEDIUM | Close triggers webhook → system sends via Baileys; requires correct rep routing |
| Lead matching by phone number | Without this, messages can't be attached to a lead — product is useless | MEDIUM | Phone numbers in WhatsApp are E.164 (`+1234567890`); must normalize before lookup; must cache to avoid Close rate limits |
| Session persistence across restarts | Reps should not re-scan QR every time the server restarts | MEDIUM | Must persist Baileys auth state (creds + signal keys) in PostgreSQL, not filesystem |
| Connection status per rep | Reps and admins need to know if a rep's WhatsApp is connected or needs re-scan | LOW | Dashboard must show: connected / disconnected / needs-QR / expired states |
| Automatic reconnection | Transient drops (network, WA server restarts) must not require manual intervention | MEDIUM | Reconnect on: connectionClosed, connectionLost, timedOut, restartRequired; do NOT reconnect on loggedOut or badSession |
| Media message support (basic) | Sales teams send/receive images, docs, voice notes — text-only feels broken | MEDIUM | Images, documents, audio captions at minimum; store caption/filename; 25MB limit matches TimelinesAI |
| Outbound loop prevention | Without this, messages sent from Close would trigger Close webhook → WhatsApp → Close again infinitely | HIGH | Check `external_whatsapp_message_id` on incoming Close webhook; if present, the activity was system-created — skip it |
| Dashboard with rep management | Admins must be able to add/remove reps and see who is connected | MEDIUM | Single HTML file served by Express; no frontend build step; show name, phone, status, last-seen |
| REST API with authentication | Webhook endpoint and QR endpoint must not be publicly accessible without auth | LOW | Bearer token (shared secret) is adequate for MVP; all reps share same access level |
| Message deduplication | WhatsApp occasionally delivers the same event twice; Close must not have duplicate activities | MEDIUM | Store `external_whatsapp_message_id` in DB with UNIQUE constraint; skip if already exists |

### Differentiators (Competitive Advantage)

Features that set this self-hosted solution apart from TimelinesAI. These are not required for MVP but represent real value once the base is working.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Zero per-user cost | TimelinesAI charges $25-50/user/month (50 reps = $1,250-2,500/mo); self-hosted eliminates this | LOW (architectural choice, not a feature to build) | The cost advantage is inherent; mention in dashboard |
| Session health alerting | Proactively notify reps (via Close or email) before their session expires (14-day phone-offline rule) | MEDIUM | Track `lastSeen` in DB; warn at 10 days offline; WhatsApp itself also notifies on mobile but reps may miss it |
| Per-rep message attribution | Messages show which rep sent/received, giving team visibility without tool-switching | LOW | Already implied by multi-rep architecture; ensure `user_id` / rep name is stamped on each Close activity |
| Message queue with retry | Failed Close API writes retry automatically, no messages lost | MEDIUM | Exponential backoff on 429/5xx from Close; store pending sync state in DB |
| Conversation history backfill | On first connection, sync recent message history so Close timeline isn't empty | HIGH | Baileys can fetch recent messages on connect; risky with rate limits; defer to post-MVP |
| Unknown lead store + retroactive sync | Messages from non-leads are stored in DB; when that contact becomes a lead in Close, retroactively sync history | MEDIUM | Requires polling or webhook for new lead creation in Close; significant UX value for sales teams |
| Live message preview in dashboard | Dashboard shows recent messages per rep in real time | MEDIUM | WebSocket push to dashboard; useful for monitoring but not essential for core sync |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem valuable or are often requested but create disproportionate complexity or risk for this specific product.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Group chat syncing | Teams often use WhatsApp groups for deals | Group messages don't map cleanly to a single Close lead; multiple participants, no lead phone match; creates noisy CRM timelines | Explicitly document as unsupported; filter group JIDs in message handler (`jid.endsWith('@g.us')`) |
| WhatsApp template / broadcast campaigns | Mass outreach from CRM seems powerful | Requires WhatsApp Business API (not WA Web/Baileys); Baileys approach is personal number only; mixing personal and broadcast risks account bans | Use a separate tool (Wassenger, Whapi) for broadcast; this product is for 1:1 sync only |
| Read receipt sync back to Close | CRM would show when leads read messages | WhatsApp encrypts read receipts per-contact; Baileys delivers them but they're unreliable in multi-device; adds DB writes and Close API calls per message | Omit for MVP; add as opt-in later if requested |
| Role-based access control (admin vs rep) | Large teams want admins to manage reps without reps seeing config | Adds auth complexity (JWT, session management, role tables) to what is currently a shared-password MVP | Use shared Bearer token for MVP; add roles only if team size requires it |
| Auto-creation of new Close leads | New WhatsApp contact messages → auto-create lead in Close | Creates junk leads from wrong numbers, spam, and WA status messages; sales reps need to qualify leads | Store unmatched messages in DB; let reps manually create leads; retroactive sync is cleaner |
| End-to-end encryption of stored messages | Compliance-sensitive orgs want encrypted message bodies at rest | Adds key management complexity; Neon.tech free tier, Node.js — operational burden far exceeds MVP value | Use Neon.tech TLS in transit (`?sslmode=require`); document that stored messages are not encrypted at rest |
| Multi-number per rep | One rep connects multiple personal WhatsApp numbers | Adds N:M mapping complexity to lead lookup and message routing; edge case for MVP | One number per rep; if needed, add as a separate rep entry |
| Scheduled / delayed message sending | Send WhatsApp messages at a future time | Requires a job scheduler (Bull, BullMQ, cron) and careful state management; not part of the core sync flow | Reps can schedule from WhatsApp directly on their phone; CRM scheduling is future scope |

---

## Feature Dependencies

```
[PostgreSQL Session Store]
    └──required by──> [Session Persistence Across Restarts]
                          └──required by──> [Automatic Reconnection]
                          └──required by──> [Connection Status Display]

[Baileys WA Connection]
    └──required by──> [Inbound Message Sync]
    └──required by──> [Outbound Message Send]
    └──required by──> [QR Code Connection]

[Lead Matching (phone lookup)]
    └──required by──> [Inbound Message Sync to Close]
    └──required by──> [Outbound Loop Prevention]
    └──enhances──>    [Unknown Lead Store + Retroactive Sync]

[Message Deduplication (DB unique constraint)]
    └──required by──> [Inbound Message Sync] (idempotency)
    └──required by──> [Message Queue with Retry] (safe to retry)

[Outbound Loop Prevention (external_whatsapp_message_id check)]
    └──required by──> [Outbound Message Send from Close]
    NOTE: Close webhook fires on ALL activity creates, including ones we create.
          Must check this field BEFORE sending to WhatsApp.

[REST API + Auth]
    └──required by──> [Close Webhook Handler] (outbound trigger)
    └──required by──> [QR Code Endpoint]
    └──required by──> [Dashboard]

[Dashboard]
    └──enhances──> [Connection Status per Rep]
    └──enhances──> [QR Code Connection] (UI for scanning)

[Unknown Lead Store]
    └──enhances──> [Retroactive Sync] (v1.x feature)
    └──conflicts with──> [Auto-Create Close Leads] (anti-feature)
```

### Dependency Notes

- **Session Persistence requires PostgreSQL auth store:** Baileys' `useMultiFileAuthState` uses the filesystem and is not container-safe. Must implement custom `usePostgresAuthState` before any other Baileys features work reliably.
- **Lead Matching requires phone number normalization:** WhatsApp JIDs are like `15551234567@s.whatsapp.net`; Close stores numbers in various formats (`+1 555 123 4567`, `15551234567`, etc.). Normalization to E.164 is a prerequisite for reliable matching.
- **Outbound Loop Prevention requires Inbound Sync architecture:** The infinite loop is only possible once both directions are active. The `external_whatsapp_message_id` check must be in place before outbound sync is enabled.
- **Message Deduplication enables safe retry:** By storing `external_whatsapp_message_id` with a UNIQUE constraint, sync retries are idempotent — critical for the message queue retry pattern.

---

## MVP Definition

### Launch With (v1.0)

Minimum viable product — what's needed to replace TimelinesAI for the team.

- [ ] QR code connection per rep (WebSocket streaming, 60s TTL, auto-refresh)
- [ ] PostgreSQL auth state persistence (survives restarts, container-safe)
- [ ] Inbound message sync → Close native WhatsApp Message activity
- [ ] Outbound message delivery → WhatsApp via Close webhook trigger
- [ ] Outbound loop prevention via `external_whatsapp_message_id` check
- [ ] Lead matching with 1-hour phone number cache
- [ ] Message deduplication via DB UNIQUE constraint on WA message ID
- [ ] Automatic reconnection (except loggedOut/badSession)
- [ ] Basic media support (image, document, audio caption text)
- [ ] Connection status display per rep (connected / disconnected / needs-QR)
- [ ] Web dashboard: list reps, show status, trigger QR scan
- [ ] REST API with Bearer token auth
- [ ] Store ALL messages in DB regardless of lead match status

### Add After Validation (v1.x)

Features to add once core sync is stable and used by the team.

- [ ] Session health alerting — warn at 10 days phone offline; prevents surprise logouts
- [ ] Unknown lead retroactive sync — messages from non-leads stored in DB; sync when lead is created in Close
- [ ] Message queue with retry — handle Close API 429s gracefully without losing messages
- [ ] Per-rep message attribution labels — ensure rep name appears clearly on Close activity

### Future Consideration (v2+)

Features to defer until product-market fit with the self-hosted approach is confirmed.

- [ ] Conversation history backfill on first connection — high complexity, rate limit risk
- [ ] Live message preview in dashboard — WebSocket real-time feed per rep
- [ ] Role-based access control — admin vs rep separation
- [ ] Multi-channel dashboard (WhatsApp + SMS + Email activity aggregation)

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| QR code connection + session persistence | HIGH | MEDIUM | P1 |
| Inbound message sync to Close | HIGH | MEDIUM | P1 |
| Lead matching with phone cache | HIGH | MEDIUM | P1 |
| Outbound message via Close webhook | HIGH | MEDIUM | P1 |
| Outbound loop prevention | HIGH | LOW | P1 (safety, not UX) |
| Message deduplication | HIGH | LOW | P1 (correctness) |
| Automatic reconnection | HIGH | MEDIUM | P1 |
| Dashboard + rep management | MEDIUM | MEDIUM | P1 |
| Basic media support | MEDIUM | LOW | P1 |
| REST API auth | MEDIUM | LOW | P1 |
| Session health alerting | MEDIUM | MEDIUM | P2 |
| Retroactive sync for unmatched msgs | HIGH | HIGH | P2 |
| Message queue + retry | MEDIUM | MEDIUM | P2 |
| Conversation backfill on connect | LOW | HIGH | P3 |
| Role-based access control | LOW | HIGH | P3 |
| Live dashboard message preview | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for v1.0 launch (blocks replacing TimelinesAI)
- P2: Should have, add in v1.x once core is stable
- P3: Nice to have, consider in v2+

---

## Competitor Feature Analysis

| Feature | TimelinesAI | respond.io | Our Approach |
|---------|-------------|------------|--------------|
| Connection method | QR code (Baileys/WA Web) | Meta Business API | QR code (Baileys) — same as TimelinesAI, zero per-message cost |
| Multi-rep support | Yes, unlimited numbers | Yes, team inbox | Yes — one DB row + Baileys socket per rep |
| Inbound sync | Real-time to CRM | Real-time, omnichannel | Real-time via Baileys event → DB → Close API |
| Outbound send | From CRM or shared inbox | From respond.io inbox | From Close via webhook → Baileys socket |
| Lead matching | "Smart contact matching" with intl format intelligence | CRM integration pulls existing contacts | Phone normalization → Close `/contact/` search with cache |
| Session persistence | Cloud-managed (they handle it) | Cloud-managed | PostgreSQL auth state (custom Baileys store) |
| Media support | Images, docs, locations (25MB) | Full media (Meta API) | Images, documents, audio captions (Baileys limitations apply) |
| Loop prevention | Handled internally | Not applicable (different arch) | `external_whatsapp_message_id` check on Close webhook |
| Cost | $25-50/user/month | $79-249/month flat | Near-zero (hosting cost only) |
| Hosting | SaaS | SaaS | Self-hosted (Render.com) |
| Group chats | Supported | Supported | Explicitly excluded (v1.0) |
| Auto lead creation | Yes | Yes | No — store and match, no auto-create |

---

## Expected Sync Behavior (Canonical Descriptions)

These describe exactly what users expect to happen in each scenario. Useful for acceptance criteria in phase planning.

**Inbound message (lead messages rep on WA):**
1. Baileys receives `messages.upsert` event
2. Message stored in DB (regardless of lead match)
3. Phone number normalized → Close lead lookup (cache first)
4. If lead found → POST to Close `/activity/whatsapp_message/` with `direction: incoming`
5. Message appears as WA chat bubble in Close lead timeline within seconds

**Outbound message (rep sends from Close):**
1. Rep creates WA message activity in Close (or Close workflow sends one)
2. Close fires `activity.whatsapp_message.created` webhook to our endpoint
3. Handler checks: does payload have `external_whatsapp_message_id`? If YES → skip (we created it, loop prevention)
4. If NO → look up which rep owns this lead's WA conversation → send via that rep's Baileys socket
5. On send success → update Close activity with `external_whatsapp_message_id` from WA message ID

**Session expiry (rep's phone offline 14+ days):**
1. Baileys fires `connection.update` with `DisconnectReason.loggedOut`
2. System marks rep status as `needs_qr` in DB
3. Dashboard shows rep as disconnected + prompts re-scan
4. Rep scans QR → new auth state saved to PostgreSQL → session restored

**Unknown number messages:**
1. Inbound message arrives from number with no Close lead
2. Message stored in DB with `lead_id: null`, `synced: false`
3. No Close activity created
4. (v1.x) When lead is later created in Close with that phone number → retroactive sync fires

---

## Sources

- [TimelinesAI homepage — feature list](https://timelines.ai/)
- [TimelinesAI Close CRM integration page](https://timelines.ai/close-crm-whatsapp-integration/)
- [respond.io best WhatsApp CRM guide](https://respond.io/blog/best-whatsapp-crm)
- [respond.io WhatsApp CRM overview](https://respond.io/whatsapp-crm)
- [Baileys connection lifecycle docs](https://whiskeysockets-baileys-94.mintlify.app/concepts/connection)
- [Baileys wiki — connecting](https://baileys.wiki/docs/socket/connecting/)
- [Close API — WhatsApp Message activity](https://developer.close.com/resources/activities/whatsappmessage/)
- [Close API — webhooks](https://developer.close.com/topics/webhooks/)
- [chatarchitect.com — best practices for syncing WA messages with CRM](https://www.chatarchitect.com/news/best-practices-for-syncing-whatsapp-messages-with-crm)
- [chatarchitect.com — CRM integration with WhatsApp API and webhook logic](https://www.chatarchitect.com/news/crm-integration-with-whatsapp-api-and-webhook-logic-a-comprehensive-guide)
- [GetApp — TimelinesAI 2026 pricing and features](https://www.getapp.com/customer-management-software/a/timelinesai/)
- [Waaku — multi-session WA dashboard example](https://dev.to/ilhamsabir/waaku-manage-multiple-whatsapp-sessions-with-one-dashboard-1d54)

---

*Feature research for: WhatsApp ↔ Close.com CRM integration (multi-rep, self-hosted)*
*Researched: 2026-04-09*
