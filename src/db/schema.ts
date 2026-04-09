import { pool } from './pool';

export async function createSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reps (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      name TEXT NOT NULL,
      close_user_id TEXT,
      wa_phone TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_auth_keys (
      rep_id TEXT NOT NULL,
      key_type TEXT NOT NULL,
      key_id TEXT NOT NULL,
      value JSONB NOT NULL,
      PRIMARY KEY (rep_id, key_type, key_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_auth_creds (
      rep_id TEXT PRIMARY KEY,
      creds JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      rep_id TEXT NOT NULL REFERENCES reps(id),
      direction TEXT NOT NULL,
      wa_jid TEXT NOT NULL,
      phone_e164 TEXT,
      lead_id TEXT,
      close_activity_id TEXT,
      body TEXT,
      media_type TEXT,
      media_url TEXT,
      timestamp TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS close_phone_cache (
      phone_e164 TEXT PRIMARY KEY,
      lead_id TEXT,
      lead_name TEXT,
      cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
