import { EventEmitter } from 'events';
import makeWASocket, { DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import type { WASocket, Contact } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { usePgAuthState } from './authState';
import { normalizeJidToE164, storeLidMapping } from '../close/normalizeJid';
import { pool } from '../db/pool';
import pino from 'pino';

const MAX_RECONNECT_ATTEMPTS = 10;

const TERMINAL_REASONS = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.multideviceMismatch,
]);

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, WASocket>();
  private reconnectAttempts = new Map<string, number>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  private disconnecting = new Set<string>();
  private logger = pino({ level: 'info' });

  async connect(repId: string): Promise<void> {
    // Clear any pending reconnect timer to prevent stale timers from killing the new socket
    const pendingTimer = this.reconnectTimers.get(repId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.reconnectTimers.delete(repId);
    }
    this.reconnectAttempts.delete(repId);

    // Close existing socket if any
    const existing = this.sessions.get(repId);
    if (existing) {
      existing.end(undefined);
      this.sessions.delete(repId);
    }

    const { state, saveCreds } = await usePgAuthState(repId, this.logger);

    let version: [number, number, number] | undefined;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
      this.logger.info({ repId, version }, 'Fetched WA version');
    } catch (err) {
      this.logger.warn({ repId, err }, 'Failed to fetch WA version — using bundled default');
    }

    const sock = makeWASocket({
      auth: state,
      logger: this.logger.child({ repId }),
      browser: Browsers.ubuntu('WA-Close'),
      ...(version ? { version } : {}),
    });

    const handleConnectionUpdate = async (update: { connection?: string; lastDisconnect?: { error: Error | undefined }; qr?: string }) => {
      const { connection, lastDisconnect, qr } = update;

      this.logger.info(
        { repId, connection, hasQr: !!qr, updateKeys: Object.keys(update) },
        'connection.update received'
      );

      if (qr) {
        this.logger.info({ repId, qrLength: qr.length }, 'QR received from Baileys — emitting');
        this.emit('qr', { repId, qr });
      }

      if (connection === 'open') {
        this.logger.info({ repId }, 'Connection opened — marking as connected');
        this.reconnectAttempts.delete(repId);
        await pool.query("UPDATE reps SET status = 'connected' WHERE id = $1", [repId]);
        this.emit('status', { repId, status: 'connected' });

        // Bootstrap lid→phone mappings from known phone JIDs.
        this.bootstrapLidMappings(repId, sock).catch((err) => {
          this.logger.error({ repId, err }, 'lid bootstrap failed — non-fatal');
        });

        // Proactively establish Signal sessions with recent contacts
        // so messages sent from the phone app can be decrypted
        this.assertRecentSessions(repId, sock).catch((err) => {
          this.logger.error({ repId, err }, 'Session assertion failed — non-fatal');
        });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        this.logger.info({ repId, statusCode, error: lastDisconnect?.error?.message }, 'Connection closed');
        if (this.disconnecting.has(repId)) {
          this.disconnecting.delete(repId);
          this.logger.info({ repId }, 'User-initiated disconnect — skipping reconnect');
          return;
        }
        await this.handleReconnect(repId, lastDisconnect);
      }
    };

    sock.ev.on('connection.update', (update) => {
      handleConnectionUpdate(update).catch((err) => {
        this.logger.error({ repId, err }, 'Error in connection.update handler');
      });
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      this.logger.info({ repId, type, count: messages.length }, 'messages.upsert received');
      if (type === 'notify' || type === 'append') {
        for (const msg of messages) {
          this.logger.info({ repId, msgId: msg.key.id, from: msg.key.remoteJid, fromMe: msg.key.fromMe }, 'Emitting message event');
          this.emit('message', { repId, msg });
        }
      }
    });

    // Process history sync — captures messages sent from the phone app
    // These are already decrypted by the WhatsApp protocol layer
    sock.ev.on('messaging-history.set', ({ messages: historyMessages, syncType }) => {
      if (!historyMessages?.length) return;
      // Only process messages from last 24 hours to avoid flooding
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recent = historyMessages.filter((msg) => {
        const ts = msg.messageTimestamp
          ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp.toNumber())
          : 0;
        return ts * 1000 > cutoff;
      });
      this.logger.info({ repId, syncType, total: historyMessages.length, recent: recent.length }, 'History sync received — processing recent messages');
      for (const msg of recent) {
        this.emit('message', { repId, msg });
      }
    });

    // Populate lid→phone mapping from Baileys contact sync.
    // When WhatsApp pushes contact info, entries may contain both the
    // phone-based JID (contact.id = "phone@s.whatsapp.net") and the
    // linked-device JID (contact.lid = "xxx@lid"). Storing this mapping
    // allows resolveJidToE164() to handle inbound @lid messages.
    sock.ev.on('contacts.upsert', (contacts: Contact[]) => {
      for (const contact of contacts) {
        const lid = contact.lid;
        if (contact.id?.endsWith('@s.whatsapp.net') && lid?.endsWith('@lid')) {
          const phoneE164 = normalizeJidToE164(contact.id);
          if (phoneE164) {
            storeLidMapping(lid, phoneE164).catch((err) => {
              this.logger.error({ err, lid }, 'Failed to store lid→phone mapping');
            });
          }
        }
      }
    });

    this.sessions.set(repId, sock);
    this.logger.info({ repId }, 'Session created, listeners registered');
  }

  private async handleReconnect(
    repId: string,
    lastDisconnect?: { error: Error | undefined }
  ): Promise<void> {
    const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

    // Terminal branch — stop reconnecting and clear auth
    if (statusCode !== undefined && TERMINAL_REASONS.has(statusCode)) {
      this.logger.warn({ repId, statusCode }, 'Terminal disconnect — marking as needs_qr');
      await pool.query("UPDATE reps SET status = 'needs_qr' WHERE id = $1", [repId]);
      await this.clearAuthState(repId);
      this.sessions.delete(repId);
      this.emit('status', { repId, status: 'needs_qr' });
      return;
    }

    // Verify credentials exist before attempting reconnect
    const credsExist = await pool.query(
      'SELECT 1 FROM wa_auth_creds WHERE rep_id = $1', [repId]
    );
    if (credsExist.rows.length === 0) {
      this.logger.warn({ repId, statusCode }, 'No credentials in DB — cannot reconnect, marking needs_qr');
      await pool.query("UPDATE reps SET status = 'needs_qr' WHERE id = $1", [repId]);
      this.sessions.delete(repId);
      this.emit('status', { repId, status: 'needs_qr' });
      return;
    }

    // Reconnect branch — exponential backoff
    const attempt = this.reconnectAttempts.get(repId) ?? 0;

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.warn({ repId, attempt }, 'Max reconnect attempts reached — marking as needs_qr');
      await pool.query("UPDATE reps SET status = 'needs_qr' WHERE id = $1", [repId]);
      await this.clearAuthState(repId);
      this.sessions.delete(repId);
      this.emit('status', { repId, status: 'needs_qr' });
      return;
    }

    let delayMs = Math.min(2000 * Math.pow(2, attempt), 60_000);

    // Per research Pitfall 2: give restartRequired a minimum delay so saveCreds completes
    if (statusCode === DisconnectReason.restartRequired) {
      delayMs = Math.max(delayMs, 500);
    }

    this.reconnectAttempts.set(repId, attempt + 1);
    this.logger.info({ repId, statusCode, attempt: attempt + 1, delayMs }, 'Scheduling reconnect');

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(repId);
      this.connect(repId);
    }, delayMs);
    this.reconnectTimers.set(repId, timer);
  }

  async resumeAll(): Promise<void> {
    // Only reconnect reps that were actively connected — not user-disconnected or needs_qr
    const { rows } = await pool.query(
      "SELECT id FROM reps WHERE status = 'connected'"
    );
    this.logger.info({ count: rows.length }, 'Resuming rep sessions');
    for (const row of rows) {
      try {
        await this.connect(row.id);
      } catch (err) {
        this.logger.error({ repId: row.id, err }, 'Failed to resume session — skipping');
      }
    }
  }

  async disconnect(repId: string): Promise<void> {
    const timer = this.reconnectTimers.get(repId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(repId);
    }
    this.disconnecting.add(repId);
    const sock = this.sessions.get(repId);
    if (sock) {
      sock.end(undefined);
      this.sessions.delete(repId);
    }
    await pool.query("UPDATE reps SET status = 'disconnected' WHERE id = $1", [repId]);
    this.reconnectAttempts.delete(repId);
  }

  async logout(repId: string): Promise<void> {
    const timer = this.reconnectTimers.get(repId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(repId);
    }
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

  private async clearAuthState(repId: string): Promise<void> {
    await pool.query('DELETE FROM wa_auth_keys WHERE rep_id = $1', [repId]);
    await pool.query('DELETE FROM wa_auth_creds WHERE rep_id = $1', [repId]);
  }

  /**
   * Bootstrap lid→phone mappings by calling onWhatsApp() for known phone JIDs.
   * Runs once after each connection open. Non-fatal on failure.
   */
  private async bootstrapLidMappings(repId: string, sock: WASocket): Promise<void> {
    const { rows } = await pool.query<{ phone_e164: string }>(
      `SELECT DISTINCT phone_e164 FROM messages
       WHERE rep_id = $1 AND phone_e164 IS NOT NULL
       LIMIT 200`,
      [repId]
    );
    if (rows.length === 0) return;

    this.logger.info({ repId, phoneCount: rows.length }, 'Bootstrapping lid mappings from known phones');

    // Batch into groups of 20 to avoid overloading WhatsApp
    const batchSize = 20;
    let mapped = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const jids = batch.map(r => r.phone_e164.replace('+', '') + '@s.whatsapp.net');
      try {
        const results = await (sock as any).onWhatsApp(...jids);
        if (Array.isArray(results)) {
          for (const entry of results) {
            if (entry.lid && entry.jid) {
              const phoneE164 = normalizeJidToE164(entry.jid);
              if (phoneE164) {
                await storeLidMapping(entry.lid, phoneE164);
                mapped++;
              }
            }
          }
        }
      } catch (err) {
        this.logger.warn({ repId, err }, 'onWhatsApp batch failed — continuing');
      }
    }
    this.logger.info({ repId, mapped, total: rows.length }, 'lid bootstrap complete');
  }

  /**
   * Proactively establish Signal sessions with recent contacts so that
   * messages sent from the primary phone app can be decrypted by Baileys.
   */
  private async assertRecentSessions(repId: string, sock: WASocket): Promise<void> {
    const { rows } = await pool.query<{ phone_e164: string }>(
      `SELECT DISTINCT phone_e164 FROM messages
       WHERE rep_id = $1 AND phone_e164 IS NOT NULL
       LIMIT 200`,
      [repId]
    );
    if (rows.length === 0) return;

    const jids = rows.map(r => r.phone_e164.replace('+', '') + '@s.whatsapp.net');
    this.logger.info({ repId, contactCount: jids.length }, 'Asserting Signal sessions with recent contacts');

    // Batch into groups of 50
    for (let i = 0; i < jids.length; i += 50) {
      const batch = jids.slice(i, i + 50);
      try {
        const fetched = await sock.assertSessions(batch, false);
        this.logger.info({ repId, batch: batch.length, newSessions: fetched }, 'Session assertion batch complete');
      } catch (err) {
        this.logger.warn({ repId, err }, 'assertSessions batch failed — continuing');
      }
    }
  }

  /**
   * Resolve an @lid JID to E.164 by querying the live Baileys socket.
   * Called as a fallback when lid_phone_map has no entry.
   * Returns null if resolution fails or no session is active.
   */
  async resolveLidJid(repId: string, lidJid: string): Promise<string | null> {
    const sock = this.sessions.get(repId);
    if (!sock) return null;

    try {
      // Use onWhatsApp with the lid JID — some Baileys versions support this
      const results = await (sock as any).onWhatsApp(lidJid);
      if (Array.isArray(results) && results.length > 0) {
        const entry = results[0];
        if (entry.jid) {
          const phoneE164 = normalizeJidToE164(entry.jid);
          if (phoneE164) {
            await storeLidMapping(lidJid, phoneE164);
            return phoneE164;
          }
        }
      }
    } catch (err) {
      this.logger.debug({ repId, lidJid, err }, 'Live lid resolution failed');
    }
    return null;
  }

  getSession(repId: string): WASocket | undefined {
    return this.sessions.get(repId);
  }
}

export const sessionManager = new SessionManager();
