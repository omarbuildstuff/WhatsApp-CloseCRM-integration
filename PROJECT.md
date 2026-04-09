# PROJECT: WhatsApp ↔ Close.com CRM Integration

## Overview
A self-hosted multi-rep WhatsApp integration for Close.com CRM that replicates the functionality of TimelinesAI ($25-50+/user/month) for near-zero cost. Each sales rep connects their own WhatsApp account via QR code scan, and all conversations sync to Close CRM as native WhatsApp Message activities.

## Goals
- **Replace TimelinesAI** — save $1,250-2,500/month at 50+ reps
- **Full chat visibility** — anyone in Close can click on a lead profile and see the complete WhatsApp conversation history
- **Native Close experience** — messages appear as real chat bubbles in the lead activity timeline (using Close's built-in WhatsApp Message activity type)
- **Two-way sync** — inbound WhatsApp messages sync to Close, outbound messages from Close send via the rep's WhatsApp
- **Lead tagging** — ALL conversations sync, but only phone numbers matching a Close contact are tagged as leads and get native Close activities

## Users
- **Sales reps (50+)** — connect their personal/business WhatsApp, see their own conversations in Close
- **Managers/supervisors** — can view any lead's WhatsApp conversations by clicking on the lead profile in Close
- **Admins** — manage rep connections via web dashboard

## Architecture Decisions

### WhatsApp Connection: Baileys (WhatsApp Web protocol)
- Each rep scans a QR code (like WhatsApp Web linked devices)
- Uses the `@whiskeysockets/baileys` library (same approach as TimelinesAI)
- Reps keep their WhatsApp app working — this is just another linked device
- Sessions persist in PostgreSQL so server restarts don't require re-scanning
- **Tradeoff**: This is not the official Meta Cloud API. It uses the WhatsApp Web multi-device protocol. This is technically against WhatsApp ToS but is widely used by commercial products (TimelinesAI, respond.io, etc.) and rarely enforced for normal usage patterns.

### Close.com Integration: Native WhatsApp Message Activity API
- Close has a built-in `/activity/whatsapp_message/` endpoint
- Messages appear as native chat bubbles in the lead timeline (just like emails, SMS, calls)
- Supports: direction (incoming/outgoing), markdown messages, file attachments, threading via `response_to_id`, inbox notifications via `send_to_inbox=true`
- Docs: https://developer.close.com/resources/activities/whatsappmessage/

### Database: PostgreSQL on Neon.tech (free tier)
- 0.5GB storage, always-on, $0/month
- Handles 50+ concurrent rep sessions
- Stores: rep configs, Baileys auth state, message history, phone-to-lead cache

### Hosting: Render.com (free tier or $7/mo)
- Node.js web service
- Handles webhooks + WebSocket connections

### Lead Matching Logic
- When a WhatsApp message arrives, extract the sender's phone number
- Search Close contacts by phone number (`GET /lead/?query=phone:{number}`)
- Cache lookups for 1 hour to avoid API rate limits
- If matched → create native WhatsApp Message activity on that lead + tag as lead
- If not matched → store in DB only, tag as non-lead

### Visibility Model
- All conversations from all reps sync (both lead and non-lead)
- Anyone in the Close org can see WhatsApp activities on any lead they have access to
- The dashboard shows all reps and their connection status

## Tech Stack
- **Runtime**: Node.js + TypeScript
- **WhatsApp**: `@whiskeysockets/baileys` (WhatsApp Web multi-device)
- **Database**: PostgreSQL (`pg` driver)
- **HTTP**: Express
- **Real-time**: WebSocket (`ws`) for QR code streaming to dashboard
- **QR codes**: `qrcode` library
- **Close API**: axios with basic auth

## Core Flows

### Flow 1: Rep Connects WhatsApp
1. Admin opens web dashboard, adds rep (name + optional Close user ID)
2. Admin clicks "Connect WhatsApp" → server starts Baileys session for that rep
3. QR code streams to dashboard via WebSocket
4. Rep scans QR with their phone (WhatsApp → Linked Devices)
5. Session established, auth state saved to PostgreSQL
6. Rep's status updates to "connected"

### Flow 2: Inbound Message (Customer → Rep → Close)
1. Customer sends WhatsApp message to rep's personal/business number
2. Baileys receives the message on the server
3. Extract sender phone number from chat JID
4. Look up phone in Close contacts (with 1-hour cache)
5. Store message in PostgreSQL (always, regardless of lead status)
6. If lead match found:
   a. Create native WhatsApp Message activity via `POST /activity/whatsapp_message/?send_to_inbox=true`
   b. Set `direction: "incoming"`, `external_whatsapp_message_id`, `message_markdown`
   c. Activity appears in lead timeline + Close inbox
7. If no match: store in DB, tag as non-lead

### Flow 3: Outbound Message (Rep replies from Close → WhatsApp)
1. Rep creates a WhatsApp Message activity on a lead in Close (direction: outgoing)
2. Close fires webhook to our server (`activity.whatsapp_message` → `created`)
3. Server checks: is this an outgoing message without an `external_whatsapp_message_id`? (meaning we didn't create it)
4. Look up the lead's phone number and the assigned rep
5. Send the message via the matched rep's Baileys session
6. Update the Close activity with the WhatsApp message ID

### Flow 4: Outbound via Dashboard (manual send)
1. User picks a rep, enters phone + message in dashboard
2. `POST /api/send` → sends via rep's Baileys session
3. Message stored in DB + synced to Close if phone matches a lead

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/dashboard` | — | Web dashboard HTML |
| GET | `/api/reps` | Bearer token | List all reps + status |
| POST | `/api/reps` | Bearer token | Add a new rep `{name, closeUserId?}` |
| POST | `/api/reps/:id/connect` | Bearer token | Start WhatsApp session (QR via WebSocket) |
| POST | `/api/reps/:id/disconnect` | Bearer token | Disconnect rep |
| POST | `/api/reps/:id/logout` | Bearer token | Logout + clear session data |
| POST | `/api/send` | Bearer token | Send message `{repId, phone, message}` |
| GET | `/api/reps/:id/chats/:phone` | Bearer token | Get chat history |
| GET | `/api/close/users` | Bearer token | List Close CRM users (for mapping) |
| POST | `/webhook/close` | — | Close.com webhook for outbound messages |
| WS | `/ws?repId=X&token=Y` | Query param | WebSocket for QR codes + status updates |

## Database Schema

### `reps` — Sales reps who have connected their WhatsApp
- id, name, phone (filled after QR scan), close_user_id, status (connected/disconnected/qr_pending)

### `wa_auth` — Baileys auth state (persists sessions across restarts)
- rep_id, key, value (JSONB)

### `messages` — All synced WhatsApp messages
- id, rep_id, wa_message_id, wa_chat_jid, remote_phone, direction, message_text, message_type
- is_lead, close_lead_id, close_contact_id, close_activity_id, synced_to_close, timestamp

### `close_phone_cache` — Phone number → lead/contact lookup cache
- phone, lead_id, contact_id, lead_name, is_lead, checked_at (expires after 1 hour)

## Environment Variables
- `CLOSE_API_KEY` — Close.com API key
- `DATABASE_URL` — PostgreSQL connection string (Neon.tech)
- `PORT` — Server port (default 3000)
- `BASE_URL` — Public URL for webhooks
- `DASHBOARD_PASSWORD` — Simple shared auth token for dashboard + API

## Dashboard UI
Single-page HTML dashboard (served by Express, no build step):
- Login with shared password
- List all reps with connection status (connected/disconnected/qr_pending)
- Add new rep (name input)
- Connect button → opens modal with live QR code via WebSocket
- Disconnect/logout buttons per rep
- Send message form (pick rep, enter phone + message)
- Dark theme, minimal design

## Constraints
- Close API rate limits: ~100 requests/minute — batch sync with delays
- WhatsApp Web sessions expire if rep's phone is offline for 14+ days
- Only 1:1 chats sync (no group chats for MVP)
- Text messages + basic media types (image, document, audio, video captions)
- Media files: download from WhatsApp, upload to Close via Files API, attach to activity

## Out of Scope (v1)
- Group chat syncing
- WhatsApp template messages / broadcast campaigns
- Read receipts / delivery status
- Admin role separation (everyone has same access for MVP)
- End-to-end encryption of stored messages
- Auto-assignment of new leads to reps
- Mobile app for dashboard

## Success Criteria
1. A rep can scan a QR code and connect their WhatsApp in under 60 seconds
2. When a lead messages a rep on WhatsApp, the message appears in the lead's Close timeline within 5 seconds
3. When a rep creates an outgoing WhatsApp activity in Close, the message is delivered to the customer's WhatsApp within 5 seconds
4. Sessions survive server restarts without re-scanning
5. 50+ simultaneous rep connections without degradation
6. Non-lead conversations are stored and retrievable but don't clutter Close
