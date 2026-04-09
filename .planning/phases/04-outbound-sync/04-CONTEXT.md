# Phase 4: Outbound Sync - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning
**Mode:** Auto-generated (well-defined pipeline — discuss skipped)

<domain>
## Phase Boundary

Reps can send WhatsApp messages from Close and the system never creates infinite send loops. Close webhook triggers WhatsApp send with mandatory loop guard in place from day one.

</domain>

<decisions>
## Implementation Decisions

### Webhook & Loop Guard
- Close webhook handler must check for `external_whatsapp_message_id` to avoid infinite loops
- When our integration creates an inbound Close activity (Phase 3), it sets external_whatsapp_message_id
- When Close fires the webhook for that activity, we detect our own ID and silently drop it
- Outbound from Close: Listen for Close webhook on activity.whatsapp_message created, send via rep's Baileys session

### Rep Routing
- Must determine which rep's Baileys session to use for sending
- Close webhook payload includes the user who created the activity — map to rep

### Claude's Discretion
Implementation details for webhook parsing, rep-to-session routing, error handling, and the outbound message sending flow are at Claude's discretion. Follow established patterns from prior phases.

Key research flags from STATE.md:
- Close webhook payload structure for external_whatsapp_message_id needs live verification
- Rep-to-lead routing strategy for outbound not yet defined — address during planning

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- src/whatsapp/sessionManager.ts — SessionManager with per-rep sockets, connect/disconnect
- src/close/client.ts — CloseApiClient with postWhatsAppActivity and retry logic
- src/close/types.ts — WhatsAppActivityPayload, WhatsAppActivityResponse
- src/db/pool.ts — PostgreSQL pool
- src/index.ts — Express app, ready for new route

### Established Patterns
- Express routes on the app instance in index.ts
- Parameterized SQL, try/catch with pino logging
- Singleton exports

### Integration Points
- Express app in index.ts — add POST /webhook/close route
- SessionManager.sessions Map — access rep's Baileys socket to send messages
- messages table — store outbound messages with direction='outgoing'

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond ROADMAP success criteria.

</specifics>

<deferred>
## Deferred Ideas

None.

</deferred>
