# Phase 3: Inbound Sync - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning
**Mode:** Auto-generated (well-defined pipeline — discuss skipped)

<domain>
## Phase Boundary

Every inbound WhatsApp message from a known lead appears in their Close timeline as a native WhatsApp activity. Messages from unknown numbers are stored in PostgreSQL but not synced to Close.

</domain>

<decisions>
## Implementation Decisions

### Message Handling
- Handle message types: text, image, document, audio, video, sticker, location, contact — extract text/caption from each
- Skip group chats (messages from @g.us JIDs), only sync 1:1 conversations
- All messages stored in PostgreSQL `messages` table regardless of lead match status
- Duplicate WhatsApp messages rejected via UNIQUE constraint on message ID (wa_message_id)

### Close API Integration
- Use native POST /activity/whatsapp_message/ endpoint for inbound messages
- Close WhatsApp Message API: https://developer.close.com/resources/activities/whatsappmessage/
- Only lead-matched messages get synced to Close as native WhatsApp activities
- Messages from unknown numbers stored with lead_id NULL, no Close API call

### Claude's Discretion
Implementation details for message extraction, error handling, and retry logic are at Claude's discretion. Follow established patterns from Phase 1 (SessionManager) and Phase 2 (CloseApiClient).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- src/whatsapp/sessionManager.ts — SessionManager with connect(), message event handling stub
- src/close/client.ts — CloseApiClient with retry logic
- src/close/phoneCache.ts — PhoneCache two-layer lookup
- src/close/normalizeJid.ts — normalizeJidToE164
- src/db/pool.ts — PostgreSQL pool singleton
- src/db/schema.ts — messages table already defined

### Established Patterns
- Singleton exports, parameterized SQL, try/catch with logging
- SessionManager emits events — message handler should hook into 'messages.upsert'

### Integration Points
- SessionManager.connect() registers message listener on Baileys socket
- PhoneCache.lookup(e164) returns LeadInfo | null
- messages table: wa_message_id (UNIQUE), rep_id, jid, direction, body, media_type, lead_id, close_activity_id, created_at

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond ROADMAP success criteria and user pre-answers above.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
