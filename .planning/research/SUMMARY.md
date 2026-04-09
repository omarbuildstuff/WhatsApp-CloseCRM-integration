# Project Research Summary

**Project:** WhatsApp to Close CRM Integration
**Domain:** Multi-rep WhatsApp sync to CRM (self-hosted, Baileys-based)
**Researched:** 2026-04-09
**Confidence:** HIGH

## Executive Summary

This project is a self-hosted integration that connects multiple sales reps personal WhatsApp accounts to Close CRM, syncing conversations as native WhatsApp Message activities in both directions. The approach mirrors TimelinesAI architecture (Baileys/WA Web QR-code sessions, one socket per rep) but runs on owned infrastructure, eliminating per-seat SaaS costs. The entire stack is already bootstrapped: Node.js 20 + TypeScript 5.9 + Baileys 6.7.21 + Express 4 + pg + ws. The primary implementation work is wiring these libraries together correctly, not choosing technologies.

The recommended build order is strict and dependency-driven: PostgreSQL auth state layer first, then Close API client with phone cache, then Baileys session manager, then the sync engine, then REST API and WebSocket server, then the dashboard. This order is non-negotiable. Baileys auth state requires the DB layer; the sync engine requires both Baileys and Close client; the API layer requires the sync engine. Skipping or reordering phases produces a system that works locally but fails in production.

The two highest-risk areas are authentication persistence and the outbound webhook loop. Using useMultiFileAuthState (the Baileys built-in, filesystem-based store) guarantees session loss on every deploy and must never be used in production. The outbound infinite loop -- where a Close activity we create triggers a webhook that triggers another WhatsApp send -- is a wiring bug that must be addressed at the same time outbound sync is enabled, not after. Both risks are completely preventable with known patterns documented in the research.

## Key Findings

### Recommended Stack

The stack is already installed and locked. The only critical version decision is Baileys: stay on @whiskeysockets/baileys@6.7.21. The baileys npm package (different name, same codebase) points to 7.0.0-rc.9, which is ESM-only and has a confirmed 100% connection failure bug in RC.9. Do not migrate to v7 until it reaches stable and the project is ready for a full ESM conversion. Two libraries are missing: pino-http (structured HTTP logging middleware, compatible with installed pino@9) and dotenv (env var loading at startup).

**Core technologies:**
- @whiskeysockets/baileys@6.7.21: WhatsApp Web multi-device protocol -- only CJS-stable release; v7 RC has blocking auth bugs
- pg@8.20.x with Pool: PostgreSQL client for Neon.tech -- required for auth state persistence and message storage
- express@4.22.x: HTTP server and webhook handler -- stay on v4 for MVP; v5 has breaking route-syntax changes with no benefit here
- ws@8.20.x: WebSocket server for QR code streaming -- already a Baileys dependency, zero extra cost
- axios@1.15.x: Close API HTTP client -- interceptor support makes rate-limit retry logic ergonomic
- pino@9.14.x: Structured logging -- used internally by Baileys; consistent JSON format across all components

### Expected Features

The MVP must replace TimelinesAI for the team. All 13 table-stakes features are required for v1.0 launch; none can be deferred without the product feeling broken.

**Must have (table stakes -- v1.0):**
- QR code connection per rep with WebSocket streaming and 60s TTL handling
- PostgreSQL-backed Baileys auth state (survives container restarts and redeploys)
- Inbound WhatsApp message sync to Close as native WhatsApp Message activity
- Outbound message delivery from Close via webhook to Baileys send
- Outbound loop prevention via external_whatsapp_message_id check
- Lead matching with E.164 normalization and 1-hour phone number cache
- Message deduplication via UNIQUE constraint on WhatsApp message ID
- Automatic reconnection with correct terminal vs. retriable disconnect reason branching
- Basic media support (image, document, audio caption text)
- Connection status display per rep (connected / disconnected / needs-QR)
- Web dashboard: list reps, status badges, QR scan trigger
- REST API with Bearer token auth
- Store ALL messages in DB regardless of lead match status

**Should have (v1.x -- after core sync is stable):**
- Session health alerting (warn at 10 days phone offline, before 14-day expiry)
- Retroactive sync for unmatched messages (store now, sync when lead is created in Close)
- Message queue with retry and exponential backoff on Close API 429s
- Per-rep message attribution labels in Close activities

**Defer (v2+):**
- Conversation history backfill on first connection (high rate limit risk)
- Live message preview in dashboard (real-time WebSocket feed per rep)
- Role-based access control (admin vs. rep)
- Multi-channel dashboard aggregation

**Explicit anti-features (never build):**
- Group chat syncing -- JIDs end in @g.us; filter these out; no clean lead mapping possible
- WhatsApp broadcast/template campaigns -- requires Meta Cloud API, not WA Web; risks bans on personal numbers
- Auto-creation of Close leads from unknown numbers -- produces junk leads; store-and-match is correct
- Read receipt sync -- unreliable in multi-device; not worth the API write cost

### Architecture Approach

The system is a single-process Node.js monolith with a strict layered architecture: DB layer to Close API client to Baileys session manager to sync engine to REST/WS API to dashboard. Components communicate through EventEmitter (Baileys events to sync engine and WS server) and direct function calls (routes to session manager, sync engine to Close client). The SessionManager holds a Map of repId to WASocket and is the sole owner of Baileys socket references -- no route or handler ever touches a socket directly.

**Major components:**
1. SessionManager -- one Baileys socket per rep; lifecycle, reconnection, QR emission, PG auth state
2. CloseApiClient + PhoneCache -- all Close REST API calls; 1-hour TTL phone-to-lead cache wrapping all lookups
3. SyncEngine -- inbound WA message to DB to Close activity; outbound Close webhook to WA send; dedup and loop guard
4. Express REST API + WebSocket Server -- CRUD for reps, webhook receiver, Bearer auth, QR streaming
5. DB Layer -- pg Pool singleton, typed query helpers, schema (5 tables: reps, messages, wa_auth_keys, wa_auth_creds, close_phone_cache)

### Critical Pitfalls

1. **Filesystem auth state (useMultiFileAuthState)** -- never use in production; implement PostgreSQL-backed auth state using INSERT ... ON CONFLICT DO UPDATE for all Signal key writes from day one. Recovery cost if skipped: HIGH (every rep re-scans QR on every deploy).

2. **Infinite Close webhook loop** -- every Close activity we create triggers a webhook back to us. Check data.external_whatsapp_message_id at webhook entry; if set, return 200 immediately. Must be implemented before outbound sync is enabled. Recovery cost if triggered: MEDIUM (disable webhook, purge duplicates manually).

3. **Signal key race condition** -- rapid messages cause concurrent key writes; use upsert (not INSERT) for wa_auth_keys; serialize writes per rep. Symptom: intermittent decryption failures under message bursts.

4. **Phone number format mismatch** -- Baileys JIDs must be normalized to E.164 before Close lookup; Close contacts may be stored in any format. Use libphonenumber-js. Silent failure: messages stored in DB but never synced, lead_id always NULL.

5. **Reconnect loop on terminal disconnect** -- do NOT reconnect on loggedOut, badSession, forbidden, connectionReplaced, multideviceMismatch. Loop reconnects risk WhatsApp banning the reps number (often irreversible). Branch explicitly on DisconnectReason enum values.

6. **Close API rate limit cascade** -- at startup with multiple reps, parallel phone lookups exhaust the ~100 req/min limit in seconds. Three-layer defense: 1-hour phone cache, low-concurrency queue (max 2 parallel Close API calls), and rate_reset header backoff on 429.

## Implications for Roadmap

Based on research, the architecture dependency graph from ARCHITECTURE.md directly dictates the phase structure below. This is the only valid build order.

### Phase 1: Foundation -- Database, Auth State, and Session Management
**Rationale:** Everything else depends on this. Baileys auth state requires the DB layer. Correct reconnection logic must be in place before any rep connects. Highest failure cost if wrong.
**Delivers:** PostgreSQL schema (5 tables), pg Pool, typed query helpers, PostgreSQL-backed Baileys auth state, SessionManager with correct DisconnectReason branching, QR emission, and startup resumeAll().
**Addresses:** Session persistence, automatic reconnection, QR connection flow (backend)
**Avoids:** Filesystem auth state loss (Pitfall 1), Signal key race condition (Pitfall 3), reconnect loop ban risk (Pitfall 5), Neon idle connection timeout

### Phase 2: Close API Client and Lead Matching
**Rationale:** Required before any message sync can happen. Phone normalization and cache must exist before the sync engine is built on top of them.
**Delivers:** CloseApiClient (axios, Basic auth, retry on 429 with rate_reset), PhoneCache (1-hour TTL, DB-backed), E.164 phone normalization with libphonenumber-js.
**Addresses:** Lead matching, phone cache, rate limit handling
**Avoids:** Phone number format mismatch (Pitfall 4), Close API rate limit cascade (Pitfall 6)

### Phase 3: Inbound Sync -- WhatsApp to Close
**Rationale:** Core value delivery. Inbound sync is simpler than outbound (no loop risk) and proves the lead matching and auth state work end-to-end before adding outbound complexity.
**Delivers:** SyncEngine.handleInbound(), message parser (Baileys WAMessage to internal type), DB message storage (all messages, lead-matched or not), Close activity creation (direction: incoming), deduplication via UNIQUE constraint on WA message ID, basic media handling.
**Addresses:** Inbound message sync, message deduplication, store-all-messages, basic media support
**Avoids:** Calling Close phone lookup without cache (covered by Phase 2), duplicate activity creation

### Phase 4: Outbound Sync -- Close to WhatsApp
**Rationale:** Outbound requires inbound sync infrastructure and must include the loop guard from day one. Never enable outbound without the external_whatsapp_message_id check.
**Delivers:** SyncEngine.handleOutbound(), Close webhook receiver (POST /webhook/close), outbound loop guard (check external_whatsapp_message_id at entry), rep routing (lead to rep mapping), Baileys sock.sendMessage() call, activity update with WA message ID after send.
**Addresses:** Outbound message delivery from Close, outbound loop prevention
**Avoids:** Infinite webhook loop (Pitfall 2) -- this is the phase where it would be introduced if not handled

### Phase 5: REST API, WebSocket Server, and Dashboard
**Rationale:** The API and dashboard surface what Phases 1-4 built. WebSocket QR streaming requires the session manager from Phase 1; the webhook endpoint requires the sync engine from Phase 4.
**Delivers:** Express REST API routes (/api/reps, /api/send, /api/history), Bearer token auth middleware, WebSocket server (QR streaming + status events), single-file HTML dashboard (rep list, status badges, QR scan modal with countdown timer, unmatched contact count).
**Addresses:** Rep management dashboard, connection status display, REST API auth, QR code UX
**Avoids:** QR polling anti-pattern (use WebSocket push), missing QR expiry timer UX pitfall

### Phase 6: Hardening and Operational Monitoring
**Rationale:** The system works after Phase 5 but is not production-ready. This phase adds reliability and observability for live team use.
**Delivers:** Message queue with retry and exponential backoff for Close API writes, session health alerting (warn at 10-day phone-offline mark), pino-http request logging, graceful shutdown handler, Neon connection pool tuning (idleTimeoutMillis, connectionTimeoutMillis), Close webhook signature validation, Bearer token on WS upgrade.
**Addresses:** Session health alerting, message queue with retry, security hardening
**Avoids:** 14-day session expiry silent failure (Pitfall 7), unbounded in-memory queue memory leak, security mistakes (webhook validation, WS auth)

### Phase Ordering Rationale

- The dependency graph from ARCHITECTURE.md directly dictates phase order: DB to Close client to Baileys to Sync to API to Dashboard. No phase can be safely reordered.
- Inbound sync (Phase 3) comes before outbound (Phase 4) because inbound proves the core pipeline with lower risk. The loop guard Phase 4 requires makes no sense to build before the outbound path exists.
- Hardening (Phase 6) is last not because it is unimportant, but because the patterns to harden only become clear once the full happy path works end-to-end.
- PostgreSQL-backed auth state is the single most critical correctness requirement. Phase 1 being first is mandatory, not a preference.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1 (Auth State):** The custom usePgAuthState implementation requires study of Baileys internal Signal key store interface. The makeCacheableSignalKeyStore wrapper behavior and the exact key types Baileys 6.7.x writes need verification against source code before implementation.
- **Phase 4 (Outbound + Loop Guard):** The exact Close webhook payload structure for activity.whatsapp_message.created needs verification by inspecting a live webhook delivery. The external_whatsapp_message_id field presence is the loop guard core assumption -- confirm it is always present on integration-created activities.

Phases with standard patterns (skip research-phase):
- **Phase 2 (Close API Client):** Axios client with Basic auth and 429 retry is textbook. Close API docs are thorough. No research needed.
- **Phase 3 (Inbound Sync):** Data flow is fully documented in ARCHITECTURE.md. Baileys messages.upsert handling is well-understood.
- **Phase 5 (API + Dashboard):** Express REST API + raw ws WebSocket server is standard Node.js. Single-file HTML dashboard is intentionally simple.
- **Phase 6 (Hardening):** Exponential backoff, graceful shutdown, and connection pool tuning are established patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All packages verified against npm registry; version decisions based on confirmed bugs in Baileys v7 RC |
| Features | MEDIUM-HIGH | TimelinesAI/respond.io features confirmed via product pages; Close API behavior from official docs |
| Architecture | HIGH | Architecture is directly constrained by library APIs; limited design freedom means limited uncertainty |
| Pitfalls | HIGH | Baileys pitfalls confirmed via GitHub issues with exact issue numbers; Close rate limits via engineering blog |

**Overall confidence:** HIGH

### Gaps to Address

- **libphonenumber-js not yet installed:** Phone normalization requires this library. Add to Phase 2. Confirm it handles JID suffix stripping (@s.whatsapp.net removal) cleanly before building the normalization function.
- **Close webhook payload not verified live:** The external_whatsapp_message_id loop guard assumes Close includes this field on webhook payloads for activities the integration creates. Should be verified by subscribing to webhooks and inspecting the actual payload before Phase 4. Research is based on API docs; real payload may differ.
- **Rep-to-lead routing for outbound messages:** When Close sends a webhook for an outbound WhatsApp activity, the system must determine which reps Baileys socket to use. The mapping strategy is not yet defined -- either reps are explicitly assigned to leads in Close (via custom field or lead owner), or inferred from conversation history in the DB. Address during Phase 4 planning.
- **Neon.tech free tier connection limit:** The free tier supports 10 connections. With multiple Baileys sockets potentially triggering concurrent DB writes, pool exhaustion is possible. Confirm Neon PgBouncer is available on the free tier, or reduce pg pool size to 3-5.

## Sources

### Primary (HIGH confidence)
- npm registry @whiskeysockets/baileys -- version verification, v7 RC status confirmed
- Baileys wiki (baileys.wiki/docs) -- auth state interface, connection lifecycle, DisconnectReason enum
- WhiskeySockets/Baileys GitHub Issues -- confirmed RC.9 auth bug (#2090), reconnect issues (#1869, #1976, #2110, #1625, #2249)
- Close WhatsApp Message API (developer.close.com) -- external_whatsapp_message_id, direction, activity fields
- Close API Rate Limits (developer.close.com) -- confirmed ~100 req/min limit
- Close Webhooks (developer.close.com) -- payload structure, event types
- Neon.tech Node.js Connection Guide -- sslmode=require, Pool vs direct connections, connection pooling
- WhatsApp linked devices 14-day policy (WhatsApp Help Center) -- session expiry behavior
- Render.com free tier docs -- ephemeral filesystem confirmed

### Secondary (MEDIUM confidence)
- TimelinesAI homepage + Close CRM integration page -- feature comparison, QR-code connection model, 25MB media limit
- respond.io WhatsApp CRM guides -- feature landscape validation
- Rate Limiting at Close (engineering blog) -- rate limit cascade behavior
- BaileysAuth library (github.com/rzkytmgr/baileysauth) -- PostgreSQL auth state reference implementation pattern
- ookamiiixd/baileys-api -- multi-session REST API reference

### Tertiary (contextual reference)
- chatarchitect.com WA CRM best practices -- general sync patterns
- Waaku multi-session WA dashboard example -- dashboard architecture reference

---
*Research completed: 2026-04-09*
*Ready for roadmap: yes*