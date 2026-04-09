# How to Build This with GSD

## Prerequisites
1. Install Claude Code: `npm install -g @anthropic-ai/claude-code`
2. Install GSD: `npx gsd-install`
3. Have your Close API key and a free Neon.tech PostgreSQL database ready

## Steps

```bash
# 1. Clone/create this project folder
cd wa-close-gsd

# 2. Open Claude Code
claude

# 3. GSD already has PROJECT.md, CLAUDE.md, and .planning/roadmap.md
#    Skip straight to planning the first phase:
/gsd:plan-phase 1

# 4. Execute it:
/gsd:execute-phase 1

# 5. Verify:
/gsd:verify-phase 1

# 6. Move to next phase:
/gsd:plan-phase 2
/gsd:execute-phase 2
# ... repeat through all 7 phases

# Or run it all autonomously:
/gsd:autonomous
```

## What GSD Will Build (7 Phases)
1. **Foundation** — Project setup, DB schema, config
2. **Close API Client** — Phone lookup, WhatsApp activity CRUD, caching
3. **Baileys Session Manager** — Multi-rep WhatsApp Web connections
4. **Sync Engine** — Message flow: WA → DB → Close (and reverse)
5. **REST API + WebSocket** — Endpoints, auth, QR streaming
6. **Dashboard** — Single HTML page for rep management
7. **Hardening** — Retry logic, graceful shutdown, deployment docs

## Files Included
- `PROJECT.md` — Full project spec (all requirements, flows, API design, schema)
- `CLAUDE.md` — Technical context for Claude Code
- `.planning/roadmap.md` — 7-phase breakdown with verification criteria
- `package.json` — Dependencies pre-configured
- `tsconfig.json` — TypeScript config
- `.env.example` — Environment variables needed
