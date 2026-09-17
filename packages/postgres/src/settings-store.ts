import type { SettingsStore, StoredSettings } from '@evu/harness-core';
import { emptyStoredSettings, normalizeStoredSettings } from '@evu/harness-core';
import type { Pool } from 'pg';
import { type PostgresStoreOptions, resolvePool } from './pool-options.js';

interface SettingsRow {
  id: number;
  payload: StoredSettings | string;
}

function parseSettings(raw: SettingsRow['payload']): StoredSettings {
  return typeof raw === 'string' ? (JSON.parse(raw) as StoredSettings) : raw;
}

export class PostgresSettingsStore implements SettingsStore {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(options: PostgresStoreOptions) {
    const resolved = resolvePool(options);
    this.pool = resolved.pool;
    this.ready = resolved.ready;
  }

  async get(): Promise<StoredSettings> {
    await this.ready;
    const result = await this.pool.query<SettingsRow>(
      'SELECT id, payload FROM settings WHERE id = 1',
    );
    const row = result.rows[0];
    if (row === undefined) {
      return emptyStoredSettings();
    }
    return normalizeStoredSettings(parseSettings(row.payload));
  }

  async put(settings: StoredSettings): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO settings (id, payload) VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET payload = excluded.payload`,
      [JSON.stringify(settings)],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
