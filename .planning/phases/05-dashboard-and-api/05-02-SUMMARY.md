---
phase: "05-dashboard-and-api"
plan: "02"
subsystem: "dashboard"
tags: ["websocket", "qr-streaming", "real-time", "send-api", "dashboard"]
dependency_graph:
  requires: ["05-01"]
  provides: ["WebSocket QR streaming", "connect/disconnect API", "send message API", "live status updates"]
  affects: ["src/dashboard.ts", "src/dashboard.html", "src/index.ts"]
tech_stack:
  added: ["ws (WebSocketServer)", "qrcode (toDataURL)", "@whiskeysockets/baileys (jidEncode)"]
  patterns: ["noServer WebSocket upgrade handler", "timingSafeEqual token auth", "EventEmitter broadcast pattern", "in-place DOM status updates"]
key_files:
  created: []
  modified:
    - src/dashboard.ts
    - src/dashboard.html
    - src/index.ts
decisions:
  - "QR modal tracks activeQrRepId so multi-rep setups only show QR for the rep whose Connect was clicked"
  - "WebSocket upgrade handler uses timingSafeEqual on token from query string (T-05-06)"
  - "showQrModal called before API call so modal opens immediately; hideQrModal called on API error"
  - "Logout clears the WebSocket reference and sets token='' so the onclose reconnect guard stops"
metrics:
  duration_seconds: 143
  completed_date: "2026-04-09"
  tasks_completed: 3
  files_modified: 3
---

# Phase 05 Plan 02: WebSocket QR Streaming and Dashboard Completion Summary

**One-liner:** WebSocket server with timingSafeEqual token auth broadcasts live QR PNG data URLs and status events to dashboard; connect/disconnect/send routes complete the dashboard API.

## What Was Built

### Task 1: WebSocket server, QR/status broadcast, connect/disconnect/send API routes (commit 89c8fb2)

**`src/dashboard.ts`** — Added `setupWebSocket(server: http.Server)`:
- Creates `WebSocketServer({ noServer: true })`
- HTTP upgrade handler on `/ws` validates `?token=` query param via `timingSafeEqual` (T-05-06); invalid connections get `401 Unauthorized` and `socket.destroy()`
- `broadcast()` helper sends JSON to all `OPEN` WebSocket clients
- `sessionManager.on('qr')` converts raw Baileys QR string to PNG data URL via `toDataURL()` then broadcasts `{ type: 'qr', repId, dataUrl }`
- `sessionManager.on('status')` broadcasts `{ type: 'status', repId, status }` directly

Added to `apiRouter` inside `createDashboardRouter()`:
- `POST /api/reps/:id/connect` — calls `sessionManager.connect()`, triggers QR flow
- `POST /api/reps/:id/disconnect` — calls `sessionManager.disconnect()`
- `POST /api/send` — validates `repId/phone/message`, strips non-digits from phone, validates 7-15 digit length, builds JID via `jidEncode(digits, 's.whatsapp.net')`, sends via `sock.sendMessage()`

**`src/index.ts`** — Added `import { setupWebSocket }` and call `setupWebSocket(server)` between `http.createServer()` and `server.listen()`.

### Task 2: Wire QR modal, WebSocket client, and send form in dashboard HTML (commit 7182c3d)

**`src/dashboard.html`** — Added full WebSocket client and interactive JavaScript:
- `connectWebSocket()` — connects to `/ws?token=<token>`, handles `qr`/`status` messages, auto-reconnects after 3 seconds on close (token check prevents reconnect loop after logout)
- `handleQrEvent(repId, dataUrl)` — only updates modal if `repId === activeQrRepId`, sets `img.src`, calls `startCountdown(20)`
- `handleStatusEvent(repId, status)` — calls `updateRepStatus()` for live badge update; auto-closes QR modal with toast when status becomes `connected`
- `updateRepStatus(repId, status)` — in-place DOM update of status badge and action buttons without full list re-render
- `showQrModal(repId)` — sets `activeQrRepId`, opens modal with "Requesting QR code..." text
- `hideQrModal()` — clears `activeQrRepId`, removes `open` class, stops countdown
- `startCountdown(seconds)` — 20-second countdown that shows "Expired — waiting for new QR..." when done
- `showToast(message)` — fixed-position toast notification, auto-removes after 4 seconds
- Updated `connectRep()` — shows QR modal before API call; hides modal and shows toast on error
- Updated `disconnectRep()` — uses `showToast` instead of `alert` for errors
- Added `connectWebSocket()` call in both login path and DOMContentLoaded auto-login path
- Added `ws.close()` in `logout()` to prevent reconnect loop after logout

### Task 3: Verify dashboard end-to-end (auto-approved checkpoint)

Auto-approved checkpoint (autonomous mode). Build passes cleanly. All programmatic acceptance criteria verified.

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Minor Adjustments

**1. QR modal uses `classList.add('open')` pattern instead of `style.display = 'flex'`**
- Found during: Task 2
- Reason: The existing CSS in Plan 01 defined `#qr-modal.open { display: flex }` — the `classList` approach is already established and cleaner than overriding via inline style
- No functional difference; consistent with existing code

**2. `logout()` enhanced with WebSocket cleanup**
- Found during: Task 2
- Reason: Without clearing `ws = null` and closing the socket in logout, the `onclose` handler's `if (token)` check would still reconnect (token is cleared after close fires). Closing the socket explicitly before clearing token is belt-and-suspenders safety.

## Known Stubs

None — all UI elements are fully wired to live data.

## Threat Flags

All threats in the plan's threat register were mitigated:
- T-05-06: WebSocket `/ws` token validated via `timingSafeEqual` in upgrade handler
- T-05-07: Phone number stripped to digits, validated 7-15 chars before `jidEncode`
- T-05-08: QR broadcast only reaches authenticated WebSocket clients (upgrade gate)

No new threat surface introduced beyond what the plan's threat model covers.

## Self-Check: PASSED

Files verified:
- src/dashboard.ts — FOUND
- src/dashboard.html — FOUND
- src/index.ts — FOUND

Commits verified:
- 89c8fb2 feat(05-02): add WebSocket server... — FOUND
- 7182c3d feat(05-02): wire WebSocket client... — FOUND
