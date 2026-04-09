# CLAUDE.md

## Project Context
This is a WhatsApp ↔ Close.com CRM integration built with Node.js + TypeScript. It uses Baileys (WhatsApp Web multi-device protocol) to connect individual sales reps' WhatsApp accounts and sync conversations to Close CRM as native WhatsApp Message activities.

## Key Technical References
- Close WhatsApp Message API: https://developer.close.com/resources/activities/whatsappmessage/
- Close API auth: Basic auth with API key as username, empty password
- Baileys library: `@whiskeysockets/baileys` — WhatsApp Web multi-device
- Database: PostgreSQL on Neon.tech (use `?sslmode=require` in connection string)

## Commands
- `npm run dev` — Start with hot reload (tsx watch)
- `npm run build` — Compile TypeScript
- `npm start` — Run compiled JS
- `npm run db:init` — Initialize database schema

## Architecture Rules
- All Baileys auth state MUST persist in PostgreSQL (not filesystem) for container compatibility
- Phone number lookups against Close API MUST use the 1-hour cache to respect rate limits
- All WhatsApp messages MUST be stored in the DB regardless of lead status
- Only lead-matched messages get synced to Close as native WhatsApp activities
- WebSocket is used for QR code streaming — NOT polling
- Dashboard is a single HTML file served by Express — no frontend build step
- The Close webhook handler must check for `external_whatsapp_message_id` to avoid infinite loops (we create outgoing activities that would re-trigger the webhook)

## Git Commit Rules
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`
- All subagent/executor commits MUST use `--no-verify`
