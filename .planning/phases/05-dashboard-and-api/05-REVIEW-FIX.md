---
phase: 05-dashboard-and-api
fixed_at: 2026-04-09T00:00:00Z
review_path: .planning/phases/05-dashboard-and-api/05-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 05: Code Review Fix Report

**Fixed at:** 2026-04-09
**Source review:** .planning/phases/05-dashboard-and-api/05-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (1 Critical, 5 Warnings)
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: WebSocket message data injected into innerHTML without sanitization

**Files modified:** `src/dashboard.html`
**Commit:** c18c9aa
**Applied fix:** In `updateRepStatus`, introduced `const safeId = escHtml(repId)` before building the `connectBtn` and `disconnectBtn` strings, replacing the raw `repId` interpolation with `safeId` in both `onclick` attribute values.

---

### WR-01: __dirname resolves to compiled output directory — dashboard.html not found at runtime

**Files modified:** `src/dashboard.ts`
**Commit:** 37db9e4
**Applied fix:** Changed `res.sendFile(path.join(__dirname, 'dashboard.html'))` to `res.sendFile(path.resolve(process.cwd(), 'src', 'dashboard.html'))` so the path works correctly in both `tsx` dev mode and compiled production (`dist/`).

---

### WR-02: rep.id interpolated unescaped into onclick strings in renderRepList

**Files modified:** `src/dashboard.html`
**Commit:** cebe24a
**Applied fix:** In `renderRepList`, introduced `const safeId = escHtml(rep.id)` and replaced all three raw `rep.id` interpolations (connectBtn, disconnectBtn, removeRep button, and the `id="rep-${rep.id}"` attribute) with `safeId`, matching the existing `escHtml(rep.name)` pattern.

---

### WR-03: WebSocket onmessage JSON.parse has no error handling

**Files modified:** `src/dashboard.html`
**Commit:** 7f77ac5
**Applied fix:** Wrapped `JSON.parse(event.data)` in a try/catch block inside `ws.onmessage`. On parse failure the handler returns early, silently ignoring the malformed frame without disrupting subsequent message processing.

---

### WR-04: POST /api/reps/:id/connect does not verify rep exists before calling sessionManager.connect()

**Files modified:** `src/dashboard.ts`
**Commit:** febcabc
**Applied fix:** Added a `SELECT 1 FROM reps WHERE id = $1` existence check at the top of both `/reps/:id/connect` and `/reps/:id/disconnect` handlers. Returns `404 { error: 'Rep not found' }` immediately if the row does not exist, otherwise proceeds to call `sessionManager.connect()` / `sessionManager.disconnect()`.

---

### WR-05: DELETE /api/reps/:id returns 200 OK even when the rep does not exist

**Files modified:** `src/dashboard.ts`
**Commit:** f353e15
**Applied fix:** Added a `SELECT 1 FROM reps WHERE id = $1` existence check before the logout+delete sequence. Returns `404 { error: 'Rep not found' }` if the row is absent. Also moved `repId` assignment outside the try block so it is available in the catch logger call, and added `repId` to the error log context.

---

## Skipped Issues

None — all in-scope findings were fixed.

---

_Fixed: 2026-04-09_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
