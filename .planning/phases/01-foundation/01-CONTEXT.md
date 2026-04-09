# Phase 1: Foundation - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

Sessions persist across server restarts and reconnect correctly without risking a ban. This phase delivers the PostgreSQL schema, Baileys auth state persistence in PostgreSQL, and the SessionManager with correct reconnect logic.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use ROADMAP phase goal, success criteria, and codebase conventions to guide decisions.

Key constraints from project research:
- Never use useMultiFileAuthState — PostgreSQL-backed auth state is mandatory from day one
- Stay on @whiskeysockets/baileys@6.7.21 — v7 RC has confirmed 100% connection failure bug
- The custom usePgAuthState implementation requires study of Baileys internal Signal key store interface before implementation — verify exact key types Baileys 6.7.x writes

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- No src/ directory exists yet — all code must be created from scratch
- package.json has all dependencies: @whiskeysockets/baileys, pg, express, pino, ws, qrcode, axios

### Established Patterns
- TypeScript with strict mode, ES2022 target, CommonJS modules
- Output to dist/, source in src/
- tsx for dev (watch mode), tsc for build
- db:init script expected at src/db-init.ts

### Integration Points
- DATABASE_URL configured for Neon.tech PostgreSQL with sslmode=require
- Port 3000, Express server
- Five schema tables expected: reps, messages, wa_auth_keys, wa_auth_creds, close_phone_cache

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Refer to ROADMAP phase description and success criteria.

</specifics>

<deferred>
## Deferred Ideas

None — infrastructure phase.

</deferred>
