---
phase: 05-dashboard-and-api
plan: "01"
subsystem: dashboard-api
tags: [express, bearer-auth, rest-api, dashboard, html, http-server]
dependency_graph:
  requires: []
  provides: [dashboard-router, bearer-middleware, http-server-export]
  affects: [src/index.ts, src/dashboard.ts, src/dashboard.html]
tech_stack:
  added: []
  patterns: [timing-safe-bearer-auth, http-createserver-pattern, single-file-dashboard]
key_files:
  created:
    - src/dashboard.ts
    - src/dashboard.html
  modified:
    - src/index.ts
    - package.json
decisions:
  - "Use crypto.timingSafeEqual with length-mismatch guard for Bearer token comparison (T-05-01)"
  - "Mount dashboard router after express.json() to preserve webhook body ordering"
  - "Export http.Server from main() promise for Plan 02 WebSocket upgrade"
  - "postbuild script uses node -e copyFileSync for cross-platform dashboard.html copy"
metrics:
  duration: "~20 minutes"
  completed: "2026-04-09"
  tasks_completed: 2
  files_created: 2
  files_modified: 2
---

# Phase 5 Plan 01: REST API + Dashboard HTML Skeleton Summary

**One-liner:** Bearer-token-protected REST API for rep CRUD with timing-safe auth, dark-theme single-file dashboard, and http.createServer conversion ready for WebSocket upgrade.

## What Was Built

### Task 1: `src/dashboard.ts` — Bearer auth middleware and REST API routes

- `requireBearer` middleware uses `crypto.timingSafeEqual` with a length-mismatch guard (T-05-01: prevents timing side-channel attacks)
- `createDashboardRouter()` returns an Express Router with:
  - `GET /` — serves `dashboard.html` publicly (no auth required)
  - `GET /api/reps` — lists all reps from DB, ordered by name
  - `POST /api/reps` — creates rep with name validation and parameterized SQL (T-05-02)
  - `DELETE /api/reps/:id` — calls `sessionManager.logout(repId)` before DB delete (T-05-05)
- All `/api/*` routes protected via `apiRouter.use(requireBearer)`
- pino logger, try/catch on all handlers returning 500 on unexpected errors

### Task 2: `src/dashboard.html` + `src/index.ts` conversion

**dashboard.html:**
- Single-file dark-theme dashboard (background `#1a1a2e`, cards `#16213e`, accent `#0f3460`/`#e94560`)
- Login screen: password input → stores token in `localStorage`, validates against `GET /api/reps` with Bearer header
- Auto-login on page load if `localStorage` token exists
- Rep list: dynamic cards with status badges (green=connected, red=disconnected, yellow=needs_qr), Connect/Disconnect/Remove action buttons
- Add Rep form (hidden, toggled): Name (required), Close User ID (optional), WhatsApp Phone (optional)
- Send Message section (placeholder): rep dropdown, phone input, message textarea → `POST /api/send` (route added in Plan 02)
- QR Modal stubs: `showQrModal(repId)`, `hideQrModal()`, `startCountdown(seconds)` — wired by Plan 02 WebSocket events
- `apiFetch()` helper that auto-redirects to login on 401
- XSS-safe `escHtml()` for all dynamic content rendering

**src/index.ts:**
- Added `import * as http from 'http'` and `import { createDashboardRouter } from './dashboard'`
- Replaced `app.listen()` with `http.createServer(app)` + `server.listen()`
- Dashboard router mounted after `express.json()` — webhook ordering preserved (webhook before json middleware)
- `server` exported via `export const server = main()...` for Plan 02 WebSocket attachment

**package.json:**
- Added `"postbuild": "node -e \"require('fs').copyFileSync('src/dashboard.html','dist/dashboard.html')\""` for cross-platform compatibility

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | f852c92 | feat(05-01): add Bearer auth middleware and REST API routes in dashboard.ts |
| 2 | 1f5d38c | feat(05-01): add dashboard HTML, convert index.ts to http.createServer pattern |

## Verification Results

| Check | Result |
|-------|--------|
| `npm run build` | PASS — tsc + postbuild both succeed |
| `grep -c "timingSafeEqual" src/dashboard.ts` | 4 (>= 1) |
| `grep -c "createServer" src/index.ts` | 1 |
| `grep -c "server.listen" src/index.ts` | 1 |
| `grep -c "app.listen" src/index.ts` | 0 (removed) |
| `test -f src/dashboard.html` | PASS |
| `grep -c "qr-modal" src/dashboard.html` | 5 (>= 1) |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

| Stub | File | Reason |
|------|------|--------|
| `connectRep()` calls `POST /api/reps/:id/connect` | src/dashboard.html | Route added in Plan 02 (WebSocket + session management) |
| `disconnectRep()` calls `POST /api/reps/:id/disconnect` | src/dashboard.html | Route added in Plan 02 |
| `sendMessage()` calls `POST /api/send` | src/dashboard.html | Route added in Plan 02 |
| `showQrModal()` / `startCountdown()` function bodies | src/dashboard.html | WebSocket event wiring added in Plan 02 |

These stubs are intentional — Plan 02 wires the missing routes and WebSocket events. The dashboard's core goal (rep list display, add/remove, Bearer auth) is fully functional.

## Threat Surface

No new threat surface beyond what was planned in the threat model. All T-05-0x items mitigated as specified.

## Self-Check: PASSED

- [x] `src/dashboard.ts` exists: FOUND
- [x] `src/dashboard.html` exists: FOUND
- [x] Commit f852c92 exists: FOUND
- [x] Commit 1f5d38c exists: FOUND
- [x] `npm run build` succeeds: PASSED
- [x] `app.listen` removed from index.ts: CONFIRMED (count = 0)
