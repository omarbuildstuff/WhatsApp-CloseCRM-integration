import { proto, initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataSet } from '@whiskeysockets/baileys';
import { pool } from '../db/pool';
import type { Logger } from 'pino';

export async function usePgAuthState(
  repId: string,
  logger?: Logger
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  // 1. Load or initialize creds
  const credsRow = await pool.query(
    'SELECT creds FROM wa_auth_creds WHERE rep_id = $1',
    [repId]
  );
  let creds;
  if (credsRow.rows[0]) {
    creds = JSON.parse(JSON.stringify(credsRow.rows[0].creds), BufferJSON.reviver);
    if (logger) logger.info({ repId, hasMe: !!creds.me }, 'Loaded existing creds from DB');
  } else {
    creds = initAuthCreds();
    if (logger) logger.info({ repId }, 'No existing creds — initialized fresh');
  }

  // 2. Build raw SignalKeyStore (reads/writes wa_auth_keys)
  const rawStore = {
    async get(type: string, ids: string[]) {
      const { rows } = await pool.query(
        'SELECT key_id, value FROM wa_auth_keys WHERE rep_id = $1 AND key_type = $2 AND key_id = ANY($3)',
        [repId, type, ids]
      );
      const data: Record<string, any> = {};
      for (const row of rows) {
        let value = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        data[row.key_id] = value;
      }
      return data;
    },

    async set(data: SignalDataSet) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [type, keys] of Object.entries(data)) {
          for (const [id, value] of Object.entries(keys ?? {})) {
            if (value == null) {
              await client.query(
                'DELETE FROM wa_auth_keys WHERE rep_id = $1 AND key_type = $2 AND key_id = $3',
                [repId, type, id]
              );
            } else {
              const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
              await client.query(
                `INSERT INTO wa_auth_keys (rep_id, key_type, key_id, value)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (rep_id, key_type, key_id) DO UPDATE SET value = EXCLUDED.value`,
                [repId, type, id, serialized]
              );
            }
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };

  // 3. Wrap with Baileys' cache layer (reduces DB hits for hot keys)
  const keys = makeCacheableSignalKeyStore(rawStore, logger);

  // 4. Define saveCreds
  const saveCreds = async (): Promise<void> => {
    const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await pool.query(
      `INSERT INTO wa_auth_creds (rep_id, creds, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (rep_id) DO UPDATE SET creds = EXCLUDED.creds, updated_at = NOW()`,
      [repId, serialized]
    );
  };

  return { state: { creds, keys }, saveCreds };
}
