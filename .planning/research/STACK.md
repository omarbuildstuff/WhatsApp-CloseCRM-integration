# Stack Research

**Domain:** WhatsApp ↔ Close CRM integration (Node.js backend, multi-rep messaging sync)
**Researched:** 2026-04-09
**Confidence:** HIGH (verified against npm registry and official docs)

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 20.x LTS | Runtime | Baileys requires Node 20+; LTS has longest support window |
| TypeScript | 5.9.x (installed) | Type safety | Already initialized; strict mode catches integration contract errors early |
| `@whiskeysockets/baileys` | 6.7.21 (installed) | WhatsApp Web protocol | Only mature CJS-compatible stable release; v7 is ESM-only RC with critical auth bugs |
| Express | 4.22.x (installed) | HTTP server + webhook handler | Stay on v4 for MVP; v5 has breaking route-syntax changes that add risk with no benefit here |
| `pg` (node-postgres) | 8.20.x (installed) | PostgreSQL client | Battle-tested Neon-compatible driver; Pool mode required for serverless-style Neon connections |
| `ws` | 8.20.x (installed) | WebSocket server | QR code streaming to dashboard; already Baileys dependency — no extra cost |
| `pino` | 9.14.x (installed) | Structured logging | Used by Baileys internally; consistent JSON log format across all components |
| `axios` | 1.15.x (installed) | HTTP client for Close API | Promise-based, interceptor support for rate-limit handling and auth header injection |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `qrcode` | 1.5.4 (installed) | QR code image generation | Convert Baileys QR string to base64 PNG for WebSocket streaming to dashboard |
| `pino-http` | ^11.0.0 | Express request logging | Add as middleware for structured HTTP request/response logs; pairs with installed pino |
| `dotenv` | ^17.x | Environment variable loading | Load `DATABASE_URL`, `CLOSE_API_KEY`, `AUTH_TOKEN` from `.env` at startup |

### Development Tools

| Tool | Version | Purpose | Notes |
|------|---------|---------|-------|
| `tsx` | 4.21.x (installed) | TypeScript execution + watch | Powers `npm run dev`; esbuild-based, no transpile step; use `tsx watch src/index.ts` |
| `typescript` | 5.9.x (installed) | Type checker + compiler | `npm run build` via `tsc`; `ES2022` target + `commonjs` module — must stay CJS for Baileys 6.x |
| `@types/express` | ^4.17.21 (installed) | Express type definitions | — |
| `@types/pg` | ^8.11.x (installed) | pg type definitions | — |
| `@types/ws` | ^8.5.x (installed) | ws type definitions | — |
| `@types/qrcode` | ^1.5.x (installed) | qrcode type definitions | — |
| `@types/node` | ^22.x (installed) | Node.js built-in types | — |

---

## Critical Version Decision: Baileys 6.x vs 7.x

**Stay on `@whiskeysockets/baileys@6.7.21` for this milestone.**

Baileys 7.0.0 is in RC (rc.9 as of research date) and has three confirmed blockers for this project:

1. **Auth breakage**: RC.9 has a 100% connection failure bug — every connection attempt fails with `401 Unauthorized - device_removed` in a reconnect loop (confirmed in WhiskeySockets/Baileys issues).
2. **ESM-only**: v7 dropped CommonJS entirely. The project uses `"module": "commonjs"` in tsconfig, which is required for the current Express + pg + qrcode ecosystem. Converting to ESM mid-project adds significant risk with no feature gain.
3. **Buffer serialization regression**: RC.6+ serializes Buffers as `{type: 'Buffer', data: [...]}` instead of actual Buffers, breaking PostgreSQL auth state storage without workarounds.

The `@whiskeysockets/baileys` package name is deprecated in favor of `baileys` — but `baileys@latest` IS the same v7 RC. Do not migrate until v7 is stable and the project is ready to convert to ESM.

---

## Installation

```bash
# Already installed — verify versions match
npm install

# Add these missing supporting libraries
npm install pino-http dotenv

# Dev dependencies already installed
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `@whiskeysockets/baileys` 6.x | Meta Cloud API | When you need official ToS compliance, template messages at scale, or WABA number (not personal rep numbers) |
| `@whiskeysockets/baileys` 6.x | `baileys` 7.x RC | When v7 reaches stable and project is ready for ESM migration (post-MVP) |
| `pg` Pool | `@neondatabase/serverless` | When deploying to edge/serverless (Cloudflare Workers, Vercel Edge) — not Render.com |
| Express 4.x | Express 5.x | After MVP stabilizes; v5 adds async error handling automatically but has breaking route-syntax changes |
| `axios` | `node-fetch` / native `fetch` | If removing all CJS constraints; axios interceptors are more ergonomic for rate-limit retry logic |
| `pino` | `winston` | Never for this project — pino is faster, used by Baileys internally, JSON-native |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `baileys` (npm package) | This IS Baileys v7 RC — ESM-only, has critical auth bugs as of rc.9 | `@whiskeysockets/baileys@6.7.21` |
| `whatsapp-web.js` | Puppeteer-based (headless Chrome), ~300MB extra overhead, not multi-device ready | `@whiskeysockets/baileys` |
| ORM (Prisma, TypeORM, Drizzle) | Baileys auth state requires raw SQL for JSONB storage with custom key serialization; ORM adds abstraction that fights this | Raw `pg` Pool with typed query functions |
| `socket.io` | Overkill for single-purpose QR streaming; brings in a heavy client bundle | Raw `ws` — already installed as Baileys dependency |
| `pm2` in Docker/Render | Render manages process lifecycle; pm2 inside container creates process management conflicts | Let Node process crash and let Render restart |
| `morgan` | Not JSON-native; conflicts with pino's structured output | `pino-http` middleware |
| `nodemon` | tsx watch is faster (esbuild) and already configured | `tsx watch` via `npm run dev` |

---

## Integration Points Between Components

### Baileys ↔ PostgreSQL Auth State

Baileys 6.x `useMultiFileAuthState` writes to filesystem. For PostgreSQL, implement a custom auth state function that matches the same interface:

```typescript
// Interface Baileys expects (v6.x)
interface AuthStateStore {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}
```

Store credentials as JSONB in a `baileys_auth_state` table, keyed by `(rep_id, key_name)`. The `saveCreds` callback fires on every credential change — write directly to PostgreSQL via the `pg` Pool.

### Close API ↔ Rate Limiting

Close allows ~100 req/min. The phone-number-to-lead lookup is the primary rate-limit target. Cache responses in a PostgreSQL `lead_cache` table with `expires_at` (1 hour TTL). On cache miss, call `GET /lead/?query=...` with the E.164 phone number. On 429, back off with exponential delay via axios interceptor.

### WhatsApp Messages ↔ Infinite Loop Prevention

When this service creates a Close outbound WhatsApp activity (via webhook), Close fires another webhook event for that same activity. Prevent re-processing by:
1. Storing the `external_whatsapp_message_id` on every created activity
2. In the Close webhook handler, check if the incoming event has a non-null `external_whatsapp_message_id` — if yes, it was created by this service, skip it

### QR Code ↔ WebSocket ↔ Dashboard

Baileys emits a `connection.update` event with a `qr` string. Encode it to base64 PNG via `qrcode.toDataURL()`, then push the result over `ws` to the connected dashboard client. The dashboard holds one WebSocket connection per active QR request. Use rep_id as the WebSocket message identifier.

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@whiskeysockets/baileys@6.7.21` | `ws@8.x`, `pino@9.x` | Baileys ships its own ws — your ws version is only for the dashboard WebSocket server |
| `pg@8.20.x` | Neon.tech (any tier) | Use `?sslmode=require` in connection string OR `ssl: { rejectUnauthorized: false }` in Pool config |
| `express@4.22.x` | `@types/express@4.17.x` | Do not install `@types/express@5.x` while on Express 4 — type mismatch causes silent issues |
| `typescript@5.9.x` | `tsx@4.21.x` | tsx uses esbuild internally — TypeScript version only matters for type checking, not execution |
| `pino@9.x` | `pino-http@11.x` | pino-http v11 requires pino v9+; compatible |

---

## Node.js Version Note

Baileys 6.7.x officially requires Node.js 20+. The Render.com free tier and Neon.tech both support Node 20. Confirm `engines` in package.json is set:

```json
"engines": { "node": ">=20.0.0" }
```

---

## Sources

- npm registry `@whiskeysockets/baileys` — version 6.7.21 is latest stable 6.x; dist-tag `latest` points to 7.0.0-rc.9
- npm registry `baileys` — confirms `baileys@latest` = 7.0.0-rc.9 (same codebase, new package name)
- [Baileys v7 Migration Guide](https://baileys.wiki/docs/migration/to-v7.0.0) — ESM-only, auth state new keys (`lid-mapping`, `device-list`, `tctoken`), `isJidUser` removed
- [WhiskeySockets/Baileys GitHub Issues](https://github.com/WhiskeySockets/Baileys/issues/2090) — RC.9 auth 401 connection failure bug confirmed
- [Neon.tech Node.js Connection Guide](https://neon.com/docs/guides/node) — `sslmode=require`, Pool vs direct connections
- [Express 5.0 Release](https://expressjs.com/en/guide/migrating-5.html) — breaking route syntax changes; requires Node 18+
- npm registry `pg@8.20.0`, `express@4.22.1`, `axios@1.15.0`, `ws@8.20.0`, `pino@9.14.0`, `tsx@4.21.0`, `typescript@5.9.3`, `pino-http@11.0.0` — all confirmed via registry
- [Close WhatsApp API](https://developer.close.com/resources/activities/whatsappmessage/) — `external_whatsapp_message_id` field for deduplication; Basic auth with API key as username

---

*Stack research for: WhatsApp ↔ Close CRM integration*
*Researched: 2026-04-09*
