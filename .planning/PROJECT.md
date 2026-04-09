# WhatsApp ↔ Close.com CRM Integration

## What This Is

A self-hosted multi-rep WhatsApp integration for Close.com CRM that replaces TimelinesAI ($25-50+/user/month) for near-zero cost. Each sales rep connects their own WhatsApp account via QR code scan, and all conversations sync to Close CRM as native WhatsApp Message activities.

## Core Value

When a lead messages a rep on WhatsApp, the full conversation appears in the lead's Close timeline as native chat bubbles — giving the entire sales team instant visibility without switching tools.

## Current Milestone: v1.0 WhatsApp-Close Integration MVP

**Goal:** Replace TimelinesAI with a self-hosted multi-rep WhatsApp ↔ Close CRM sync

**Target features:**
- Multi-rep WhatsApp connections via QR code (Baileys)
- Inbound message sync to Close as native WhatsApp Message activities
- Outbound message sending from Close via webhook → WhatsApp
- Lead matching with phone number cache
- PostgreSQL-backed session persistence
- Web dashboard for rep management + QR scanning
- REST API + WebSocket for real-time QR streaming

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Multi-rep WhatsApp connections via QR code
- [ ] Inbound WhatsApp → Close sync as native activities
- [ ] Outbound Close → WhatsApp message delivery
- [ ] Phone number → lead matching with 1-hour cache
- [ ] PostgreSQL session persistence (survives restarts)
- [ ] Web dashboard for rep management
- [ ] REST API with Bearer token auth
- [ ] WebSocket for live QR code streaming

### Out of Scope

- Group chat syncing — complexity, not needed for MVP
- WhatsApp template messages / broadcast campaigns — not core flow
- Read receipts / delivery status — nice-to-have, not essential
- Admin role separation — shared access for MVP
- End-to-end encryption of stored messages — not required
- Auto-assignment of new leads to reps — manual for MVP
- Mobile app for dashboard — web-only for MVP

## Context

- **Domain:** Sales CRM integration for WhatsApp messaging
- **Existing solution:** TimelinesAI at $25-50+/user/month (50+ reps = $1,250-2,500/month)
- **WhatsApp approach:** Baileys (WhatsApp Web multi-device protocol) — same approach as TimelinesAI, technically against WhatsApp ToS but widely used commercially
- **Close API:** Native WhatsApp Message activity type (`/activity/whatsapp_message/`) with chat bubble rendering
- **Database:** PostgreSQL on Neon.tech (free tier, 0.5GB)
- **Hosting target:** Render.com (free tier or $7/mo)

## Constraints

- **Tech stack**: Node.js + TypeScript, Express, PostgreSQL — already initialized
- **Close API rate limits**: ~100 requests/minute — must batch sync with delays and cache lookups
- **WhatsApp sessions**: Expire if rep's phone offline 14+ days
- **Media types**: Text + basic media (image, document, audio, video captions) only
- **Dashboard**: Single HTML file served by Express — no frontend build step
- **Auth state**: Must persist in PostgreSQL, not filesystem (container compatibility)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Baileys over Meta Cloud API | No per-message cost, same approach as TimelinesAI, reps use existing numbers | — Pending |
| PostgreSQL for auth state | Container-compatible, survives restarts, Neon.tech free tier | — Pending |
| Single HTML dashboard | No build step, fast iteration, minimal complexity | — Pending |
| Bearer token auth (shared password) | Simple for MVP, all users same access level | — Pending |
| 1-hour phone lookup cache | Balances freshness with Close API rate limits | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-09 after milestone v1.0 initialization*
