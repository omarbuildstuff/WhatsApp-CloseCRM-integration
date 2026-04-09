import 'dotenv/config';
import { pool } from './db/pool';
import { createSchema } from './db/schema';

async function main(): Promise<void> {
  console.log('Initializing database schema...');
  await createSchema();
  console.log('Schema initialized successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('db:init failed:', err);
  process.exit(1);
});
