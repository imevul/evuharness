import type { DatabaseSync } from 'node:sqlite';
import type { SettingsStore, StoredSettings } from '@evu/harness-core';
import { emptyStoredSettings, normalizeStoredSettings } from '@evu/harness-core';
import { asRow } from './rows.js';
import { openDatabase } from './schema.js';

interface SettingsRow {
  id: number;
  payload: string;
}

export interface SqliteSettingsStoreOptions {
  path: string;
}

export class SqliteSettingsStore implements SettingsStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteSettingsStoreOptions | { db: DatabaseSync }) {
    this.db = 'db' in options ? options.db : openDatabase({ path: options.path });
  }

  async get(): Promise<StoredSettings> {
    const row = asRow<SettingsRow>(
      this.db.prepare('SELECT id, payload FROM settings WHERE id = 1').get(),
    );
    if (row === undefined) {
      return emptyStoredSettings();
    }
    return normalizeStoredSettings(JSON.parse(row.payload) as StoredSettings);
  }

  async put(settings: StoredSettings): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO settings (id, payload) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(JSON.stringify(settings));
  }

  close(): void {
    this.db.close();
  }
}
