import { EventEmitter } from 'events';
import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { usePgAuthState } from './authState';
import { pool } from '../db/pool';
import pino from 'pino';

const MAX_RECONNECT_ATTEMPTS = 10;

const TERMINAL_REASONS = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.connectionReplaced,
  DisconnectReason.multideviceMismatch,
  DisconnectReason.forbidden,
]);

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, WASocket>();
  private reconnectAttempts = new Map<string, number>();
  private logger = pino({ level: 'info' });

  async connect(repId: string): Promise<void> {
    // Close existing socket if any
    const existing = this.sessions.get(repId);
    if (existing) {
      existing.end(undefined);
      this.sessions.delete(repId);
    }

    const { state, saveCreds } = await usePgAuthState(repId, this.logger);

    const sock = makeWASocket({
      auth: state,
      logger: this.logger.child({ repId }),
      printQRInTerminal: false,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.emit('qr', { repId, qr });
      }

      if (connection === 'open') {
        this.reconnectAttempts.delete(repId);
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

    // Reconnect branch — exponential backoff
    const attempt = this.reconnectAttempts.get(repId) ?? 0;

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.warn({ repId, attempt }, 'Max reconnect attempts reached — marking as disconnected');
      await pool.query("UPDATE reps SET status = 'disconnected' WHERE id = $1", [repId]);
      this.sessions.delete(repId);
      this.emit('status', { repId, status: 'disconnected' });
      return;
    }

    let delayMs = Math.min(2000 * Math.pow(2, attempt), 60_000);

    // Per research Pitfall 2: give restartRequired a minimum delay so saveCreds completes
    if (statusCode === DisconnectReason.restartRequired) {
      delayMs = Math.max(delayMs, 500);
    }

    this.reconnectAttempts.set(repId, attempt + 1);
    this.logger.info({ repId, statusCode, attempt: attempt + 1, delayMs }, 'Scheduling reconnect');

    setTimeout(() => this.connect(repId), delayMs);
  }

  async resumeAll(): Promise<void> {
    // Only reconnect 'connected' or 'disconnected' reps — never 'needs_qr' (per Pitfall 4)
    const { rows } = await pool.query(
      "SELECT id FROM reps WHERE status IN ('connected', 'disconnected')"
    );
    this.logger.info({ count: rows.length }, 'Resuming rep sessions');
    for (const row of rows) {
      await this.connect(row.id);
    }
  }

  async disconnect(repId: string): Promise<void> {
    const sock = this.sessions.get(repId);
    if (sock) {
      sock.end(undefined);
      this.sessions.delete(repId);
    }
    await pool.query("UPDATE reps SET status = 'disconnected' WHERE id = $1", [repId]);
    this.reconnectAttempts.delete(repId);
  }

  async logout(repId: string): Promise<void> {
    const sock = this.sessions.get(repId);
    if (sock) {
      await sock.logout();
      this.sessions.delete(repId);
    }
    await this.clearAuthState(repId);
    await pool.query("UPDATE reps SET status = 'needs_qr' WHERE id = $1", [repId]);
    this.reconnectAttempts.delete(repId);
  }

  private async clearAuthState(repId: string): Promise<void> {
    await pool.query('DELETE FROM wa_auth_keys WHERE rep_id = $1', [repId]);
    await pool.query('DELETE FROM wa_auth_creds WHERE rep_id = $1', [repId]);
  }

  getSession(repId: string): WASocket | undefined {
    return this.sessions.get(repId);
  }
}

export const sessionManager = new SessionManager();
