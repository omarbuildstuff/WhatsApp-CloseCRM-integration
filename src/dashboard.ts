import express, { type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import path from 'path';
import * as http from 'http';
import pino from 'pino';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { toDataURL } from 'qrcode';
import { jidEncode } from '@whiskeysockets/baileys';
import { config } from './config';
import { closeClient } from './close/client';
import { pool } from './db/pool';
import { sessionManager } from './whatsapp/sessionManager';

const logger = pino({ level: 'info' });

/**
 * Broadcast a JSON payload to all connected WebSocket clients.
 */
function broadcast(wss: WebSocketServer, payload: object): void {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * Set up the WebSocket server on an existing http.Server instance.
 * The WebSocket endpoint is /ws?token=<dashboardPassword>.
 * Token validation uses timingSafeEqual to prevent timing attacks (T-05-06).
 */
export function setupWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const rawUrl = request.url ?? '';
    const url = new URL(rawUrl, 'http://localhost');

    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token') ?? '';
    const expected = config.dashboardPassword;

    // timingSafeEqual requires same-length buffers — length mismatch is an immediate 401
    if (Buffer.byteLength(token, 'utf8') !== Buffer.byteLength(expected, 'utf8')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const tokenBuf = Buffer.from(token, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');

    if (!timingSafeEqual(tokenBuf, expectedBuf)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    logger.info('WebSocket client connected');
    ws.on('close', () => {
      logger.info('WebSocket client disconnected');
    });
  });

  // Wire SessionManager 'qr' events → convert to PNG data URL → broadcast (T-05-08)
  sessionManager.on('qr', async ({ repId, qr }: { repId: string; qr: string }) => {
    logger.info({ repId, qrLength: qr.length }, 'QR event received from sessionManager');
    try {
      const dataUrl = await toDataURL(qr);
      logger.info({ repId, clientCount: wss.clients.size }, 'Broadcasting QR to WS clients');
      broadcast(wss, { type: 'qr', repId, dataUrl });
    } catch (err) {
      logger.error({ repId, err }, 'Failed to generate QR data URL');
    }
  });

  // Wire SessionManager 'status' events → broadcast
  sessionManager.on('status', ({ repId, status }: { repId: string; status: string }) => {
    logger.info({ repId, status, clientCount: wss.clients.size }, 'Broadcasting status update');
    broadcast(wss, { type: 'status', repId, status });
  });

  logger.info('WebSocket server set up on /ws');
}

/**
 * Bearer token middleware that uses crypto.timingSafeEqual to prevent
 * timing side-channel attacks (T-05-01).
 */
export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice('Bearer '.length);
  const expected = config.dashboardPassword;

  // timingSafeEqual requires same-length buffers — length mismatch is an immediate 401
  if (Buffer.byteLength(token, 'utf8') !== Buffer.byteLength(expected, 'utf8')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const tokenBuf = Buffer.from(token, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  if (!timingSafeEqual(tokenBuf, expectedBuf)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

/**
 * Create and return the dashboard Express Router.
 *
 * Route structure:
 *   GET /           — serve dashboard.html (public — HTML has its own login screen)
 *   /api/*          — all routes protected by requireBearer
 *     GET  /api/reps            — list all reps
 *     POST /api/reps            — create a new rep
 *     DELETE /api/reps/:id      — logout session then delete rep
 *     POST /api/reps/:id/connect    — trigger QR flow for rep
 *     POST /api/reps/:id/disconnect — disconnect rep session
 *     POST /api/send            — send a WhatsApp message via a rep
 */
export function createDashboardRouter(): express.Router {
  const router = express.Router();

  // ── Public route ───────────────────────────────────────────────────────────

  router.get('/', (_req, res) => {
    res.sendFile(path.resolve(process.cwd(), 'src', 'dashboard.html'));
  });

  // ── Protected API routes ───────────────────────────────────────────────────

  const apiRouter = express.Router();
  apiRouter.use(requireBearer);

  // GET /api/reps — list all reps with status (T-05-03 gated by requireBearer)
  apiRouter.get('/reps', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, name, close_user_id, wa_phone, status, created_at FROM reps ORDER BY name'
      );
      res.json(rows);
    } catch (err) {
      logger.error({ err }, 'GET /api/reps failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/reps — create a new rep (name + email → auto-resolve Close user ID)
  apiRouter.post('/reps', async (req, res) => {
    try {
      const { name, email, wa_phone } = req.body as {
        name?: unknown;
        email?: unknown;
        wa_phone?: unknown;
      };

      if (!name || typeof name !== 'string' || name.trim() === '') {
        res.status(400).json({ error: 'name is required and must be a non-empty string' });
        return;
      }

      // Resolve Close user ID from email
      let closeUserId: string | null = null;
      if (email && typeof email === 'string' && email.trim()) {
        const user = await closeClient.findUserByEmail(email.trim());
        if (!user) {
          res.status(400).json({ error: `No Close user found for email: ${email.trim()}` });
          return;
        }
        closeUserId = user.userId;
        logger.info({ email: email.trim(), closeUserId }, 'Resolved Close user from email');
      }

      const { rows } = await pool.query(
        'INSERT INTO reps (name, close_user_id, wa_phone, status) VALUES ($1, $2, $3, $4) RETURNING *',
        [
          name.trim(),
          closeUserId,
          wa_phone && typeof wa_phone === 'string' ? wa_phone.trim() || null : null,
          'needs_qr',
        ]
      );

      res.status(201).json(rows[0]);
    } catch (err) {
      logger.error({ err }, 'POST /api/reps failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/reps/:id — logout Baileys session then delete rep row (T-05-05)
  // CRITICAL: sessionManager.logout() MUST be called before DELETE FROM reps
  // to prevent orphaned sessions and FK violations (RESEARCH Pitfall 4)
  apiRouter.delete('/reps/:id', async (req, res) => {
    const repId = req.params.id;
    try {
      const { rowCount } = await pool.query('SELECT 1 FROM reps WHERE id = $1', [repId]);
      if (!rowCount) {
        res.status(404).json({ error: 'Rep not found' });
        return;
      }

      // Step 1: Logout Baileys session BEFORE deleting the DB row
      await sessionManager.logout(repId);

      // Step 2: Delete messages referencing this rep (FK constraint)
      await pool.query('DELETE FROM messages WHERE rep_id = $1', [repId]);

      // Step 3: Delete rep row after session and messages are cleaned up
      await pool.query('DELETE FROM reps WHERE id = $1', [repId]);

      logger.info({ repId }, 'Rep deleted');
      res.json({ ok: true });
    } catch (err) {
      logger.error({ repId, err }, 'DELETE /api/reps/:id failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/reps/:id/connect — trigger the QR flow for a rep
  // Baileys will emit 'qr' events which are broadcast via WebSocket
  apiRouter.post('/reps/:id/connect', async (req, res) => {
    try {
      const repId = req.params.id;
      const { rowCount } = await pool.query('SELECT 1 FROM reps WHERE id = $1', [repId]);
      if (!rowCount) {
        res.status(404).json({ error: 'Rep not found' });
        return;
      }
      await sessionManager.connect(repId);
      logger.info({ repId }, 'Connect initiated — QR events via WebSocket');
      res.json({ ok: true });
    } catch (err) {
      logger.error({ repId: req.params.id, err }, 'POST /api/reps/:id/connect failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/reps/:id/disconnect — disconnect a rep session
  apiRouter.post('/reps/:id/disconnect', async (req, res) => {
    try {
      const repId = req.params.id;
      const { rowCount } = await pool.query('SELECT 1 FROM reps WHERE id = $1', [repId]);
      if (!rowCount) {
        res.status(404).json({ error: 'Rep not found' });
        return;
      }
      await sessionManager.disconnect(repId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ repId: req.params.id, err }, 'POST /api/reps/:id/disconnect failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/send — send a WhatsApp message via a rep session (T-05-07)
  apiRouter.post('/send', async (req, res) => {
    try {
      const { repId, phone, message } = req.body as {
        repId?: unknown;
        phone?: unknown;
        message?: unknown;
      };

      // Validate all fields are present and non-empty
      if (
        !repId || typeof repId !== 'string' || repId.trim() === '' ||
        !phone || typeof phone !== 'string' || phone.trim() === '' ||
        !message || typeof message !== 'string' || message.trim() === ''
      ) {
        res.status(400).json({ error: 'repId, phone, and message are required' });
        return;
      }

      // Get the active session for this rep
      const sock = sessionManager.getSession(repId.trim());
      if (!sock) {
        res.status(409).json({ error: 'Rep has no active session' });
        return;
      }

      // Normalize phone number: strip non-digits (T-05-07)
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) {
        res.status(400).json({ error: 'Invalid phone number — must be 7-15 digits' });
        return;
      }

      // Build WhatsApp JID and send message (with 30s timeout — first message
      // to a new contact needs ~15s for Signal session establishment)
      const jid = jidEncode(digits, 's.whatsapp.net');
      logger.info({ repId: repId.trim(), jid }, 'Sending message via Baileys');
      const result = await Promise.race([
        sock.sendMessage(jid, { text: message.trim() }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Send timed out — try again')), 30_000)
        )
      ]);
      logger.info({ repId: repId.trim(), messageId: result?.key?.id }, 'Message sent');

      res.json({ ok: true, messageId: result?.key?.id ?? null });
    } catch (err) {
      logger.error({ err }, 'POST /api/send failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.use('/api', apiRouter);

  return router;
}
