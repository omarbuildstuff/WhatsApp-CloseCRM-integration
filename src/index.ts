import express from 'express';
import { pool } from './db/pool';
import { sessionManager } from './whatsapp/sessionManager';
import { messageHandler } from './whatsapp/messageHandler';
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
    messageHandler.handle(repId, msg).catch((err) => {
      logger.error({ repId, err }, 'Error in message handler');
    });
  });
  logger.info('Message handler wired');

  // Minimal Express server (routes added in later phases)
  const app = express();
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
