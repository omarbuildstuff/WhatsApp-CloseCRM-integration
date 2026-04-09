---
phase: 01-foundation
reviewed: 2026-04-09T00:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/config.ts
  - src/db/pool.ts
  - src/db/schema.ts
  - src/db-init.ts
  - src/whatsapp/authState.ts
  - src/whatsapp/sessionManager.ts
  - src/index.ts
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-04-09T00:00:00Z
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found

## Summary

The foundation layer is well-structured overall. The PostgreSQL auth state persistence in `authState.ts` is correctly implemented with transactions, and the exponential-backoff reconnect logic in `sessionManager.ts` follows the documented pitfall guidance. However, there is one critical security issue in the database pool configuration (TLS certificate verification is disabled), and four warnings covering a reconnect timer cancellation bug, an unhandled-rejection path in an async event handler, a missing `try/catch` in `logout()`, and silent empty-string defaults for required credentials. Three informational items cover the `PORT` parsing edge case, missing DB-level status constraints, and use of `any`.

---

## Critical Issues

### CR-01: TLS Certificate Verification Disabled for Database Connection

**File:** `src/db/pool.ts:6`
**Issue:** `ssl: { rejectUnauthorized: false }` disables certificate validation on every connection to Neon PostgreSQL. This makes the connection vulnerable to man-in-the-middle attacks — an attacker on the network path could intercept or modify database traffic even though TLS is nominally in use. CLAUDE.md explicitly says to use `?sslmode=require` in the connection string, which does enforce server identity. The pool option overrides that protection.
**Fix:**
```typescript
// Option A — remove the override entirely and rely on the sslmode=require
// already present in the DATABASE_URL connection string:
export const pool = new Pool({
  connectionString: config.databaseUrl,
  // no ssl override — sslmode=require in the URL handles TLS correctly
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

// Option B — if you need to pass ssl explicitly (e.g., Neon root CA):
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: true },
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
```

---

## Warnings

### WR-01: Pending Reconnect Timer Not Cancelled on Explicit Disconnect/Logout

**File:** `src/whatsapp/sessionManager.ts:108`
**Issue:** `setTimeout(() => this.connect(repId), delayMs)` fires a reconnect but the timer handle is never stored. If `disconnect()` or `logout()` is called for the same `repId` during the backoff window, the timer will still fire and re-open a session for a rep that was intentionally disconnected. This is a logic bug — an operator action to stop a session is silently overridden.
**Fix:**
```typescript
// Add a map to track pending timers
private reconnectTimers = new Map<string, NodeJS.Timeout>();

// In handleReconnect, replace the setTimeout call:
const timer = setTimeout(() => {
  this.reconnectTimers.delete(repId);
  this.connect(repId);
}, delayMs);
this.reconnectTimers.set(repId, timer);

// In disconnect() and logout(), cancel any pending timer:
async disconnect(repId: string): Promise<void> {
  const timer = this.reconnectTimers.get(repId);
  if (timer) {
    clearTimeout(timer);
    this.reconnectTimers.delete(repId);
  }
  // ... rest of existing logic
}
```

### WR-02: Unhandled Promise Rejection in Async `connection.update` Handler

**File:** `src/whatsapp/sessionManager.ts:40`
**Issue:** The `connection.update` event handler is declared `async` but the EventEmitter does not `await` it. If the `pool.query(...)` on line 49 or line 80 throws (e.g., DB connectivity lost), the rejected Promise is silently swallowed by the EventEmitter. In Node.js, unhandled rejections from async event listeners do not surface as `uncaughtException` — they are quietly dropped, and the rep's DB status is never updated.
**Fix:**
```typescript
sock.ev.on('connection.update', (update) => {
  // Wrap async logic so errors are logged rather than silently dropped
  handleConnectionUpdate(update).catch((err) => {
    this.logger.error({ repId, err }, 'Error in connection.update handler');
  });
});

const handleConnectionUpdate = async (update: typeof update) => {
  const { connection, lastDisconnect, qr } = update;
  // ... existing logic unchanged
};
```

### WR-03: `logout()` Leaves Stale State on Network Error

**File:** `src/whatsapp/sessionManager.ts:133-140`
**Issue:** If `sock.logout()` throws (e.g., WhatsApp is unreachable), the `catch` propagates to the caller and the subsequent `clearAuthState()` and `pool.query(UPDATE status)` calls are never reached. The rep remains with status `connected` in the DB and auth keys still stored, even though the socket has been removed from `this.sessions`. A restart will then attempt to reconnect with stale credentials.
**Fix:**
```typescript
async logout(repId: string): Promise<void> {
  const sock = this.sessions.get(repId);
  if (sock) {
    try {
      await sock.logout();
    } catch (err) {
      this.logger.warn({ repId, err }, 'sock.logout() failed — continuing with local cleanup');
    }
    this.sessions.delete(repId);
  }
  // Always clean up auth state and update DB status
  await this.clearAuthState(repId);
  await pool.query("UPDATE reps SET status = 'needs_qr' WHERE id = $1", [repId]);
  this.reconnectAttempts.delete(repId);
}
```

### WR-04: `closeApiKey` and `dashboardPassword` Silently Default to Empty String

**File:** `src/config.ts:14-15`
**Issue:** Both `CLOSE_API_KEY` and `DASHBOARD_PASSWORD` default to `''` instead of failing at startup. A misconfigured deployment (missing `.env` entries) will start successfully — all Close API calls will fail at runtime with auth errors, and the dashboard will be unprotected if authentication middleware checks `config.dashboardPassword`. These variables are functionally required for the system to operate correctly and securely.
**Fix:**
```typescript
export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  closeApiKey: required('CLOSE_API_KEY'),
  dashboardPassword: required('DASHBOARD_PASSWORD'),
};
```
If optional operation without Close sync is a genuine design goal, add a comment making that intent explicit and add a runtime warning when the value is empty.

---

## Info

### IN-01: `PORT` Environment Variable Parsed Without Validation

**File:** `src/config.ts:13`
**Issue:** `Number(process.env.PORT ?? 3000)` produces `NaN` if `PORT` is set to a non-numeric string. Express accepts `NaN` as a port value and may bind to an OS-assigned port or emit a cryptic error with no clear indication that `PORT` was the cause.
**Fix:**
```typescript
const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT env var: "${rawPort}"`);
}
// then: port: port
```

### IN-02: `reps.status` Column Has No CHECK Constraint

**File:** `src/db/schema.ts:10`
**Issue:** The `status` column accepts any TEXT value. The codebase writes `'connected'`, `'disconnected'`, and `'needs_qr'` via raw SQL strings in multiple places. A typo in any of those strings (e.g., `'disconnected '` with trailing space) would silently corrupt state with no DB-level validation to catch it.
**Fix:**
```sql
status TEXT NOT NULL DEFAULT 'disconnected'
  CHECK (status IN ('connected', 'disconnected', 'needs_qr')),
```
Note: Adding a CHECK constraint to an existing table requires a migration (`ALTER TABLE reps ADD CONSTRAINT ...`). The `IF NOT EXISTS` pattern in `createSchema` will not apply this to a table that already exists.

### IN-03: Use of `any` Type in `authState.ts`

**File:** `src/whatsapp/authState.ts:26`
**Issue:** `const data: Record<string, any> = {}` uses `any`, which loses type safety for the deserialized signal key values. The Baileys type for `get()` returns a typed map keyed by key type.
**Fix:** Use the inferred return type from the `SignalKeyStore` interface, or at minimum use `Record<string, unknown>` and cast only at the point of use.

---

_Reviewed: 2026-04-09T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
