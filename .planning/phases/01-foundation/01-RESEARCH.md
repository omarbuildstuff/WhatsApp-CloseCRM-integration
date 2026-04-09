# Phase 1: Foundation - Research

**Researched:** 2026-04-09
**Domain:** Baileys PostgreSQL auth state persistence + SessionManager reconnect logic
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Never use `useMultiFileAuthState` — PostgreSQL-backed auth state is mandatory from day one
- Stay on `@whiskeysockets/baileys@6.7.21` — v7 RC has confirmed 100% connection failure bug
- The custom `usePgAuthState` implementation requires study of Baileys internal Signal key store interface before implementation — verify exact key types Baileys 6.7.x writes

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use ROADMAP phase goal, success criteria, and codebase conventions to guide decisions.

### Deferred Ideas (OUT OF SCOPE)
None — infrastructure phase.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SESS-02 | Baileys auth state persists in PostgreSQL so sessions survive server restarts | `usePgAuthState` pattern in Standard Stack; `wa_auth_keys` + `wa_auth_creds` schema; `makeCacheableSignalKeyStore` wrapping |
| SESS-03 | System automatically reconnects on transient disconnects (network drops, WA server restarts) | DisconnectReason enum values verified from installed Baileys; reconnectable vs terminal classification in Pitfalls |
| SESS-04 | System stops reconnecting on terminal states (loggedOut, badSession) and marks rep as needs-QR | Exact numeric codes from Types/index.d.ts; `reps.status` column design; no-reconnect branch logic |
</phase_requirements>

---

## Summary

Phase 1 delivers three tightly coupled capabilities: the PostgreSQL schema, the custom Baileys auth state adapter (`usePgAuthState`), and the `SessionManager` class with correct reconnect discrimination. Every later phase depends on these three working correctly — broken auth state means every rep loses their session on restart; wrong reconnect logic means bans.

The critical research finding is the exact `SignalKeyStore` interface that Baileys 6.7.21 expects for the custom auth state. This was verified directly against the installed package's TypeScript declaration files and reference implementation (`use-multi-file-auth-state.js`). The interface requires a `get(type, ids[])` that returns a keyed map, and a `set(data: SignalDataSet)` that must handle `null` values as deletes. The `app-state-sync-key` type requires special deserialization via `proto.Message.AppStateSyncKeyData.fromObject()` — this is a non-obvious requirement that, if missed, causes silent decryption failures.

The reconnect logic research verified all `DisconnectReason` numeric codes from the actual installed types — there are exactly 10 values, and only 5 are safe to reconnect on. The other 5 are terminal and must result in `status = 'needs_qr'` in the DB, cleared credentials, and a stopped reconnect loop. The `sock.end(error: Error | undefined): void` and `sock.logout(msg?: string): Promise<void>` signatures were also verified from the installed `Socket/index.d.ts`.

**Primary recommendation:** Build in order: schema (`db-init.ts`) → `usePgAuthState` with `makeCacheableSignalKeyStore` wrapping → `SessionManager` with branched reconnect logic → `resumeAll()` startup restore. Do not skip any step.

---

## Standard Stack

### Core (already installed — no new installs needed for Phase 1)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@whiskeysockets/baileys` | 6.7.21 (installed) | WhatsApp Web protocol; `makeWASocket`, `DisconnectReason`, auth types | Only stable CJS release; v7 RC has 100% auth failure bug |
| `pg` | 8.13.0 (installed) | PostgreSQL driver; Pool for all DB operations | Neon-compatible; Pool required for connection reuse |
| `pino` | 9.5.0 (installed) | Structured logging passed to `makeWASocket` | Baileys uses pino internally; consistent log format |
| `tsx` | 4.19.0 (installed) | Run `db:init` script during development | Powers `npm run db:init` → `tsx src/db-init.ts` |

### Supporting (need to install)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `dotenv` | ^16.x | Load `DATABASE_URL` from `.env` at startup | Required at process start before any DB or config access |

**Installation:**
```bash
npm install dotenv
```

**Version verification:** `dotenv` latest stable is 16.x [ASSUMED — verify with `npm view dotenv version` before pinning].

### Already Available — No Install Needed

`makeCacheableSignalKeyStore`, `addTransactionCapability`, `initAuthCreds`, `proto`, `DisconnectReason`, `makeWASocket`, `BufferJSON` — all exported from `@whiskeysockets/baileys` main index. [VERIFIED: `node_modules/@whiskeysockets/baileys/lib/index.d.ts` and `lib/Utils/index.d.ts`]

---

## Architecture Patterns

### Recommended Project Structure (Phase 1 files only)

```
src/
├── index.ts                  # Entry: creates pool, starts SessionManager.resumeAll(), starts Express placeholder
├── config.ts                 # Reads process.env, validates DATABASE_URL present, exports typed config
├── db/
│   ├── pool.ts               # pg Pool singleton (imported everywhere that needs DB)
│   └── schema.ts             # CREATE TABLE IF NOT EXISTS for all 5 tables (run by db:init)
├── db-init.ts                # Standalone script: imports pool + schema, runs schema, exits
└── whatsapp/
    ├── authState.ts          # usePgAuthState(repId) — the PG-backed SignalKeyStore
    └── sessionManager.ts     # SessionManager class: connect, disconnect, resumeAll, handleReconnect
```

### Pattern 1: The SignalKeyStore Interface (CRITICAL)

**What:** The exact interface Baileys 6.7.21 requires for the `keys` property of `AuthenticationState`.

**Verified from:** `node_modules/@whiskeysockets/baileys/lib/Types/Auth.d.ts` — read directly. [VERIFIED: installed package]

```typescript
// From Auth.d.ts — the exact key types Baileys writes:
type SignalDataTypeMap = {
  'pre-key': KeyPair;                       // { public: Uint8Array; private: Uint8Array }
  'session': Uint8Array;
  'sender-key': Uint8Array;
  'sender-key-memory': { [jid: string]: boolean };
  'app-state-sync-key': proto.Message.IAppStateSyncKeyData;
  'app-state-sync-version': LTHashState;
};

// The interface your usePgAuthState must implement:
type SignalKeyStore = {
  get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Awaitable<{
    [id: string]: SignalDataTypeMap[T];
  }>;
  set(data: SignalDataSet): Awaitable<void>;
  clear?(): Awaitable<void>;
};

// SignalDataSet (what set() receives):
type SignalDataSet = {
  [T in keyof SignalDataTypeMap]?: {
    [id: string]: SignalDataTypeMap[T] | null;  // null = delete this key
  };
};
```

**Critical non-obvious requirement:** When `type === 'app-state-sync-key'`, the JSONB value retrieved from PostgreSQL MUST be deserialized via `proto.Message.AppStateSyncKeyData.fromObject(value)` before returning it. Without this, WhatsApp app state sync silently fails. [VERIFIED: `use-multi-file-auth-state.js` lines 96-98]

**`null` means delete:** When `set()` is called with `data[category][id] = null`, the implementation must DELETE that row from `wa_auth_keys`, not store `null`. [VERIFIED: `use-multi-file-auth-state.js` — `removeData` path]

### Pattern 2: usePgAuthState Implementation Skeleton

```typescript
// src/whatsapp/authState.ts
import { proto, initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataSet } from '@whiskeysockets/baileys';
import { pool } from '../db/pool';
import type { Logger } from 'pino';

export async function usePgAuthState(repId: string, logger?: Logger): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // 1. Load or initialize creds
  const credsRow = await pool.query(
    'SELECT creds FROM wa_auth_creds WHERE rep_id = $1',
    [repId]
  );
  const creds = credsRow.rows[0]
    ? JSON.parse(JSON.stringify(credsRow.rows[0].creds), BufferJSON.reviver)
    : initAuthCreds();

  // 2. Build raw SignalKeyStore (reads/writes wa_auth_keys)
  const rawStore = {
    async get(type: string, ids: string[]) {
      const { rows } = await pool.query(
        'SELECT key_id, value FROM wa_auth_keys WHERE rep_id = $1 AND key_type = $2 AND key_id = ANY($3)',
        [repId, type, ids]
      );
      const data: Record<string, any> = {};
      for (const row of rows) {
        let value = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        data[row.key_id] = value;
      }
      return data;
    },
    async set(data: SignalDataSet) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [type, keys] of Object.entries(data)) {
          for (const [id, value] of Object.entries(keys ?? {})) {
            if (value == null) {
              await client.query(
                'DELETE FROM wa_auth_keys WHERE rep_id = $1 AND key_type = $2 AND key_id = $3',
                [repId, type, id]
              );
            } else {
              const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
              await client.query(
                `INSERT INTO wa_auth_keys (rep_id, key_type, key_id, value)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (rep_id, key_type, key_id) DO UPDATE SET value = EXCLUDED.value`,
                [repId, type, id, serialized]
              );
            }
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  };

  // 3. Wrap with Baileys' cache layer (reduces DB hits for hot keys)
  const keys = makeCacheableSignalKeyStore(rawStore, logger);

  return {
    state: { creds, keys },
    saveCreds: async () => {
      const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
      await pool.query(
        `INSERT INTO wa_auth_creds (rep_id, creds, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (rep_id) DO UPDATE SET creds = EXCLUDED.creds, updated_at = NOW()`,
        [repId, serialized]
      );
    }
  };
}
```

**Source:** Pattern derived from `use-multi-file-auth-state.js` structure with filesystem replaced by PostgreSQL. All type names verified from `Auth.d.ts`. [VERIFIED: installed package source]

### Pattern 3: DisconnectReason Branch (CRITICAL for SESS-03 and SESS-04)

**Verified DisconnectReason enum values** from `node_modules/@whiskeysockets/baileys/lib/Types/index.d.ts`: [VERIFIED: installed package]

```typescript
enum DisconnectReason {
  connectionClosed    = 428,  // RECONNECT — transient close
  connectionLost      = 408,  // RECONNECT — network drop
  timedOut            = 408,  // RECONNECT — same code as connectionLost
  restartRequired     = 515,  // RECONNECT — normal after QR scan
  unavailableService  = 503,  // RECONNECT — WA server issue
  connectionReplaced  = 440,  // TERMINAL — another device opened same session
  loggedOut           = 401,  // TERMINAL — rep explicitly logged out
  badSession          = 500,  // TERMINAL — corrupted credentials
  multideviceMismatch = 411,  // TERMINAL — device list conflict
  forbidden           = 403,  // TERMINAL — banned/blocked
}
```

**Important:** `connectionLost` (408) and `timedOut` (408) share the same numeric code. Compare by enum name via the Set approach below, not by raw number.

```typescript
// src/whatsapp/sessionManager.ts
import { DisconnectReason } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';

const TERMINAL_REASONS = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.connectionReplaced,
  DisconnectReason.multideviceMismatch,
  DisconnectReason.forbidden,
]);

private async handleReconnect(repId: string, lastDisconnect?: { error: Boom | Error | undefined }) {
  const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

  if (TERMINAL_REASONS.has(statusCode)) {
    // Stop reconnecting — mark rep as needs-QR, clear stored creds
    await pool.query(
      "UPDATE reps SET status = 'needs_qr' WHERE id = $1",
      [repId]
    );
    await this.clearAuthState(repId); // DELETE from wa_auth_keys + wa_auth_creds
    this.sessions.delete(repId);
    this.emit('status', { repId, status: 'needs_qr' });
    return;
  }

  // Reconnectable: use exponential backoff
  const attempt = this.reconnectAttempts.get(repId) ?? 0;
  if (attempt >= MAX_RECONNECT_ATTEMPTS) {
    // Give up after N attempts, mark as disconnected
    await pool.query("UPDATE reps SET status = 'disconnected' WHERE id = $1", [repId]);
    this.sessions.delete(repId);
    return;
  }

  const delayMs = Math.min(2000 * Math.pow(2, attempt), 60_000);
  this.reconnectAttempts.set(repId, attempt + 1);
  setTimeout(() => this.connect(repId), delayMs);
}
```

### Pattern 4: SessionManager as EventEmitter Registry

**Socket API (verified):** `sock.end(error: Error | undefined): void` closes the WebSocket connection locally. `sock.logout(msg?: string): Promise<void>` tells WhatsApp to unlink the linked device. [VERIFIED: `node_modules/@whiskeysockets/baileys/lib/Socket/index.d.ts` lines 196-197]

```typescript
// src/whatsapp/sessionManager.ts
import { EventEmitter } from 'events';
import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import { usePgAuthState } from './authState';
import { pool } from '../db/pool';
import pino from 'pino';

const MAX_RECONNECT_ATTEMPTS = 10;

class SessionManager extends EventEmitter {
  private sessions = new Map<string, WASocket>();
  private reconnectAttempts = new Map<string, number>();
  private logger = pino({ level: 'info' });

  async connect(repId: string): Promise<void> {
    // Clean up existing socket if any (prevents dual-socket duplicate events)
    const existing = this.sessions.get(repId);
    if (existing) {
      existing.end(undefined);      // sock.end(Error | undefined): void
      this.sessions.delete(repId);
    }

    const { state, saveCreds } = await usePgAuthState(repId, this.logger);
    const sock = makeWASocket({
      auth: state,
      logger: this.logger.child({ repId }),
      printQRInTerminal: false,  // We stream QR via WebSocket, not terminal
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.emit('qr', { repId, qr });
      }

      if (connection === 'open') {
        this.reconnectAttempts.delete(repId); // Reset backoff on success
        await pool.query("UPDATE reps SET status = 'connected' WHERE id = $1", [repId]);
        this.emit('status', { repId, status: 'connected' });
      }

      if (connection === 'close') {
        await this.handleReconnect(repId, lastDisconnect);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type === 'notify') {
        for (const msg of messages) {
          this.emit('message', { repId, msg });
        }
      }
    });

    this.sessions.set(repId, sock);
  }

  async resumeAll(): Promise<void> {
    // Only reconnect reps that were connected or disconnected — NOT needs_qr
    const { rows } = await pool.query(
      "SELECT id FROM reps WHERE status IN ('connected', 'disconnected')"
    );
    for (const row of rows) {
      await this.connect(row.id);
    }
  }

  async disconnect(repId: string): Promise<void> {
    // Closes WS locally; session stays valid on WhatsApp (rep can reconnect without QR)
    const sock = this.sessions.get(repId);
    if (sock) {
      sock.end(undefined);         // sock.end(Error | undefined): void
      this.sessions.delete(repId);
    }
    await pool.query("UPDATE reps SET status = 'disconnected' WHERE id = $1", [repId]);
  }

  async logout(repId: string): Promise<void> {
    // Unlinks device from WhatsApp — rep MUST re-scan QR after this
    const sock = this.sessions.get(repId);
    if (sock) {
      await sock.logout();         // sock.logout(msg?: string): Promise<void>
      this.sessions.delete(repId);
    }
    await this.clearAuthState(repId);
    await pool.query("UPDATE reps SET status = 'needs_qr' WHERE id = $1", [repId]);
  }

  private async clearAuthState(repId: string): Promise<void> {
    await pool.query('DELETE FROM wa_auth_keys WHERE rep_id = $1', [repId]);
    await pool.query('DELETE FROM wa_auth_creds WHERE rep_id = $1', [repId]);
  }
}

export const sessionManager = new SessionManager();
```

### Pattern 5: PostgreSQL Schema (all 5 required tables)

```sql
-- src/db/schema.ts (as SQL strings executed via pool.query)

CREATE TABLE IF NOT EXISTS reps (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT        NOT NULL,
  close_user_id TEXT,
  wa_phone      TEXT,                          -- E.164, filled after first successful QR scan
  status        TEXT        NOT NULL DEFAULT 'disconnected',  -- 'connected'|'disconnected'|'needs_qr'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wa_auth_keys (
  rep_id    TEXT  NOT NULL,
  key_type  TEXT  NOT NULL,  -- 'pre-key'|'session'|'sender-key'|'sender-key-memory'|'app-state-sync-key'|'app-state-sync-version'
  key_id    TEXT  NOT NULL,
  value     JSONB NOT NULL,
  PRIMARY KEY (rep_id, key_type, key_id)
);

CREATE TABLE IF NOT EXISTS wa_auth_creds (
  rep_id     TEXT        PRIMARY KEY,
  creds      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT        PRIMARY KEY,  -- Baileys message ID
  rep_id            TEXT        NOT NULL REFERENCES reps(id),
  direction         TEXT        NOT NULL,     -- 'incoming'|'outgoing'
  wa_jid            TEXT        NOT NULL,     -- full JID (e.g. 15551234567@s.whatsapp.net)
  phone_e164        TEXT,                     -- normalized, set during sync phase
  lead_id           TEXT,                     -- Close lead_id, NULL if unmatched
  close_activity_id TEXT,                     -- set after successful Close sync
  body              TEXT,
  media_type        TEXT,                     -- 'text'|'image'|'document'|'audio'|'video'
  media_url         TEXT,
  timestamp         TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(id)                                  -- enforces SYNC-04 dedup constraint
);

CREATE TABLE IF NOT EXISTS close_phone_cache (
  phone_e164  TEXT        PRIMARY KEY,
  lead_id     TEXT,                           -- NULL = verified non-lead
  lead_name   TEXT,
  cached_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Schema note:** `reps.status` uses values `connected`, `disconnected`, `needs_qr`. PROJECT.md used `qr_pending`; roadmap success criteria says "needs-QR"; this research uses `needs_qr` (SQL-safe underscore form). The planner should lock one value. [ASSUMED: `needs_qr` is preferred — see Open Questions]

### Pattern 6: Pool Singleton with Neon Config

```typescript
// src/db/pool.ts
import { Pool } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: false },  // Required for Neon.tech
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('Unexpected pg pool error', err);
});
```

**Note:** Neon's connection string contains `?sslmode=require`; `pg` Pool also needs `ssl: { rejectUnauthorized: false }` in the Pool config. Both together is safe. [VERIFIED: PITFALLS.md, Neon docs cited there]

### Anti-Patterns to Avoid

- **`useMultiFileAuthState`:** Never. Even for a 5-minute test — it creates `auth_info_baileys/` on the filesystem that will never be cleaned up. [LOCKED DECISION]
- **Calling `sock.end()` without removing from sessions Map:** Always `sessions.delete(repId)` before or immediately after ending the socket. Dual sockets cause duplicate `messages.upsert` events and double Close activities.
- **Checking disconnect reason by number not by enum:** `connectionLost` and `timedOut` both equal 408. Use the `TERMINAL_REASONS` Set approach above, not a numeric switch.
- **Reconnecting on `restartRequired` (515) without delay:** This fires immediately after a QR scan. Reconnect with a short delay (500ms) so the auth state has time to be saved before the new socket loads it.
- **Missing `ON CONFLICT DO UPDATE` on auth key writes:** Plain INSERT breaks on concurrent key updates. Upsert is mandatory.
- **Storing `app-state-sync-key` values without protobuf deserialization:** Silent app-state decryption failures.
- **Calling `sock.logout()` when you only want to disconnect:** `logout()` unlinks the device from WhatsApp permanently; `end()` just closes the local WebSocket. Use the right one. [VERIFIED: Socket/index.d.ts]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Signal key in-memory caching | Custom Map cache | `makeCacheableSignalKeyStore()` from Baileys | Already implements correct TTL, cache invalidation; exported from `@whiskeysockets/baileys` |
| Buffer serialization for JSONB | Custom replacer/reviver | `BufferJSON.replacer` / `BufferJSON.reviver` from Baileys | Handles `Uint8Array`, `Buffer`, base64 encoding correctly; mismatched serialization corrupts keys |
| Initial credential generation | `initAuthCreds()` hand-coded | `initAuthCreds()` from Baileys | Generates all required Signal protocol keys with correct entropy |
| Connection mutex for concurrent writes | Custom async lock | Postgres transactions (`BEGIN/COMMIT`) | DB transactions are the mutex; no additional locking needed for PG-backed store |
| Protobuf deserialization | Manual JSON parse | `proto.Message.AppStateSyncKeyData.fromObject()` | Protobuf objects need their class methods after deserialization; plain JSON parse loses them |

**Key insight:** Baileys exports all the utilities needed to build a custom auth state. The implementation is mostly plumbing — replacing `fs` calls with `pool.query()` calls, using Baileys' own serialization helpers.

---

## Common Pitfalls

### Pitfall 1: Missing `app-state-sync-key` Protobuf Deserialization
**What goes wrong:** Auth state loads from PostgreSQL. Baileys requests `app-state-sync-key` values. The raw JSONB is returned as a plain JavaScript object. WhatsApp app state sync fails silently — no error thrown, but contact names, group metadata, and chat history don't appear.
**Why it happens:** PostgreSQL JSONB round-trips as plain objects. Protobuf objects need class methods that aren't on plain objects.
**How to avoid:** In the `get()` implementation, check `if (type === 'app-state-sync-key' && value) { value = proto.Message.AppStateSyncKeyData.fromObject(value); }` — exactly as done in `use-multi-file-auth-state.js`.
**Warning signs:** Sessions restore without QR scan, but app state events are missing; contact names show as phone numbers.

### Pitfall 2: Reconnect Loop on restartRequired
**What goes wrong:** After a QR scan, Baileys fires `connection === 'close'` with `restartRequired` (515) as part of the normal handshake. A naive reconnect handler fires immediately, before `saveCreds()` completes, creating a socket with stale credentials.
**Why it happens:** `restartRequired` is in the "reconnect" category, but it fires as part of the QR flow, not as an error.
**How to avoid:** On `restartRequired`, add a 500ms delay before `connect(repId)` to let `saveCreds()` complete. The session will reconnect without a new QR because the credentials are now stored.
**Warning signs:** Immediately after QR scan, the QR code appears again; log shows repeated `restartRequired`.

### Pitfall 3: Signal Key Race Condition on Burst Messages
**What goes wrong:** Two messages arrive simultaneously for the same rep. Both trigger `creds.update` or `set()` calls. Without transactions, one write overwrites the other, causing `decryption failed` errors.
**Why it happens:** Async DB writes without serialization race each other.
**How to avoid:** Wrap all `set()` writes in a `BEGIN/COMMIT` transaction. PostgreSQL's row-level locking handles the rest. [VERIFIED: pattern in `usePgAuthState` skeleton above]
**Warning signs:** Intermittent `could not decrypt` errors correlated with high message volume.

### Pitfall 4: resumeAll() Connects Reps with needs_qr Status
**What goes wrong:** `resumeAll()` reconnects reps in all statuses including `needs_qr`. Baileys tries to connect with invalid/deleted credentials, gets `loggedOut` again, marks as `needs_qr` again — infinite startup loop for broken reps.
**Why it happens:** The query for "active" reps includes all non-disconnected reps.
**How to avoid:** `resumeAll()` query: `WHERE status IN ('connected', 'disconnected')` — explicitly exclude `needs_qr`. Reps in `needs_qr` state only connect when an admin initiates a QR scan.
**Warning signs:** Logs show repeated connection attempts for a rep immediately after startup.

### Pitfall 5: Neon Idle Connection Timeout
**What goes wrong:** After 5 minutes of idle (no messages), Neon terminates the DB connection. Next query fails with `connection terminated unexpectedly`.
**Why it happens:** Neon free tier has aggressive idle connection timeouts.
**How to avoid:** Set `idleTimeoutMillis: 10_000` on the Pool. `pg` Pool automatically removes idle connections before Neon terminates them.
**Warning signs:** First query after a quiet period throws a connection error; subsequent queries succeed.

---

## Code Examples

### db-init.ts (standalone script)

```typescript
// src/db-init.ts
import 'dotenv/config';
import { pool } from './db/pool';
import { createSchema } from './db/schema';

async function main() {
  console.log('Initializing database schema...');
  await createSchema();
  console.log('Schema initialized successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('db:init failed:', err);
  process.exit(1);
});
```

### config.ts

```typescript
// src/config.ts
import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  closeApiKey: process.env.CLOSE_API_KEY ?? '',
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '',
};
```

### index.ts entry point (Phase 1 stub)

```typescript
// src/index.ts
import express from 'express';
import { pool } from './db/pool';
import { sessionManager } from './whatsapp/sessionManager';
import { config } from './config';
import pino from 'pino';

const logger = pino({ level: 'info' });

async function main() {
  // Verify DB connectivity
  await pool.query('SELECT 1');
  logger.info('Database connected');

  // Restore all rep sessions from DB
  await sessionManager.resumeAll();
  logger.info('Sessions restored');

  // Minimal Express server (routes added in later phases)
  const app = express();
  app.use(express.json());

  app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Server started');
  });
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `useMultiFileAuthState` (filesystem) | Custom DB-backed `usePgAuthState` | Baileys v5 → v6 added the `SignalKeyStore` interface that makes custom auth possible | Enables session persistence across container restarts |
| Direct `SignalKeyStore` (no cache) | `makeCacheableSignalKeyStore` wrapping | Added in Baileys 6.5+ | Reduces DB round-trips for hot Signal keys; improves decrypt latency |
| Single file for all auth state | Separate `wa_auth_creds` (account identity) + `wa_auth_keys` (per-message keys) | Architecture pattern from ookamiiixd/baileys-api | Cleaner separation; creds are seldom-changing, keys rotate constantly |
| `baileys` npm package | `@whiskeysockets/baileys` | Package renamed in v7 | `baileys@latest` is v7 RC (ESM-only, broken auth) — stay on `@whiskeysockets/baileys` |

**Deprecated/outdated:**
- `useMultiFileAuthState`: Explicitly documented in Baileys source as "wouldn't endorse for production". [VERIFIED: `use-multi-file-auth-state.js` comment lines 26-27]
- `baileys` package name: Same codebase as `@whiskeysockets/baileys` but published under new name for v7 RC. [VERIFIED: STACK.md research from 2026-04-09]

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `dotenv` latest stable is ^16.x | Standard Stack | Wrong version pinned in package.json; minor — verify with `npm view dotenv version` |
| A2 | `needs_qr` is the preferred status value (vs `qr_pending` from PROJECT.md or `needs-QR` from success criteria) | Schema Pattern | Status value inconsistency between DB and API responses; naming-only issue, easy to fix |

**If this table is empty:** All other claims in this research were verified or cited — no user confirmation needed beyond A1 and A2.

---

## Open Questions

1. **`reps.status` naming: `needs_qr` vs `qr_pending`**
   - What we know: PROJECT.md uses `qr_pending`; roadmap success criteria says "needs-QR"; CONTEXT.md is silent
   - What's unclear: Which string the dashboard and later phases will expect
   - Recommendation: Pick one now and document it as the canonical value. This research uses `needs_qr`. The planner should lock this.

2. **`reps.id` type: UUID string vs auto-increment integer**
   - What we know: PROJECT.md says `id TEXT PRIMARY KEY`; ARCHITECTURE.md shows `id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text`
   - What's unclear: Whether the Neon instance has `pgcrypto` extension (needed for `gen_random_uuid()` on older PG)
   - Recommendation: Use `gen_random_uuid()::text` — built-in on PG 13+, and Neon runs PG 16. [ASSUMED: Neon uses PG 16 which has `gen_random_uuid()` built-in without pgcrypto]

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | v24.13.0 | — |
| PostgreSQL (Neon.tech) | DB layer | Unknown — external service | — | Must be configured; no fallback |
| `@whiskeysockets/baileys` | WhatsApp protocol | Yes (installed) | 6.7.21 | — |
| `pg` | DB driver | Yes (installed) | 8.13.0 | — |
| `pino` | Logging | Yes (installed) | 9.5.0 | — |
| `dotenv` | Env loading | Not installed | — | Can manually set env vars; install `dotenv` is simpler |

**Missing dependencies with no fallback:**
- PostgreSQL (Neon.tech): `DATABASE_URL` env var must be set before `db:init` runs. Planner should include a verification step confirming the env var is set.

**Missing dependencies with fallback:**
- `dotenv`: Not installed. If not installed, devs must `export DATABASE_URL=...` manually before each command. Install it.

**Note:** Node.js v24.13.0 is installed — Baileys 6.7.21 requires Node 20+. v24 satisfies this. [VERIFIED: `node --version`]

---

## Validation Architecture

> `.planning/config.json` does not exist. Treating `nyquist_validation` as enabled.

### Test Framework

Phase 1 delivers pure infrastructure (DB schema + Baileys auth state adapter). Manual verification is the primary validation approach — no automated test framework is required to implement or verify the four success criteria. The planner should include manual verification tasks:

1. Run `npm run db:init` — verify all 5 tables are created in Neon with `\dt` in psql
2. Run `npm run dev` with a valid `DATABASE_URL` — verify server starts, `SessionManager.resumeAll()` runs with no errors on empty reps table
3. Simulate a server restart after a rep has connected — verify no QR scan required (auth loaded from DB)
4. Trigger `loggedOut` disconnect manually (or simulate via `sock.logout()`) — verify `status = 'needs_qr'` in DB and no reconnect attempt fires

**Unit test candidates (not required for Phase 1, noted for future):**
- `usePgAuthState.get()` with `app-state-sync-key` type returns a protobuf object, not a plain object
- `handleReconnect()` with terminal reason does not schedule reconnect and updates DB status
- `handleReconnect()` with transient reason schedules reconnect with exponential delay

### Wave 0 Gaps
- No test framework installed or configured — acceptable for Phase 1 (infrastructure only)
- Planner should include manual smoke-test tasks rather than automated test file tasks

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No — Phase 1 has no user-facing auth | — |
| V3 Session Management | No — WhatsApp session management is handled by Baileys protocol | — |
| V4 Access Control | No — no API endpoints in Phase 1 | — |
| V5 Input Validation | Minimal — `repId` used in SQL queries | Parameterized queries only (`$1`, `$2`) — never string interpolation in SQL |
| V6 Cryptography | No — Signal protocol crypto is entirely inside Baileys | Never modify or wrap the Baileys crypto layer |

### Known Threat Patterns for This Phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via `repId` in auth state queries | Tampering | All queries use `$1`-style parameterized queries — enforced in `usePgAuthState` skeleton above |
| Credential leakage via structured logging | Information Disclosure | Pass `pino({ level: 'info' })` to `makeWASocket` — never log `creds` object or raw key values |
| `DATABASE_URL` exposure in logs | Information Disclosure | Log only that DB connected, never the connection string; `config.ts` should not log env var values |

---

## Sources

### Primary (HIGH confidence)
- `node_modules/@whiskeysockets/baileys/lib/Types/Auth.d.ts` — `SignalDataTypeMap`, `SignalKeyStore`, `AuthenticationState`, `AuthenticationCreds` types [VERIFIED]
- `node_modules/@whiskeysockets/baileys/lib/Types/index.d.ts` — `DisconnectReason` enum with all 10 values and numeric codes [VERIFIED]
- `node_modules/@whiskeysockets/baileys/lib/Socket/index.d.ts` — `sock.end(error: Error | undefined): void` and `sock.logout(msg?: string): Promise<void>` signatures [VERIFIED]
- `node_modules/@whiskeysockets/baileys/lib/Utils/use-multi-file-auth-state.js` — reference implementation; `app-state-sync-key` deserialization; null-means-delete pattern [VERIFIED]
- `node_modules/@whiskeysockets/baileys/lib/Utils/auth-utils.js` — `makeCacheableSignalKeyStore` implementation [VERIFIED]
- `node_modules/@whiskeysockets/baileys/lib/index.d.ts` — confirms all exports (`makeWASocket`, `DisconnectReason`, `BufferJSON`, `initAuthCreds`, `makeCacheableSignalKeyStore`, `proto`) [VERIFIED]
- `node_modules/@whiskeysockets/baileys/package.json` — version: 6.7.21 confirmed installed [VERIFIED]

### Secondary (MEDIUM confidence)
- `.planning/research/PITFALLS.md` — reconnect loop pitfall, Signal key race condition, Neon timeout — all cross-referenced against primary sources above
- `.planning/research/ARCHITECTURE.md` — `SessionManager` EventEmitter pattern, `usePgAuthState` skeleton, schema definitions — used as structural reference, all verified against Baileys types
- `.planning/research/STACK.md` — library version decisions, v7 ESM-only rationale — previously verified against npm registry

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages installed and versions verified from node_modules
- SignalKeyStore interface: HIGH — verified directly from installed `Auth.d.ts` and reference implementation
- DisconnectReason values: HIGH — verified directly from installed `Types/index.d.ts`
- `makeCacheableSignalKeyStore` availability: HIGH — verified from `auth-utils.js` and `Utils/index.d.ts`
- `sock.end()` / `sock.logout()` API: HIGH — verified from installed `Socket/index.d.ts`
- `dotenv` version: LOW (ASSUMED) — verify with `npm view dotenv version`

**Research date:** 2026-04-09
**Valid until:** 2026-07-09 (stable library; 90-day validity reasonable given Baileys 6.x is not actively changing)
