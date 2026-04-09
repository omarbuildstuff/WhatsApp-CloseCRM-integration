import express from 'express';
import { pool } from './db/pool';
import { sessionManager } from './whatsapp/sessionManager';
import { messageHandler } from './whatsapp/messageHandler';
import { handleCloseWebhook } from './close/webhookHandler';
import { config } from './config';
import pino from 'pino';

const logger = pino({ level: 'info' });

async function main() {
  // Verify DB connectivity
  await pool.query('SELECT 1');
  logger.info('Database connected');

  // Restore all rep sessions from DB
  await sessionManager.resumeAll();
  logger.info('Sessions restored');

  // Wire inbound message handler
  sessionManager.on('message', ({ repId, msg }) => {
    // handle() catches and logs all processing errors internally
    void messageHandler.handle(repId, msg);
  });
  logger.info('Message handler wired');

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

  app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Server started');
  });
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
