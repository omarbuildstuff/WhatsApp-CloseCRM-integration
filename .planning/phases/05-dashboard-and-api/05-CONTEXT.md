# Phase 5: Dashboard and API - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning
**Mode:** Auto-generated (well-defined UI phase — discuss skipped)

<domain>
## Phase Boundary

Any team member can connect a rep's WhatsApp, view all connection statuses, and send a test message through a browser — with all endpoints protected by Bearer token auth.

</domain>

<decisions>
## Implementation Decisions

### Dashboard Design
- Single HTML file served by Express — no React, no build step
- Dark theme dashboard, minimal CSS, no external CSS frameworks
- WebSocket for live QR code streaming — NOT polling
- QR code modal with live countdown timer for connecting reps

### REST API
- All API endpoints protected with Bearer token authentication using DASHBOARD_PASSWORD env var
- Simple Bearer token auth — shared password for MVP, no role separation

### Dashboard Features
- List all reps with connection status (connected / disconnected / needs-QR)
- QR code modal with live WebSocket streaming for connecting reps
- Send message form: pick rep, enter phone + message
- Add/remove rep controls

### WebSocket
- ws library for WebSocket server
- QR code events streamed from SessionManager to dashboard
- qrcode library to generate QR code images

### Claude's Discretion
Layout, specific CSS styling, and UX details are at Claude's discretion. Keep it functional and clean — dark theme, minimal.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- src/index.ts — Express app with health endpoint, ready for routes
- src/config.ts — has dashboardPassword, port
- src/whatsapp/sessionManager.ts — SessionManager with connect/disconnect/logout, emits events
- src/db/pool.ts — PostgreSQL pool for rep queries
- ws, qrcode already in package.json dependencies

### Established Patterns
- Express routes in index.ts
- Bearer token from DASHBOARD_PASSWORD env var
- SessionManager is singleton, emits 'qr' events during connect

### Integration Points
- Express app — add REST routes for reps, send message
- SessionManager — connect(repId) triggers QR flow, emits 'qr' event
- WebSocket server — upgrade from Express HTTP server
- reps table — CRUD for rep management

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond user pre-answers and ROADMAP success criteria.

</specifics>

<deferred>
## Deferred Ideas

None.

</deferred>
