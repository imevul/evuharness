import type { MemoryEntryRecord, MemoryStore } from '@evu/harness-core';
import type { Pool } from 'pg';
import { type PostgresStoreOptions, resolvePool } from './pool-options.js';

interface UserRow {
  text: string;
}

interface MemoryRow {
  id: string;
  title: string;
  body: string;
  updated_at: string;
}

export class PostgresMemoryStore implements MemoryStore {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(options: PostgresStoreOptions) {
    const resolved = resolvePool(options);
    this.pool = resolved.pool;
    this.ready = resolved.ready;
  }

  async getUser(): Promise<string> {
    await this.ready;
    const result = await this.pool.query<UserRow>('SELECT text FROM user_profile WHERE id = 1');
    return result.rows[0]?.text ?? '';
  }

  async setUser(text: string): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO user_profile (id, text) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET text = excluded.text`,
      [text],
    );
  }

  async list(query?: string): Promise<MemoryEntryRecord[]> {
    await this.ready;
    const needle = query?.trim() ?? '';
    const result =
      needle === ''
        ? await this.pool.query<MemoryRow>(
            'SELECT id, title, body, updated_at FROM memories ORDER BY updated_at DESC',
          )
        : await this.pool.query<MemoryRow>(
            `SELECT id, title, body, updated_at FROM memories
             WHERE title ILIKE $1 OR body ILIKE $2
             ORDER BY updated_at DESC`,
            [`%${needle}%`, `%${needle}%`],
          );

    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      updatedAt: row.updated_at,
    }));
  }

  async get(id: string): Promise<MemoryEntryRecord | null> {
    await this.ready;
    const result = await this.pool.query<MemoryRow>(
      'SELECT id, title, body, updated_at FROM memories WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { id: row.id, title: row.title, body: row.body, updatedAt: row.updated_at };
  }

  async upsert(entry: MemoryEntryRecord): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO memories (id, title, body, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         updated_at = excluded.updated_at`,
      [entry.id, entry.title, entry.body, entry.updatedAt],
    );
  }

  async delete(id: string): Promise<boolean> {
    await this.ready;
    const result = await this.pool.query('DELETE FROM memories WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
