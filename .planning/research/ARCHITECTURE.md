# Architecture Research

**Domain:** Multi-rep WhatsApp ↔ Close CRM integration (Node.js + TypeScript)
**Researched:** 2026-04-09
**Confidence:** HIGH (architecture dictated by project constraints and well-understood tool APIs)

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                                │
│  ┌───────────────────┐          ┌──────────────────────────────┐    │
│  │  Browser Dashboard │          │     Close CRM Webhook         │    │
│  │  (single HTML)     │          │  POST /webhook/close          │    │
│  └────────┬──────────┘          └──────────────┬───────────────┘    │
│           │ HTTP + WebSocket                    │ HTTP POST          │
└───────────┼────────────────────────────────────┼────────────────────┘
            │                                    │
┌───────────┼────────────────────────────────────┼────────────────────┐
│           ▼              EXPRESS SERVER         ▼                    │
│  ┌─────────────────┐    ┌──────────────────────────────────────┐    │
│  │  WebSocket Server│    │  REST API Routes                     │    │
│  │  (ws library)    │    │  /api/reps, /api/send, /api/history  │    │
│  │  QR streaming    │    │  Bearer token auth middleware         │    │
│  └────────┬─────────┘    └─────────────────┬────────────────────┘   │
│           │                                │                        │
│           └────────────────┬───────────────┘                        │
│                            │                                        │
├────────────────────────────┼────────────────────────────────────────┤
│                    SERVICE LAYER                                     │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │  SessionManager  │  │  SyncEngine      │  │  CloseApiClient  │   │
│  │  (Baileys)       │  │  (msg handler)   │  │  + PhoneCache    │   │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │                     │                      │            │
│     WA events              glue layer             Close REST API    │
│     creds.update           orchestrates            HTTP (axios)     │
│     messages.upsert        all flows                                │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                     DATA LAYER                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              PostgreSQL (Neon.tech)                           │   │
│  │  reps | wa_auth_keys | messages | close_phone_cache           │   │
│  └──────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│                    EXTERNAL SERVICES                                 │
│  ┌───────────────────────┐      ┌───────────────────────────────┐   │
│  │  WhatsApp Web          │      │  Close CRM REST API           │   │
│  │  (Baileys WS protocol) │      │  api.close.com                │   │
│  └───────────────────────┘      └───────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Key Interfaces |
|-----------|----------------|----------------|
| `SessionManager` | One Baileys socket per rep; lifecycle (connect/disconnect/reconnect); PG auth state; QR emission | `connect(repId)`, `disconnect(repId)`, `send(repId, jid, text)`, EventEmitter `qr`, `status` |
| `CloseApiClient` | HTTP wrapper for Close REST API; basic auth; activity creation; file upload; lead lookup | `findLeadByPhone(e164)`, `createWhatsAppActivity(payload)`, `uploadFile(buf)` |
| `PhoneCache` | In-memory + PG-backed 1-hour TTL cache for phone→lead lookups | `lookup(phone): LeadInfo \| null` — wraps CloseApiClient |
| `SyncEngine` | Handles inbound WA message events → DB → Close; outbound Close webhook → WA send; dedup via `external_whatsapp_message_id` | `handleInbound(repId, msg)`, `handleOutbound(closePayload)` |
| `Express REST API` | CRUD for reps, message send, chat history, Close webhook receiver; Bearer auth middleware | HTTP routes, middleware |
| `WebSocket Server` | Streams QR code updates and connection status to dashboard browser tab per rep | Upgraded from HTTP server; session keyed by repId query param |
| `DB Layer` | PostgreSQL pool + typed query helpers; schema init script | `db.query()`, `db.init()` |

## Recommended Project Structure

```
src/
├── index.ts                  # Entry point: wires everything together, starts Express + WS
├── config.ts                 # Loads env vars, validates required fields
├── db/
│   ├── pool.ts               # pg Pool singleton
│   ├── schema.ts             # CREATE TABLE statements (run by db:init)
│   └── queries.ts            # Typed query helpers (reps, messages, auth_keys, cache)
├── whatsapp/
│   ├── sessionManager.ts     # Multi-session Baileys manager (the core)
│   ├── authState.ts          # PostgreSQL-backed auth state (replaces useMultiFileAuthState)
│   └── messageParser.ts      # Normalises Baileys WAMessage → internal Message type
├── close/
│   ├── client.ts             # Axios-based Close REST API client (basic auth)
│   ├── phoneCache.ts         # 1-hour TTL phone → lead cache (in-memory + PG persistence)
│   └── types.ts              # Close API response types
├── sync/
│   └── engine.ts             # SyncEngine: inbound WA → Close, outbound Close → WA
├── api/
│   ├── middleware.ts          # Bearer token auth, request logging
│   ├── reps.ts               # GET/POST/DELETE /api/reps, connect/disconnect actions
│   ├── messages.ts           # POST /api/send, GET /api/history/:repId
│   └── webhook.ts            # POST /webhook/close — Close outbound trigger
├── ws/
│   └── server.ts             # WebSocket server: QR streaming + status events
└── dashboard/
    └── index.html            # Single-file dashboard (served by Express static)
```

### Structure Rationale

- **`db/`:** Isolates all SQL. `pool.ts` is a singleton imported everywhere. `schema.ts` keeps table definitions co-located with the module that owns them.
- **`whatsapp/`:** Baileys is complex and stateful. Isolating `authState.ts` from `sessionManager.ts` keeps the PG persistence concern separate from the connection lifecycle concern.
- **`close/`:** All outbound Close API calls live here. `phoneCache.ts` wraps `client.ts` and is the only place phone lookups happen — prevents accidental cache bypass.
- **`sync/`:** `engine.ts` is deliberately thin: it calls into `whatsapp/`, `close/`, and `db/` but owns the data flow logic. This is the hardest module to test so keep it pure (no Express, no WS concerns).
- **`api/`:** Express routes are thin controllers — they validate input, call `sync/engine.ts` or `whatsapp/sessionManager.ts`, and return responses. No business logic here.
- **`ws/`:** WebSocket server is separate from Express routes but shares the same HTTP server via `server.on('upgrade', ...)`.
- **`dashboard/`:** Served as a static file by Express. No build step. Communicates via REST + WebSocket.

## Architectural Patterns

### Pattern 1: PostgreSQL-Backed Baileys Auth State

**What:** Replaces Baileys' `useMultiFileAuthState` (file-based, not safe for production) with a PostgreSQL implementation following the same interface: `{ state: AuthenticationState, saveCreds: () => Promise<void> }`.

**When to use:** Always — file-based auth state corrupts under concurrent writes and doesn't survive container restarts.

**Trade-offs:** Slightly more complex to implement once; eliminates session loss on deploy.

**Schema:**
```sql
-- Stores Baileys signal protocol keys per rep
CREATE TABLE wa_auth_keys (
  rep_id    TEXT    NOT NULL,
  key_type  TEXT    NOT NULL,  -- e.g. 'pre-key', 'session', 'app-state-sync-key'
  key_id    TEXT    NOT NULL,
  value     JSONB   NOT NULL,
  PRIMARY KEY (rep_id, key_type, key_id)
);

-- Stores the creds object (registration, keys, account info) per rep
CREATE TABLE wa_auth_creds (
  rep_id  TEXT PRIMARY KEY,
  creds   JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Interface skeleton:**
```typescript
// authState.ts
export async function usePgAuthState(repId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // Load creds from wa_auth_creds
  // Build keys object that reads/writes wa_auth_keys
  // Return { state: { creds, keys }, saveCreds }
}
```

### Pattern 2: SessionManager as EventEmitter Registry

**What:** `SessionManager` holds a `Map<repId, WASocket>` and emits typed events (`qr`, `status`, `message`) that both the WebSocket server and SyncEngine subscribe to. No direct coupling between Baileys and Express/WS layers.

**When to use:** Required for multi-rep — each rep has their own socket lifecycle but shared infrastructure (DB, Close client).

**Trade-offs:** EventEmitter is simple but untyped by default. Use typed wrapper or `EventEmitter<Events>` pattern.

**Skeleton:**
```typescript
// sessionManager.ts
class SessionManager extends EventEmitter {
  private sessions = new Map<string, WASocket>();

  async connect(repId: string): Promise<void> {
    const { state, saveCreds } = await usePgAuthState(repId);
    const sock = makeWASocket({ auth: state, ... });

    sock.ev.on('connection.update', ({ qr, connection }) => {
      if (qr) this.emit('qr', { repId, qr });
      if (connection === 'open') this.emit('status', { repId, status: 'connected' });
      if (connection === 'close') this.handleReconnect(repId);
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) this.emit('message', { repId, msg });
    });

    this.sessions.set(repId, sock);
  }

  async resumeAll(): Promise<void> {
    // Load all active reps from DB, call connect() for each
  }
}
```

### Pattern 3: Close Webhook Idempotency Guard

**What:** When we create an outbound WhatsApp activity in Close (because a rep sent a message via WhatsApp), Close fires a webhook back to us for that same `activity.created` event. We must check `external_whatsapp_message_id` to detect this loop and skip processing.

**When to use:** Every time the `/webhook/close` route receives a payload.

**Trade-offs:** Simple string check. No Redis needed — the `external_whatsapp_message_id` field presence is sufficient.

```typescript
// webhook.ts
router.post('/webhook/close', async (req, res) => {
  const { data } = req.body;
  // If we set external_whatsapp_message_id, we created this — skip it
  if (data?.external_whatsapp_message_id) {
    return res.sendStatus(200); // acknowledge, do nothing
  }
  // Otherwise this is a rep-authored outbound message → send via WhatsApp
  await syncEngine.handleOutbound(data);
  res.sendStatus(200);
});
```

### Pattern 4: PhoneCache Wraps All Close Lookups

**What:** All phone → lead lookups go through `PhoneCache`. No code calls `closeClient.findLeadByPhone()` directly. Cache is in-memory (Map) with 1-hour TTL. Cache misses hit Close API and populate the store.

**When to use:** Every inbound message processing path.

**Trade-offs:** In-process cache is lost on restart. Acceptable because the cost of a cache miss is just one Close API call, not data loss.

```typescript
// phoneCache.ts
class PhoneCache {
  private cache = new Map<string, { lead: LeadInfo | null; expires: number }>();

  async lookup(e164: string): Promise<LeadInfo | null> {
    const hit = this.cache.get(e164);
    if (hit && hit.expires > Date.now()) return hit.lead;
    const lead = await closeClient.searchLeadByPhone(e164);
    this.cache.set(e164, { lead, expires: Date.now() + 60 * 60 * 1000 });
    return lead;
  }
}
```

## Data Flow

### Flow 1: Inbound WhatsApp Message → Close Activity

```
WhatsApp server
    │ (Baileys WS connection, per rep)
    ▼
SessionManager.emit('message', { repId, rawMsg })
    │
    ▼
SyncEngine.handleInbound(repId, rawMsg)
    │
    ├─► messageParser.parse(rawMsg)          → internal Message object
    │
    ├─► PhoneCache.lookup(senderE164)        → LeadInfo | null
    │
    ├─► db.insertMessage(msg, leadId)        → always stored (is_lead flag set)
    │
    └─► if (leadId)
            CloseApiClient.createWhatsAppActivity({
              lead_id, direction: 'incoming',
              external_whatsapp_message_id: msg.id,
              text, attachments, ...
            })
```

### Flow 2: Outbound Close → WhatsApp Send

```
Close CRM rep clicks Send (WhatsApp activity UI)
    │
    ▼
POST /webhook/close  { data: { lead_id, text, ... } }
    │
    ├─► Check: data.external_whatsapp_message_id present?
    │       YES → return 200 (loop guard, skip)
    │       NO  → continue
    │
    ├─► Resolve rep WhatsApp number from lead → repId mapping
    │
    ├─► SessionManager.send(repId, recipientJid, text)
    │       → Baileys sock.sendMessage(jid, { text })
    │
    ├─► db.insertMessage(msg, leadId, direction='outgoing')
    │
    └─► CloseApiClient.createWhatsAppActivity({
              direction: 'outgoing',
              external_whatsapp_message_id: baileys_msg_id,
              ...
            })
        (This triggers a webhook, but loop guard catches it)
```

### Flow 3: Rep Connect (QR Code Scan)

```
Dashboard: POST /api/reps/:id/connect
    │
    ▼
SessionManager.connect(repId)
    │
    ├─► usePgAuthState(repId)        → loads creds from DB (or empty if new)
    ├─► makeWASocket({ auth: state })
    ├─► sock.ev.on('connection.update')
    │       QR emitted → SessionManager.emit('qr', { repId, qr })
    │                           │
    │                           ▼
    │               WebSocketServer broadcasts to
    │               all WS clients subscribed to repId
    │                           │
    │                           ▼
    │               Dashboard renders QR modal
    │
    └─► Rep scans QR → WhatsApp forces reconnect
            → connection === 'open'
            → SessionManager.emit('status', { repId, status: 'connected' })
            → creds.update → saveCreds() → DB updated
```

### Flow 4: Server Restart Recovery

```
index.ts startup
    │
    ▼
SessionManager.resumeAll()
    │
    ├─► db.query('SELECT id FROM reps WHERE active = true')
    │
    └─► for each repId:
            SessionManager.connect(repId)
                │
                ├─► usePgAuthState(repId) → loads existing creds from DB
                └─► makeWASocket → reconnects WITHOUT QR (creds still valid)
```

### Key Data in PostgreSQL

```sql
-- Active reps and their Close user mapping
CREATE TABLE reps (
  id          TEXT PRIMARY KEY,        -- internal UUID
  name        TEXT NOT NULL,
  close_user_id TEXT,                  -- maps to Close CRM user
  wa_phone    TEXT,                    -- E.164 after first connection
  active      BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- All WhatsApp messages (lead-matched or not)
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,    -- Baileys message ID
  rep_id          TEXT NOT NULL,
  direction       TEXT NOT NULL,       -- 'incoming' | 'outgoing'
  wa_jid          TEXT NOT NULL,       -- contact's WhatsApp JID
  phone_e164      TEXT,               -- normalised phone
  lead_id         TEXT,               -- Close lead_id (null if no match)
  close_activity_id TEXT,             -- set after successful Close sync
  body            TEXT,
  media_type      TEXT,               -- 'text'|'image'|'document'|'audio'|'video'
  media_url       TEXT,               -- Close file URL after upload
  timestamp       TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Phone number → Close lead lookup cache (for persistence across restarts)
CREATE TABLE close_phone_cache (
  phone_e164  TEXT PRIMARY KEY,
  lead_id     TEXT,                   -- null means "known non-lead"
  lead_name   TEXT,
  cached_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Baileys signal keys per rep
CREATE TABLE wa_auth_keys (
  rep_id    TEXT NOT NULL,
  key_type  TEXT NOT NULL,
  key_id    TEXT NOT NULL,
  value     JSONB NOT NULL,
  PRIMARY KEY (rep_id, key_type, key_id)
);

-- Baileys credentials (account identity) per rep
CREATE TABLE wa_auth_creds (
  rep_id     TEXT PRIMARY KEY,
  creds      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| WhatsApp Web | Baileys long-lived WebSocket per rep | Each socket is ~20 MB RAM; reconnects on drop; 14-day session expiry if phone offline |
| Close REST API | Axios with Basic auth (API key as username, empty password) | ~100 req/min rate limit; use 1-hour phone cache; retry on 429 |
| Neon.tech PostgreSQL | `pg` Pool with `?sslmode=require` | Single pool shared across modules; max 10 connections on free tier |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| SessionManager → SyncEngine | EventEmitter (`message` event) | Decouples Baileys from Close sync logic; SyncEngine subscribes once at startup |
| SessionManager → WS Server | EventEmitter (`qr`, `status` events) | WS server subscribes and broadcasts to relevant browser clients |
| SyncEngine → CloseApiClient | Direct function call | SyncEngine owns the Close call; CloseApiClient is stateless |
| SyncEngine → PhoneCache | Direct function call | PhoneCache is a singleton; all lookups go through it |
| API routes → SessionManager | Direct function call | Routes call `sessionManager.connect/disconnect/send` synchronously |
| API routes → SyncEngine | Direct function call | `sendFromClose()` for the manual send endpoint |
| Express HTTP Server → WS Server | `server.on('upgrade', ...)` | Same TCP port for HTTP and WS; ws library handles upgrade |

## Build Order (Dependency Graph)

Build in this order — each phase has no unresolved dependencies on later phases:

```
Phase 1: DB Layer
    config.ts → db/pool.ts → db/schema.ts → db/queries.ts
    (No external dependencies beyond pg driver)

Phase 2: Close API Client
    close/types.ts → close/client.ts → close/phoneCache.ts
    (Depends on: config for API key, axios — no internal deps)

Phase 3: Baileys Session Manager
    whatsapp/authState.ts  ← depends on db/queries.ts
    whatsapp/messageParser.ts  ← no deps
    whatsapp/sessionManager.ts ← depends on authState, messageParser, db/queries
    (Baileys auth state requires DB Layer)

Phase 4: Sync Engine
    sync/engine.ts ← depends on sessionManager, closeClient, phoneCache, db/queries
    (Must come after Phases 2 and 3 are both complete)

Phase 5: REST API + WebSocket
    ws/server.ts ← depends on sessionManager (subscribes to events)
    api/middleware.ts ← no internal deps
    api/reps.ts ← depends on sessionManager, db/queries
    api/messages.ts ← depends on syncEngine, db/queries
    api/webhook.ts ← depends on syncEngine
    (Must come after Phase 4)

Phase 6: Dashboard
    dashboard/index.html ← no TypeScript deps; calls REST + WS
    (Can be built in parallel with Phase 5)

Phase 7: Hardening
    Retry logic in close/client.ts, graceful shutdown in index.ts
    (Wraps all prior phases)
```

**Critical dependency:** Baileys auth state (Phase 3) requires `db/queries.ts` from Phase 1. You cannot build the session manager without the DB layer. The roadmap correctly orders these: DB → Close client → Baileys → Sync → API → Dashboard.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1-10 reps | Current monolith is correct. All sessions in one process. |
| 10-50 reps | Monitor RAM (each Baileys socket ≈ 20 MB). 50 reps ≈ 1 GB. Consider Render.com paid tier. |
| 50-100 reps | Close API rate limits become the bottleneck. Add a request queue with rate limiter (e.g., p-queue). |
| 100+ reps | Session sharding across multiple processes. Requires external message bus (Redis pub/sub or pg LISTEN/NOTIFY). Out of scope for v1. |

### Scaling Priorities

1. **First bottleneck (50+ reps):** RAM for Baileys sockets + Neon free tier connection limit (10 connections). Mitigation: Reduce pg pool size to 5, use Neon's connection pooler (PgBouncer).
2. **Second bottleneck (high message volume):** Close API rate limits at ~100 req/min. Mitigation: Queue `createWhatsAppActivity` calls with p-queue, batch phone lookups.

## Anti-Patterns

### Anti-Pattern 1: Using `useMultiFileAuthState` in Production

**What people do:** Call `useMultiFileAuthState('auth_info_baileys')` because it's the example in Baileys docs.

**Why it's wrong:** Writes JSON files to disk on every message. Files corrupt under concurrent access. Breaks in containers where the filesystem is ephemeral. Baileys docs explicitly warn against this for production.

**Do this instead:** Implement PostgreSQL-backed auth state using `wa_auth_keys` and `wa_auth_creds` tables. Use `makeCacheableSignalKeyStore` to wrap the keys object for performance.

### Anti-Pattern 2: Calling Close Phone Lookup on Every Message

**What people do:** Call `GET /contact/?query=phone:+1234567890` for every inbound WhatsApp message.

**Why it's wrong:** At 100 messages/minute, Close API rate limits (100 req/min) are exhausted entirely by phone lookups, leaving no budget for activity creation.

**Do this instead:** All phone lookups go through `PhoneCache` with a 1-hour TTL. Cache both hits (known leads) and misses (known non-leads) to avoid re-querying unknown numbers.

### Anti-Pattern 3: Skipping the `external_whatsapp_message_id` Loop Guard

**What people do:** Receive Close webhook for activity.created, immediately send to WhatsApp, create a new Close activity — which fires another webhook, causing infinite messages.

**Why it's wrong:** Outbound loop fires indefinitely, creates duplicate messages, and hits rate limits instantly.

**Do this instead:** Check `data.external_whatsapp_message_id` at webhook entry. If set, we created this activity — return 200 immediately without processing.

### Anti-Pattern 4: Tight Coupling Between Baileys and Express Routes

**What people do:** Call `sock.sendMessage()` directly from an Express route handler, or put `sock.ev.on('messages.upsert')` inside route files.

**Why it's wrong:** Multi-rep sessions require a registry (Map). Routes shouldn't hold references to individual sockets. Impossible to handle reconnection cleanly.

**Do this instead:** All socket access goes through `SessionManager`. Routes call `sessionManager.send(repId, ...)`. Events flow via EventEmitter. SessionManager owns the `Map<repId, WASocket>`.

### Anti-Pattern 5: Polling for QR Codes

**What people do:** Dashboard polls `GET /api/reps/:id/qr` every second to get the latest QR code.

**Why it's wrong:** QR codes rotate every ~20 seconds. Polling misses rotations, creates unnecessary load, and adds latency. Baileys emits `connection.update` with a new QR string in real time.

**Do this instead:** WebSocket push from `SessionManager`'s `qr` event → WS server → browser. Dashboard renders QR on first WebSocket message, updates on subsequent ones.

## Sources

- [Baileys Introduction / Auth State](https://baileys.wiki/docs/intro/) — confirms `useMultiFileAuthState` is demo-only, custom DB implementation required
- [Baileys Connecting / connection.update](https://baileys.wiki/docs/socket/connecting/) — QR code flow, forced reconnect after scan, `DisconnectReason.restartRequired`
- [Baileys npm package](https://www.npmjs.com/package/@whiskeysockets/baileys) — version and signal key management details
- [BaileysAuth library](https://github.com/rzkytmgr/baileysauth) — PostgreSQL auth state reference; KEY/VALUE/JID schema pattern
- [ookamiiixd/baileys-api](https://github.com/ookamiiixd/baileys-api) — multi-session REST API reference implementation
- [Close WhatsApp Message API](https://developer.close.com/resources/activities/whatsappmessage/) — `external_whatsapp_message_id`, `direction`, activity fields
- [Close Webhook Subscriptions](https://developer.close.com/resources/webhook-subscriptions/) — webhook payload structure, event types
- [ws library](https://github.com/websockets/ws) — WebSocket server, HTTP upgrade pattern

---
*Architecture research for: Multi-rep WhatsApp ↔ Close CRM integration*
*Researched: 2026-04-09*
