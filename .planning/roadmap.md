# Roadmap: WhatsApp to Close CRM Integration

## Overview

Five phases build the system in strict dependency order: the PostgreSQL foundation and session manager come first because every other component depends on them, then the Close API client with phone cache, then the inbound sync pipeline that proves the full stack end-to-end, then outbound sync with the mandatory loop guard, and finally the web dashboard and REST API that surface everything built in phases 1-4. Each phase delivers a coherent, independently verifiable capability. Nothing can be safely reordered.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - PostgreSQL schema, auth state persistence, and SessionManager with correct reconnect logic (completed 2026-04-09)
- [ ] **Phase 2: Close API Client** - CloseApiClient with retry, PhoneCache with 1-hour TTL, and E.164 phone normalization
- [ ] **Phase 3: Inbound Sync** - WhatsApp messages flow into PostgreSQL and appear in Close lead timelines as native activities
- [ ] **Phase 4: Outbound Sync** - Close webhook triggers WhatsApp send with mandatory loop guard in place from day one
- [ ] **Phase 5: Dashboard and API** - Web dashboard, QR WebSocket streaming, and Bearer-authenticated REST API surface all prior work

## Phase Details

### Phase 1: Foundation
**Goal**: Sessions persist across server restarts and reconnect correctly without risking a ban
**Depends on**: Nothing (first phase)
**Requirements**: SESS-02, SESS-03, SESS-04
**Success Criteria** (what must be TRUE):
  1. Server restart does not require reps to re-scan QR codes — Baileys auth state loads from PostgreSQL on startup
  2. When a network drop or WhatsApp server restart occurs, the session automatically reconnects without manual intervention
  3. When a terminal disconnect reason occurs (loggedOut, badSession), the system stops reconnecting and marks the rep as needs-QR instead of looping
  4. All five schema tables (reps, messages, wa_auth_keys, wa_auth_creds, close_phone_cache) exist and accept writes
**Plans:** 2/2 plans complete

Plans:
- [x] 01-01-PLAN.md — PostgreSQL schema, config, pool, and usePgAuthState auth adapter
- [x] 01-02-PLAN.md — SessionManager with reconnect logic and application entry point

### Phase 2: Close API Client
**Goal**: Phone numbers resolve to Close leads reliably without exhausting the rate limit
**Depends on**: Phase 1
**Requirements**: SYNC-02
**Success Criteria** (what must be TRUE):
  1. A WhatsApp JID (e.g. 14155551234@s.whatsapp.net) resolves to the correct Close lead on first lookup — E.164 normalization working
  2. Repeated lookups within one hour hit the DB cache, not the Close API — confirmed by zero extra API calls on second lookup
  3. A Close API 429 response triggers a backoff retry rather than propagating an error
**Plans:** 2 plans

Plans:
- [ ] 02-01-PLAN.md — Install deps, Close API types, CloseApiClient with retry, and JID-to-E.164 normalizer
- [ ] 02-02-PLAN.md — PhoneCache with two-layer cache (in-memory + PostgreSQL, 1-hour TTL)

### Phase 3: Inbound Sync
**Goal**: Every inbound WhatsApp message from a known lead appears in their Close timeline as a native WhatsApp activity
**Depends on**: Phase 2
**Requirements**: SYNC-01, SYNC-03, SYNC-04, SYNC-05
**Success Criteria** (what must be TRUE):
  1. A text message sent to a rep's WhatsApp from a known lead's number appears in that lead's Close timeline within seconds as a native WhatsApp Message activity
  2. The same WhatsApp message ID delivered twice results in exactly one activity in Close — no duplicates
  3. A message from an unknown number is stored in PostgreSQL with lead_id NULL and does not attempt a Close API write
  4. An image or audio message with a caption has that caption text synced to Close as the activity body
**Plans**: TBD

### Phase 4: Outbound Sync
**Goal**: Reps can send WhatsApp messages from Close and the system never creates infinite send loops
**Depends on**: Phase 3
**Requirements**: OUT-01, OUT-02, OUT-03, DASH-05
**Success Criteria** (what must be TRUE):
  1. When a rep creates an outgoing WhatsApp Message activity in Close, the message is delivered to the customer's WhatsApp within seconds
  2. A webhook from Close for an activity the integration itself created is detected via external_whatsapp_message_id and silently dropped — no second send occurs
  3. The Close webhook endpoint is reachable and returns 200 for valid payloads
  4. After a successful outbound send, the Close activity is updated with the WhatsApp message ID and the message is stored in PostgreSQL
**Plans**: TBD

### Phase 5: Dashboard and API
**Goal**: Any team member can connect a rep's WhatsApp, view all connection statuses, and send a test message through a browser — with all endpoints protected
**Depends on**: Phase 4
**Requirements**: SESS-01, SESS-05, DASH-01, DASH-02, DASH-03, DASH-04
**Success Criteria** (what must be TRUE):
  1. Opening the dashboard shows every rep with their current status (connected / disconnected / needs-QR)
  2. Clicking to connect a rep shows a QR code modal with a live countdown timer — scanning it with the rep's phone connects the session
  3. A request to any API endpoint without a valid Bearer token returns 401
  4. The send message form in the dashboard delivers a WhatsApp message to a specified phone number via a chosen rep
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 2/2 | Complete    | 2026-04-09 |
| 2. Close API Client | 0/2 | Not started | - |
| 3. Inbound Sync | 0/? | Not started | - |
| 4. Outbound Sync | 0/? | Not started | - |
| 5. Dashboard and API | 0/? | Not started | - |
