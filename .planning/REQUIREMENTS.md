# Requirements: WhatsApp ↔ Close.com CRM Integration

**Defined:** 2026-04-09
**Core Value:** Full WhatsApp conversation visibility in Close CRM lead timelines — replacing TimelinesAI at near-zero cost

## v1.0 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Session Management

- [ ] **SESS-01**: User can connect a rep's WhatsApp by scanning a QR code in the dashboard
- [ ] **SESS-02**: Baileys auth state persists in PostgreSQL so sessions survive server restarts
- [ ] **SESS-03**: System automatically reconnects on transient disconnects (network drops, WA server restarts)
- [ ] **SESS-04**: System stops reconnecting on terminal states (loggedOut, badSession) and marks rep as needs-QR
- [ ] **SESS-05**: Dashboard shows each rep's connection status (connected / disconnected / needs-QR)

### Inbound Sync

- [ ] **SYNC-01**: Inbound WhatsApp messages appear in the matched Close lead's timeline as native WhatsApp Message activities
- [ ] **SYNC-02**: Phone numbers are normalized to E.164 and looked up against Close contacts with a 1-hour cache
- [ ] **SYNC-03**: All WhatsApp messages are stored in PostgreSQL regardless of lead match status
- [ ] **SYNC-04**: Duplicate WhatsApp messages are rejected via UNIQUE constraint on message ID
- [ ] **SYNC-05**: Image, document, and audio message captions are synced to Close

### Outbound Sync

- [ ] **OUT-01**: When a rep creates an outgoing WhatsApp activity in Close, the message is delivered to the customer's WhatsApp
- [ ] **OUT-02**: The webhook handler checks `external_whatsapp_message_id` to prevent infinite send loops
- [ ] **OUT-03**: Outbound messages are stored in PostgreSQL and the Close activity is updated with the WhatsApp message ID

### Dashboard & API

- [ ] **DASH-01**: Web dashboard lists all reps with connection status and management controls
- [ ] **DASH-02**: Dashboard provides a QR code modal with live WebSocket streaming for connecting reps
- [ ] **DASH-03**: Dashboard includes a send message form (pick rep, enter phone + message)
- [ ] **DASH-04**: All API endpoints are protected with Bearer token authentication
- [ ] **DASH-05**: Close webhook endpoint receives and processes outbound message triggers

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Operational

- **OPS-01**: System alerts reps when their phone has been offline approaching 14 days (session expiry risk)
- **OPS-02**: Failed Close API writes retry automatically with exponential backoff
- **OPS-03**: Messages from non-leads retroactively sync when the contact becomes a lead in Close

### Enhanced Features

- **ENH-01**: Conversation history backfill on first rep connection
- **ENH-02**: Live message preview in dashboard via WebSocket
- **ENH-03**: Role-based access control (admin vs rep)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Group chat syncing | Group messages don't map to a single Close lead; creates noisy CRM timelines |
| WhatsApp template / broadcast campaigns | Requires WhatsApp Business API, not Baileys; mixing risks bans |
| Read receipt sync | Unreliable in multi-device; adds DB writes per message for low value |
| Auto-creation of Close leads | Creates junk leads from spam/wrong numbers; store and match instead |
| End-to-end encryption at rest | Operational burden exceeds MVP value; TLS in transit via Neon is sufficient |
| Multi-number per rep | Adds N:M mapping complexity; one number per rep for MVP |
| Scheduled / delayed messages | Requires job scheduler; reps can schedule from WhatsApp phone directly |
| Mobile app for dashboard | Web-only for MVP |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SESS-01 | — | Pending |
| SESS-02 | — | Pending |
| SESS-03 | — | Pending |
| SESS-04 | — | Pending |
| SESS-05 | — | Pending |
| SYNC-01 | — | Pending |
| SYNC-02 | — | Pending |
| SYNC-03 | — | Pending |
| SYNC-04 | — | Pending |
| SYNC-05 | — | Pending |
| OUT-01 | — | Pending |
| OUT-02 | — | Pending |
| OUT-03 | — | Pending |
| DASH-01 | — | Pending |
| DASH-02 | — | Pending |
| DASH-03 | — | Pending |
| DASH-04 | — | Pending |
| DASH-05 | — | Pending |

**Coverage:**
- v1.0 requirements: 15 total
- Mapped to phases: 0
- Unmapped: 15

---
*Requirements defined: 2026-04-09*
*Last updated: 2026-04-09 after initial definition*
