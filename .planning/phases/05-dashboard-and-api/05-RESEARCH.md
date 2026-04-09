# Phase 5: Dashboard and API - Research

**Researched:** 2026-04-09
**Domain:** Express REST API + WebSocket + Single-file HTML dashboard (Node.js/TypeScript)
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Single HTML file served by Express — no React, no build step
- Dark theme dashboard, minimal CSS, no external CSS frameworks
- WebSocket for live QR code streaming — NOT polling
- QR code modal with live countdown timer for connecting reps
- All API endpoints protected with Bearer token authentication using DASHBOARD_PASSWORD env var
- Simple Bearer token auth — shared password for MVP, no role separation
- List all reps with connection status (connected / disconnected / needs-QR)
- QR code modal with live WebSocket streaming for connecting reps
- Send message form: pick rep, enter phone + message
- Add/remove rep controls
- ws library for WebSocket server
- QR code events streamed from SessionManager to dashboard
- qrcode library to generate QR code images

### Claude's Discretion
- Layout, specific CSS styling, and UX details are at Claude's discretion. Keep it functional and clean — dark theme, minimal.

### Deferred Ideas (OUT OF SCOPE)
- None.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SESS-01 | User can connect a rep's WhatsApp by scanning a QR code in the dashboard | WebSocket QR streaming + `sessionManager.connect(repId)` API endpoint |
| SESS-05 | Dashboard shows each rep's connection status (connected / disconnected / needs-QR) | `GET /api/reps` reads reps table; `status` events streamed via WebSocket |
| DASH-01 | Web dashboard lists all reps with connection status and management controls | Single HTML file served at `GET /` with rep list + add/remove buttons |
| DASH-02 | Dashboard provides a QR code modal with live WebSocket streaming for connecting reps | `wss` server on `/ws`, `qr` events → `qrcode.toDataURL` → JSON message to client |
| DASH-03 | Dashboard includes a send message form (pick rep, enter phone + message) | `POST /api/send` calls `sessionManager.getSession(repId)` + `sock.sendMessage()` |
| DASH-04 | All API endpoints are protected with Bearer token authentication | `Authorization: Bearer <DASHBOARD_PASSWORD>` checked in Express middleware |
</phase_requirements>

---

## Summary

Phase 5 adds the operator-facing dashboard and REST API on top of the existing Express app in `src/index.ts`. Every piece needed is already installed: `ws@8.20.0`, `qrcode@1.5.4`, `express@4.22.1`, and the `SessionManager` singleton which already emits `qr` and `status` events. The only structural change to `index.ts` is switching from `app.listen()` to an `http.createServer(app)` + `server.listen()` pattern so that a single HTTP server handles both REST and WebSocket upgrades.

The dashboard is a single HTML string returned by `GET /` — no separate build, no framework, no external CDN. All logic runs in a `<script>` block in that file: it opens a WebSocket connection for live QR and status updates, and makes `fetch()` calls for CRUD operations. The Bearer token is stored in `localStorage` and sent as the `Authorization` header on every API call.

The QR code flow is: dashboard POSTs to `POST /api/reps/:id/connect` → server calls `sessionManager.connect(repId)` → Baileys emits `qr` event → server calls `qrcode.toDataURL(qrString)` → server sends `{ type: 'qr', repId, dataUrl }` JSON over WebSocket to all connected clients → dashboard renders the `<img>` in a modal with a 20-second countdown (QR codes expire after ~20 seconds per WhatsApp spec). When the session connects, `sessionManager` emits `status` → server sends `{ type: 'status', repId, status: 'connected' }` over WebSocket → dashboard closes the modal.

**Primary recommendation:** Create `src/dashboard.ts` (WebSocket server + API routes) and `src/dashboard.html` (single-file UI), import and wire both into `src/index.ts`. Keep all new code in its own module to avoid polluting the main server file.

---

## Standard Stack

### Core (already installed — versions verified against node_modules)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| express | 4.22.1 | REST API routes + static HTML serve | Already in use [VERIFIED: node_modules] |
| ws | 8.20.0 | WebSocket server (QR + status streaming) | Already in package.json; `WebSocketServer` API stable [VERIFIED: node_modules] |
| qrcode | 1.5.4 | Convert raw Baileys QR string to PNG data URL | Already in package.json; `toDataURL()` returns Promise<string> [VERIFIED: node_modules] |
| http (Node built-in) | Node 22 | `http.createServer(app)` for ws upgrade | Required by ws noServer pattern [VERIFIED: runtime] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @types/ws | 8.18.1 | TypeScript types for ws | Already installed — use for WebSocket type annotations [VERIFIED: node_modules] |
| @types/qrcode | 1.5.5 | TypeScript types for qrcode | Already installed [VERIFIED: node_modules] |
| pino | 9.x | Structured logging in dashboard.ts | Already used across all modules — follow same pattern [VERIFIED: codebase] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ws noServer mode | socket.io | socket.io adds 200KB+ overhead and a client JS bundle; ws is already installed |
| qrcode.toDataURL (PNG data URL) | qrcode.toString (SVG/ASCII) | PNG renders correctly in `<img src>` without any parsing; simpler |
| Single HTML file with inline `<script>` | Separate JS file | Additional file means an extra route; constraints say single HTML file |
| Bearer token in Authorization header | Cookie session | Bearer token fits the API-first model; dashboard stores in localStorage |

**Installation:** Nothing to install — all dependencies already present in `package.json`.

---

## Architecture Patterns

### Recommended File Structure

```
src/
├── index.ts              # MODIFIED: app.listen() → server.listen(), import dashboard router
├── dashboard.ts          # NEW: WebSocket server + /api/* routes + /  HTML route
├── dashboard.html        # NEW: Single-file dark-theme dashboard
├── config.ts             # UNCHANGED: dashboardPassword already exported
├── whatsapp/
│   └── sessionManager.ts # UNCHANGED: emits 'qr' and 'status' events
└── db/
    └── pool.ts           # UNCHANGED: used in dashboard routes for rep CRUD
```

### Pattern 1: HTTP Server Upgrade for ws (noServer mode)

The existing `app.listen()` in `src/index.ts` must be replaced. ws requires access to the underlying `http.Server` to intercept the WebSocket upgrade handshake.

**What:** Create `http.Server` from Express app, attach `WebSocketServer` with `noServer: true`, then handle upgrade events.

**When to use:** Every time ws must coexist with an existing Express app on the same port.

**Example:**
```typescript
// Source: ws@8.x README, verified against installed node_modules
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// In index.ts main():
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  // Optional: check path — only upgrade /ws requests
  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.listen(config.port, () => {
  logger.info({ port: config.port }, 'Server started');
});
// REMOVE: app.listen(config.port, ...)
```

### Pattern 2: Bearer Token Middleware

A single Express middleware rejects requests without a valid Bearer token. Applied to all `/api/*` routes. The `/` dashboard HTML route and `/health` and `/webhook/close` are exempt.

```typescript
// Source: Express 4.x middleware pattern [VERIFIED: codebase patterns]
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';

export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token = auth.slice('Bearer '.length);
  if (token !== config.dashboardPassword) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
```

Apply to the API router, not globally (webhook and health must remain open):
```typescript
const apiRouter = express.Router();
apiRouter.use(requireBearer);
app.use('/api', apiRouter);
```

### Pattern 3: QR Event → WebSocket Broadcast

SessionManager emits `qr` events with `{ repId, qr }` where `qr` is the raw Baileys QR string. Convert to PNG data URL and broadcast to all connected WebSocket clients.

```typescript
// Source: verified qrcode API + ws@8.x API + SessionManager source
import toDataURL from 'qrcode';

sessionManager.on('qr', async ({ repId, qr }: { repId: string; qr: string }) => {
  try {
    const dataUrl = await toDataURL(qr); // returns 'data:image/png;base64,...'
    broadcast(wss, JSON.stringify({ type: 'qr', repId, dataUrl }));
  } catch (err) {
    logger.error({ repId, err }, 'Failed to generate QR data URL');
  }
});

sessionManager.on('status', ({ repId, status }: { repId: string; status: string }) => {
  broadcast(wss, JSON.stringify({ type: 'status', repId, status }));
});

function broadcast(wss: WebSocketServer, message: string): void {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
```

### Pattern 4: REST API Endpoints

All under `/api`, all protected by `requireBearer` middleware.

| Method | Path | Action | DB/Service |
|--------|------|--------|-----------|
| GET | /api/reps | List all reps with status | `SELECT id, name, close_user_id, wa_phone, status FROM reps ORDER BY name` |
| POST | /api/reps | Add new rep | `INSERT INTO reps (name, close_user_id, wa_phone) VALUES (...)` |
| DELETE | /api/reps/:id | Remove rep | `DELETE FROM reps WHERE id = $1` + `sessionManager.logout(id)` |
| POST | /api/reps/:id/connect | Trigger QR flow | `sessionManager.connect(repId)` |
| POST | /api/reps/:id/disconnect | Disconnect rep | `sessionManager.disconnect(repId)` |
| POST | /api/send | Send test message | `sessionManager.getSession(repId)` + `sock.sendMessage(jid, { text })` |

### Pattern 5: Send Message Route

Reuses `jidEncode` from Baileys (already used in `webhookHandler.ts`) to build the JID from a raw phone number.

```typescript
// Source: existing webhookHandler.ts pattern [VERIFIED: codebase]
import { jidEncode } from '@whiskeysockets/baileys';

apiRouter.post('/send', async (req, res) => {
  const { repId, phone, message } = req.body as { repId: string; phone: string; message: string };
  if (!repId || !phone || !message) {
    res.status(400).json({ error: 'repId, phone, and message are required' });
    return;
  }
  const sock = sessionManager.getSession(repId);
  if (!sock) {
    res.status(409).json({ error: 'Rep has no active session' });
    return;
  }
  const digits = phone.replace(/\D/g, '');
  if (!digits || digits.length < 7 || digits.length > 15) {
    res.status(400).json({ error: 'Invalid phone number' });
    return;
  }
  const jid = jidEncode(digits, 's.whatsapp.net');
  const result = await sock.sendMessage(jid, { text: message });
  res.json({ ok: true, messageId: result?.key?.id ?? null });
});
```

### Pattern 6: Single HTML File Served by Express

```typescript
// Source: Express 4.x sendFile / inline string pattern
import * as path from 'path';
// Option A: serve a file
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});
// Option B: inline HTML string (avoids __dirname issues in tsx watch)
// Use sendFile with relative-to-source path for simplicity
```

The HTML file connects to WebSocket at `ws://<host>/ws` and uses `fetch()` for all API calls, passing `Authorization: Bearer <token>` from localStorage.

### Anti-Patterns to Avoid

- **Using `app.listen()` after adding ws:** Once `http.createServer(app)` is used, `app.listen()` creates a second server on a different port. Replace it with `server.listen()`.
- **Attaching ws to Express port directly:** `new WebSocketServer({ server: app })` does not work — `app` is not an `http.Server`. Use `http.createServer(app)` first.
- **Polling for QR codes:** Constraints say WebSocket only. Polling creates race conditions with the 20-second QR expiry window.
- **Applying Bearer middleware globally:** `/webhook/close` must NOT require Bearer — it uses HMAC verification and is called by Close, not the dashboard.
- **Storing the Bearer token in a cookie:** Use `localStorage` + `Authorization` header. Cookie approach requires `express-session` which is not needed.
- **Broadcasting QR as raw string:** Always convert to `data:image/png;base64,...` on the server side. The browser cannot render a raw Baileys QR string.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| QR code image generation | Custom SVG renderer | `qrcode.toDataURL()` | Already installed; handles all QR encoding edge cases |
| WebSocket upgrade handling | Custom HTTP upgrade parser | `ws` noServer mode with `handleUpgrade` | Handles protocol negotiation, masking, ping/pong |
| Phone number → WhatsApp JID | Custom string formatter | `jidEncode()` from @whiskeysockets/baileys | Exact format WhatsApp expects; already used in webhookHandler.ts |

**Key insight:** All non-trivial pieces (WS, QR, JID encoding) are already installed and used elsewhere in the codebase. Phase 5 is primarily wiring and UI code.

---

## Common Pitfalls

### Pitfall 1: `app.listen()` vs `server.listen()` — Double Server

**What goes wrong:** Developer adds `http.createServer(app)` for ws but leaves `app.listen()` in place. Two servers start — one on the configured port (the http.Server with WS support) and one on a random port (Express's internal server). WebSocket upgrade never reaches the correct server.

**Why it happens:** `app.listen()` is convenient shorthand; its relationship to `http.createServer` is not obvious.

**How to avoid:** In `index.ts`, replace `app.listen(config.port, ...)` with `server.listen(config.port, ...)` as the ONLY call that starts listening.

**Warning signs:** WebSocket connections return 404 or connection refused; server starts on wrong port.

### Pitfall 2: QR Countdown Timer Mismatch

**What goes wrong:** Dashboard countdown is set to 30 seconds but WhatsApp QR codes expire after ~20 seconds. The modal stays open showing an expired QR code.

**Why it happens:** QR expiry is not documented prominently; developers guess 30 seconds.

**How to avoid:** Set countdown to 20 seconds. When Baileys generates a new QR (it will re-emit `qr` before the old one expires if still scanning), the dashboard updates the image and resets the timer.

**Warning signs:** Scan fails even though the QR looks valid; user has to click connect again.

### Pitfall 3: WebSocket Auth Gap

**What goes wrong:** REST endpoints require Bearer token, but the WebSocket endpoint at `/ws` is left unauthenticated. Anyone who knows the URL can subscribe to QR codes and status events.

**Why it happens:** WebSocket upgrade happens in `server.on('upgrade')`, not in Express middleware — Bearer middleware does not apply automatically.

**How to avoid:** In the `upgrade` handler, read `request.headers.authorization` (or parse a token from the URL query string, since browsers cannot set WS headers). The simplest pattern for a dashboard: pass `?token=<DASHBOARD_PASSWORD>` in the WebSocket URL from the browser and validate it in the `upgrade` handler.

**Warning signs:** No auth error when connecting to ws:// without a token.

### Pitfall 4: Deleting a Rep While Their Session Is Active

**What goes wrong:** `DELETE /api/reps/:id` removes the DB row but the Baileys socket stays open in `sessionManager.sessions`. The orphaned session receives messages that now fail DB writes (foreign key violation on `rep_id`).

**Why it happens:** DB delete and session teardown are handled separately.

**How to avoid:** Always call `sessionManager.logout(repId)` BEFORE the `DELETE FROM reps` query. `logout()` closes the socket, clears auth state, and handles its own DB cleanup (auth tables).

**Warning signs:** "foreign key constraint violation on rep_id" errors in logs after rep deletion.

### Pitfall 5: `sendFile` `__dirname` Issue with tsx watch

**What goes wrong:** `path.join(__dirname, 'dashboard.html')` resolves to `src/dashboard.html` in dev (tsx) but `dist/dashboard.html` in production (compiled JS). If `dashboard.html` is not copied to `dist/`, production breaks.

**Why it happens:** `tsc` only compiles `.ts` files — it does not copy `.html` assets.

**How to avoid:** Two options:
- Option A: Inline the HTML as a TypeScript template literal string — no file path needed.
- Option B: Copy `dashboard.html` to `dist/` in a `postbuild` npm script.

Option A is simpler for a single-file dashboard.

---

## Code Examples

### WebSocket Server Setup (complete, production pattern)

```typescript
// Source: ws@8.x noServer docs + verified against installed module
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

export function createWebSocketServer(
  server: http.Server,
  onConnection: (ws: WebSocket, req: IncomingMessage) => void,
  tokenValidator: (token: string) => boolean
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }
    // Auth: extract token from query string (browsers cannot set WS headers)
    const url = new URL(req.url, `http://localhost`);
    const token = url.searchParams.get('token') ?? '';
    if (!tokenValidator(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', onConnection);
  return wss;
}
```

### QR Code Generation (promise style, TypeScript-safe)

```typescript
// Source: qrcode@1.5.4 + @types/qrcode@1.5.5 [VERIFIED: node_modules]
import { toDataURL } from 'qrcode';

// Returns 'data:image/png;base64,...' ready for <img src=...>
const dataUrl: string = await toDataURL(rawQrString);
```

### Dashboard HTML WebSocket Client (key snippet)

```javascript
// Source: browser WebSocket API + localStorage auth pattern [ASSUMED]
const token = localStorage.getItem('token');
const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'qr') {
    // Update modal image
    document.getElementById('qr-img').src = msg.dataUrl;
    // Reset 20-second countdown
    startCountdown(20);
  }
  if (msg.type === 'status') {
    // Update rep card in the list
    updateRepStatus(msg.repId, msg.status);
  }
};
```

### Broadcast Helper

```typescript
// Source: ws@8.x documented pattern [VERIFIED: node_modules]
import { WebSocketServer, WebSocket } from 'ws';

function broadcast(wss: WebSocketServer, payload: object): void {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `ws.Server` constructor | `WebSocketServer` named export | ws v8.x | Import name changed; old `new ws.Server()` still works but `WebSocketServer` is the current canonical name [VERIFIED: node_modules] |
| `app.listen()` only | `http.createServer(app)` + `server.listen()` | Always required for ws coexistence | Must understand this to avoid double-server pitfall |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | WhatsApp QR code expiry is ~20 seconds | Common Pitfalls #2, Code Examples | Countdown timer set too short or too long; re-emit on expiry mitigates |
| A2 | Dashboard HTML inline as TS template literal is simpler than copying to dist/ | Pitfall #5 | If HTML grows large, inline becomes unwieldy; switch to postbuild copy |
| A3 | Browser localStorage is acceptable for MVP Bearer token storage | Code Examples | No XSS protection; acceptable for internal-only MVP tool |

---

## Open Questions

1. **QR auth flow: what happens when a rep is already connected and the operator clicks Connect?**
   - What we know: `sessionManager.connect()` closes the existing socket before opening a new one (line 29 of sessionManager.ts)
   - What's unclear: Should the API gate on current status, or always allow re-connect?
   - Recommendation: Always allow — the SessionManager already handles teardown safely.

2. **WebSocket token delivery: query string vs subprotocol header**
   - What we know: Browser `WebSocket` constructor does not support custom headers
   - What's unclear: Whether the simpler `?token=` query string approach is acceptable for this MVP
   - Recommendation: Use `?token=` — it's standard practice for auth-gated WebSocket endpoints in internal tools and the URL is only visible in server logs (which are trusted).

3. **Dashboard HTML delivery: inline TS string vs separate file**
   - What we know: tsx watch serves from `src/`, tsc compiles only `.ts` files
   - What's unclear: Project preference
   - Recommendation: Inline as a TS template literal string in `dashboard.ts` for Phase 5 MVP. This eliminates the dist/ copy problem entirely.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 5 has no external tool dependencies beyond the Node.js runtime and packages already installed. All required packages (`ws`, `qrcode`, `express`, `http`) are present in `node_modules`. No CLI utilities, databases, or services need to be installed.

---

## Validation Architecture

`workflow.nyquist_validation` is absent from `.planning/config.json` — treated as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | None detected — no jest.config, vitest.config, or test/ directory found |
| Config file | None — Wave 0 must create |
| Quick run command | `npm test` (after Wave 0 setup) |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SESS-01 | Connect triggers QR flow via POST /api/reps/:id/connect | smoke/manual | Manual: scan QR in browser | ❌ Wave 0 |
| SESS-05 | GET /api/reps returns status field per rep | unit/integration | `npm test -- --testPathPattern=dashboard` | ❌ Wave 0 |
| DASH-01 | GET / returns HTML with rep list | smoke | `curl http://localhost:3000/ -H 'Authorization: Bearer test'` | ❌ Wave 0 |
| DASH-02 | WebSocket /ws delivers QR event after connect | manual | Manual: open dashboard, click Connect | ❌ Wave 0 |
| DASH-03 | POST /api/send delivers message (requires live WA session) | manual | Manual: fill form in browser | ❌ Wave 0 |
| DASH-04 | All /api/* return 401 without Bearer token | unit | `npm test -- --testPathPattern=auth` | ❌ Wave 0 |

**Note:** DASH-04 (401 enforcement) is the only requirement that can be fully unit-tested without a live WhatsApp session. SESS-01, DASH-02, DASH-03 require manual browser validation against a real Baileys connection.

### Sampling Rate
- **Per task commit:** `npm run build` (TypeScript compilation — catches type errors)
- **Per wave merge:** Full suite if configured; otherwise `npm run build`
- **Phase gate:** `npm run build` clean + manual browser smoke test before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/dashboard.test.ts` — covers DASH-04 (Bearer auth 401 enforcement), SESS-05 (GET /api/reps shape)
- [ ] Test framework selection and install (jest + supertest, or vitest + supertest)
- [ ] `tests/setup.ts` — shared Express app factory for route testing

*(Recommendation: Given no test infrastructure exists and DASH-04 is the only pure-unit testable requirement, Wave 0 should install vitest + supertest and create one test file for auth middleware and the reps route. All other requirements validate manually.)*

---

## Security Domain

`security_enforcement` is absent from config — treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Bearer token checked via timing-safe comparison |
| V3 Session Management | No | Stateless Bearer tokens; no server-side session |
| V4 Access Control | Yes | All `/api/*` routes gated by `requireBearer` middleware |
| V5 Input Validation | Yes | `repId`, `phone`, `message` validated before use in Baileys/DB |
| V6 Cryptography | No | No new crypto — existing HMAC for webhook, no new secrets |

### Known Threat Patterns for Express + WebSocket Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Missing Bearer token on WS endpoint | Elevation of Privilege | Token check in `server.on('upgrade')` before `handleUpgrade` |
| Phone number injection into JID | Tampering | Strip non-digits + length check (already used in webhookHandler.ts) |
| Rep deletion without session teardown | Tampering | `sessionManager.logout()` before `DELETE FROM reps` |
| QR code visible to unauthenticated users | Info Disclosure | WS auth guard (Pitfall #3) |
| Timing attack on Bearer token comparison | Info Disclosure | Use `crypto.timingSafeEqual()` for token comparison, not `===` |

**Timing-safe Bearer comparison:**
```typescript
// Source: Node.js crypto docs [VERIFIED: Node built-in]
import { timingSafeEqual } from 'crypto';

function validateBearer(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
```

---

## Sources

### Primary (HIGH confidence)
- `node_modules/ws/package.json` + `node_modules/ws/` — ws@8.20.0 API: `WebSocketServer`, `noServer`, `handleUpgrade`, `WebSocket.OPEN`, `wss.clients` [VERIFIED: node_modules]
- `node_modules/qrcode/package.json` + `node_modules/@types/qrcode/index.d.ts` — qrcode@1.5.4 `toDataURL(text, options?): Promise<string>` [VERIFIED: node_modules]
- `node_modules/express/package.json` — express@4.22.1 [VERIFIED: node_modules]
- `src/whatsapp/sessionManager.ts` — event shapes: `qr: { repId, qr }`, `status: { repId, status }` [VERIFIED: codebase]
- `src/close/webhookHandler.ts` — `jidEncode` usage pattern for phone → JID [VERIFIED: codebase]
- `src/db/schema.ts` — `reps` table columns and status enum values [VERIFIED: codebase]
- `src/config.ts` — `dashboardPassword` already exported [VERIFIED: codebase]
- `src/index.ts` — existing `app.listen()` that must be converted [VERIFIED: codebase]

### Secondary (MEDIUM confidence)
- ws noServer pattern — WebSocket + Express integration via `http.createServer` + `server.on('upgrade')` [VERIFIED: runtime test]

### Tertiary (LOW confidence)
- WhatsApp QR code 20-second expiry [ASSUMED: training knowledge, standard WhatsApp behavior]
- `localStorage` for MVP Bearer token storage [ASSUMED: common internal tool pattern]

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified against installed node_modules
- Architecture: HIGH — existing codebase patterns observed, ws integration pattern verified at runtime
- Pitfalls: HIGH — most derived from verified codebase analysis; QR expiry timing is ASSUMED
- Security: HIGH — ASVS controls derived from existing project patterns (timingSafeEqual already used in webhookHandler)

**Research date:** 2026-04-09
**Valid until:** 2026-05-09 (30 days — stable stack, no fast-moving dependencies)
