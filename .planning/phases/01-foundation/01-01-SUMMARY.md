---
phase: 01-foundation
plan: 01
subsystem: database-and-auth
tags: [postgresql, baileys, auth-state, schema, neon]
dependency_graph:
  requires: []
  provides: [db-schema, pg-pool, baileys-auth-state]
  affects: [all-future-phases]
tech_stack:
  added: [dotenv@16.x]
  patterns: [pg-pool-singleton, parameterized-sql, baileys-signal-key-store, upsert-conflict]
key_files:
  created:
    - src/config.ts
    - src/db/pool.ts
    - src/db/schema.ts
    - src/db-init.ts
    - src/whatsapp/authState.ts
  modified:
    - .env.example
    - package.json
decisions:
  - "Use rejectUnauthorized: false for Neon SSL to avoid cert chain issues on Render"
  - "makeCacheableSignalKeyStore wraps rawStore to reduce DB round-trips for hot Signal keys"
  - "app-state-sync-key deserialization via proto.Message.AppStateSyncKeyData.fromObject() is mandatory — missing it causes silent WhatsApp sync failures"
metrics:
  duration_seconds: 93
  completed_date: "2026-04-09"
  tasks_completed: 2
  tasks_total: 2
  files_created: 5
  files_modified: 2
---

# Phase 01 Plan 01: PostgreSQL Foundation and Baileys Auth State Summary

**One-liner:** PostgreSQL-backed Baileys auth state via `usePgAuthState` with 5-table schema, Signal key UPSERT/DELETE, app-state-sync-key protobuf deserialization, and transaction safety.

## What Was Built

### Task 1: Config, Pool, Schema, and db-init (commit: 6761da7)

- `src/config.ts` — typed config with `required('DATABASE_URL')` helper that throws on missing env vars; loads via `import 'dotenv/config'`; never logs env var values
- `src/db/pool.ts` — `pg.Pool` singleton with Neon-compatible SSL (`rejectUnauthorized: false`), max=10 connections, 10s idle timeout, 5s connect timeout, error handler
- `src/db/schema.ts` — `createSchema()` creates all 5 tables: `reps`, `wa_auth_keys`, `wa_auth_creds`, `messages`, `close_phone_cache` — all with `CREATE TABLE IF NOT EXISTS` (idempotent)
- `src/db-init.ts` — standalone script (`npm run db:init`) that runs schema creation then closes pool
- `.env.example` — updated to remove `BASE_URL`, match config fields

### Task 2: usePgAuthState Adapter (commit: 56fb012)

- `src/whatsapp/authState.ts` — exports `usePgAuthState(repId, logger?)` implementing Baileys `AuthenticationState` interface
  - Loads creds from `wa_auth_creds` or calls `initAuthCreds()` for new reps
  - `get()`: queries `wa_auth_keys`, applies `proto.Message.AppStateSyncKeyData.fromObject()` for `app-state-sync-key` type (critical for WhatsApp app state sync)
  - `set()`: wraps all key writes/deletes in a `BEGIN`/`COMMIT`/`ROLLBACK` transaction; `null` values DELETE the row
  - Wraps `rawStore` with `makeCacheableSignalKeyStore(rawStore, logger)` to reduce DB round-trips
  - `saveCreds()`: UPSERTs serialized creds to `wa_auth_creds`

## Verification Results

All 4 plan verification checks passed:
1. `npx tsx src/db-init.ts` — exits 0, prints "Schema initialized successfully."
2. `npm run build` — TypeScript compiles with zero errors
3. `npx tsx -e "import { usePgAuthState } from './src/whatsapp/authState'; console.log('OK');"` — prints "OK"
4. `pool.query('SELECT COUNT(*) FROM reps')` — prints "reps table exists, count: 0"

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all files have real implementations wired to live Neon PostgreSQL.

## Threat Flags

No new security surface beyond what was modeled in the plan's threat register.

## Self-Check: PASSED

Files verified:
- src/config.ts: FOUND
- src/db/pool.ts: FOUND
- src/db/schema.ts: FOUND
- src/db-init.ts: FOUND
- src/whatsapp/authState.ts: FOUND
- .env.example: FOUND (updated)

Commits verified:
- 6761da7 (Task 1): FOUND
- 56fb012 (Task 2): FOUND
