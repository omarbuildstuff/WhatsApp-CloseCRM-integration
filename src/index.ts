import * as http from 'http';
import express from 'express';
import { pool } from './db/pool';
import { sessionManager } from './whatsapp/sessionManager';
import { messageHandler } from './whatsapp/messageHandler';
import { handleCloseWebhook } from './close/webhookHandler';
import { createDashboardRouter, setupWebSocket } from './dashboard';
import { config } from './config';
import pino from 'pino';

const logger = pino({ level: 'info' });

async function main() {
  // Verify DB connectivity
  await pool.query('SELECT 1');
  logger.info('Database connected');

  // Wire inbound message handler BEFORE resuming sessions
  // to avoid dropping messages that arrive during reconnection
  sessionManager.on('message', ({ repId, msg }) => {
    void messageHandler.handle(repId, msg);
  });
  logger.info('Message handler wired');

  // Restore all rep sessions from DB
  await sessionManager.resumeAll();
  logger.info('Sessions restored');

  const app = express();

  // Close webhook — MUST be before express.json() to preserve raw body for HMAC verification
  app.post(
    '/webhook/close',
    express.raw({ type: 'application/json' }),
    (req, res) => {
      handleCloseWebhook(req, res).catch((err) => {
        logger.error({ err }, 'Webhook handler threw unexpectedly');
        if (!res.headersSent) res.status(500).end();
      });
    }
  );

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Dashboard router (GET /, /api/*) — mounted after express.json()
  app.use(createDashboardRouter());

  const server = http.createServer(app);
  setupWebSocket(server);
  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'Server started');
  });

  return server;
}

export const server = main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
