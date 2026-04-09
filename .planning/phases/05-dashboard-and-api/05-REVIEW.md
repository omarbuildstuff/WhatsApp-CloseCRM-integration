---
phase: 05-dashboard-and-api
reviewed: 2026-04-09T00:00:00Z
depth: standard
files_reviewed: 4
files_reviewed_list:
  - src/dashboard.ts
  - src/dashboard.html
  - src/index.ts
  - src/config.ts
findings:
  critical: 1
  warning: 5
  info: 2
  total: 8
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-04-09
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Reviewed the dashboard Express router (`dashboard.ts`), single-page HTML dashboard (`dashboard.html`), application entry point (`index.ts`), and environment config loader (`config.ts`).

`config.ts` and `index.ts` are clean with only a minor semantic note. `dashboard.ts` has a runtime path bug that will break serving the HTML file after compilation, and two missing input validation gaps. `dashboard.html` contains one clear XSS injection vector (a WebSocket message directly injected into `innerHTML`) plus several fragile-but-currently-safe direct `rep.id` interpolations into `onclick` strings, and a silent failure in the WebSocket message parser.

---

## Critical Issues

### CR-01: WebSocket message data injected into innerHTML without sanitization

**File:** `src/dashboard.html:716-718`

The `updateRepStatus` function constructs `onclick` attribute strings using `repId` received directly from a WebSocket message — an untrusted channel. If the server is compromised or the WebSocket channel is intercepted (non-TLS deployment), an attacker can inject arbitrary JavaScript via a crafted `repId` value containing a single-quote and closing parenthesis.

```javascript
// Current — repId from WebSocket injected raw into onclick:
const connectBtn = (status === 'disconnected' || status === 'needs_qr')
  ? '<button class="btn btn-warning" onclick="connectRep(\'' + repId + '\')">Connect</button>'
  : '';
const disconnectBtn = status === 'connected'
  ? '<button class="btn btn-ghost" onclick="disconnectRep(\'' + repId + '\')">Disconnect</button>'
  : '';
actions.innerHTML = connectBtn + disconnectBtn;
```

`repId` values arriving over WebSocket are not validated to be UUIDs on the client side, and `escHtml()` is not applied. A value like `x'); alert(1); //` would execute arbitrary JS.

**Fix:** Apply `escHtml()` to `repId` before embedding it in `innerHTML`, matching the pattern already used for `rep.name` elsewhere:

```javascript
const safeId = escHtml(repId);
const connectBtn = (status === 'disconnected' || status === 'needs_qr')
  ? `<button class="btn btn-warning" onclick="connectRep('${safeId}')">Connect</button>`
  : '';
const disconnectBtn = status === 'connected'
  ? `<button class="btn btn-ghost" onclick="disconnectRep('${safeId}')">Disconnect</button>`
  : '';
actions.innerHTML = connectBtn + disconnectBtn;
```

A more robust fix would avoid `innerHTML` for action buttons entirely and use `document.createElement` + `addEventListener`, which eliminates the injection surface regardless of input.

---

## Warnings

### WR-01: __dirname resolves to compiled output directory, not src/ — dashboard.html will not be found at runtime

**File:** `src/dashboard.ts:144`

```typescript
res.sendFile(path.join(__dirname, 'dashboard.html'));
```

After `npm run build`, TypeScript compiles to a `dist/` (or similar) output directory. `__dirname` at runtime will point to that output directory (e.g., `dist/`), but `dashboard.html` lives in `src/`. Unless the build step explicitly copies `dashboard.html` to `dist/`, this `sendFile` call will return a 404 or throw `ENOENT` in production.

**Fix:** Either add a `cp src/dashboard.html dist/dashboard.html` step to the build script, or resolve the path relative to the project root:

```typescript
// Option A: resolve relative to project root (works in both ts-node and compiled)
res.sendFile(path.resolve(process.cwd(), 'src', 'dashboard.html'));

// Option B: copy in package.json build script
// "build": "tsc && cp src/dashboard.html dist/dashboard.html"
```

If using `tsx` for development (which runs TS directly), this works in dev but breaks in compiled production — so the bug may only surface on first deployment.

---

### WR-02: rep.id interpolated unescaped into onclick strings in renderRepList

**File:** `src/dashboard.html:491-496, 513`

```javascript
// Line 491-496
const connectBtn = (rep.status === 'disconnected' || rep.status === 'needs_qr')
  ? `<button class="btn btn-warning" onclick="connectRep('${rep.id}')">Connect</button>`
  : '';
const disconnectBtn = rep.status === 'connected'
  ? `<button class="btn btn-ghost" onclick="disconnectRep('${rep.id}')">Disconnect</button>`
  : '';

// Line 513
<button class="btn btn-danger" onclick="removeRep('${rep.id}', '${escHtml(rep.name)}')">Remove</button>
```

`rep.id` is injected directly into `onclick` attribute strings without `escHtml()`. `rep.name` on the same line correctly uses `escHtml()`. While UUIDs from the database are currently safe, the inconsistency creates a latent risk if the ID format ever changes or if DB values are manipulated.

**Fix:** Apply `escHtml()` consistently to `rep.id`:

```javascript
const safeId = escHtml(rep.id);
const connectBtn = (rep.status === 'disconnected' || rep.status === 'needs_qr')
  ? `<button class="btn btn-warning" onclick="connectRep('${safeId}')">Connect</button>`
  : '';
// ... etc
`<button class="btn btn-danger" onclick="removeRep('${safeId}', '${escHtml(rep.name)}')">Remove</button>`
```

---

### WR-03: WebSocket onmessage JSON.parse has no error handling — uncaught exception silently kills message processing

**File:** `src/dashboard.html:650`

```javascript
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);  // throws if malformed
  if (msg.type === 'qr') { ... }
  if (msg.type === 'status') { ... }
};
```

If the server ever sends a non-JSON frame (e.g., a ping frame handled incorrectly, a library message, or a partial write), `JSON.parse` throws. In a browser `onmessage` handler, uncaught exceptions are swallowed by the event loop but terminate processing of that event. Worse, future messages continue to be processed normally, so the failure is invisible to the user.

**Fix:**

```javascript
ws.onmessage = (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch (_) {
    return; // ignore non-JSON frames
  }
  if (msg.type === 'qr') { handleQrEvent(msg.repId, msg.dataUrl); }
  if (msg.type === 'status') { handleStatusEvent(msg.repId, msg.status); }
};
```

---

### WR-04: POST /api/reps/:id/connect does not verify the rep exists before calling sessionManager.connect()

**File:** `src/dashboard.ts:218-226`

```typescript
apiRouter.post('/reps/:id/connect', async (req, res) => {
  try {
    await sessionManager.connect(req.params.id);
    res.json({ ok: true });
  } catch (err) { ... }
});
```

Any authenticated caller (valid bearer token) can pass an arbitrary string as `:id`. If `sessionManager.connect()` does not itself validate that the repId corresponds to an existing DB row, this will either silently create phantom sessions or throw an opaque error mapped to a 500 response. A 404 is more appropriate for missing resources.

**Fix:** Add a DB existence check before connecting:

```typescript
apiRouter.post('/reps/:id/connect', async (req, res) => {
  try {
    const repId = req.params.id;
    const { rowCount } = await pool.query('SELECT 1 FROM reps WHERE id = $1', [repId]);
    if (!rowCount) {
      res.status(404).json({ error: 'Rep not found' });
      return;
    }
    await sessionManager.connect(repId);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ repId: req.params.id, err }, 'POST /api/reps/:id/connect failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

Apply the same pattern to `/reps/:id/disconnect`.

---

### WR-05: DELETE /api/reps/:id returns 200 OK even when the rep does not exist

**File:** `src/dashboard.ts:198-213`

```typescript
apiRouter.delete('/reps/:id', async (req, res) => {
  const repId = req.params.id as string;
  await sessionManager.logout(repId);
  await pool.query('DELETE FROM reps WHERE id = $1', [repId]);
  res.json({ ok: true });
});
```

`DELETE FROM reps WHERE id = $1` is a no-op if the row does not exist, and the handler unconditionally returns `{ ok: true }`. A DELETE against a non-existent resource should return 404. Additionally, if `sessionManager.logout()` throws for an unknown repId, the error propagates to the catch block and returns 500 rather than 404, making the two failure modes (non-existent vs. internal error) indistinguishable.

**Fix:**

```typescript
apiRouter.delete('/reps/:id', async (req, res) => {
  const repId = req.params.id;
  try {
    const { rowCount } = await pool.query('SELECT 1 FROM reps WHERE id = $1', [repId]);
    if (!rowCount) {
      res.status(404).json({ error: 'Rep not found' });
      return;
    }
    await sessionManager.logout(repId);
    await pool.query('DELETE FROM reps WHERE id = $1', [repId]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ repId, err }, 'DELETE /api/reps/:id failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

## Info

### IN-01: escHtml() does not escape single quotes — onclick attributes are partially protected

**File:** `src/dashboard.html:778-785`

```javascript
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // Missing: .replace(/'/g, '&#39;')
}
```

`escHtml()` does not escape single quotes (`'`). All `onclick` attribute values in the codebase use single-quote delimiters around interpolated IDs and names (`onclick="fn('VALUE')"`). If `VALUE` contains a single quote, attribute escaping with `escHtml()` would not protect against it. The function is named `escHtml` which implies HTML body escaping (where `'` → `&#39;` is optional per spec), but when used inside attribute values delimited by single quotes, the omission is a gap.

**Fix:** Add single-quote escaping to `escHtml`, or rename and document its limited scope:

```javascript
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

---

### IN-02: export const server in index.ts exports a Promise, not an http.Server

**File:** `src/index.ts:61-64`

```typescript
export const server = main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
```

`server` is typed as `Promise<http.Server | never>` (i.e., `Promise<http.Server>`). Any module importing `server` would receive the Promise, not the resolved `http.Server` instance. This is currently harmless because nothing imports `server`, but the export is misleading and inconsistent — callers expecting `http.Server` would need to `await` it.

**Fix:** Either remove the export (the file is an entry point and does not need to export the server), or document that it is a Promise:

```typescript
// Option A: remove export — index.ts is an entry point
main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});

// Option B: keep for testability, rename for clarity
export const serverReady: Promise<http.Server> = main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
```

---

_Reviewed: 2026-04-09_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
