import type { DatabaseSync } from 'node:sqlite';
import type { MemoryEntryRecord, MemoryStore } from '@evu/harness-core';
import { asRow } from './rows.js';
import { openDatabase } from './schema.js';

interface UserRow {
  text: string;
}

interface MemoryRow {
  id: string;
  title: string;
  body: string;
  updated_at: string;
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;

  constructor(options: { path: string } | { db: DatabaseSync }) {
    this.db = 'db' in options ? options.db : openDatabase({ path: options.path });
  }

  async getUser(): Promise<string> {
    const row = asRow<UserRow>(this.db.prepare('SELECT text FROM user_profile WHERE id = 1').get());
    return row?.text ?? '';
  }

  async setUser(text: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO user_profile (id, text) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET text = excluded.text`,
      )
      .run(text);
  }

  async list(query?: string): Promise<MemoryEntryRecord[]> {
    const needle = query?.trim() ?? '';
    const rows =
      needle === ''
        ? this.db
            .prepare('SELECT id, title, body, updated_at FROM memories ORDER BY updated_at DESC')
            .all()
        : this.db
            .prepare(
              `SELECT id, title, body, updated_at FROM memories
               WHERE title LIKE ? OR body LIKE ?
               ORDER BY updated_at DESC`,
            )
            .all(`%${needle}%`, `%${needle}%`);

    return rows.map((entry) => {
      const row = asRow<MemoryRow>(entry);
      if (row === undefined) throw new Error('memory row missing');
      return { id: row.id, title: row.title, body: row.body, updatedAt: row.updated_at };
    });
  }

  async get(id: string): Promise<MemoryEntryRecord | null> {
    const row = asRow<MemoryRow>(
      this.db.prepare('SELECT id, title, body, updated_at FROM memories WHERE id = ?').get(id),
    );
    return row === undefined
      ? null
      : { id: row.id, title: row.title, body: row.body, updatedAt: row.updated_at };
  }

  async upsert(entry: MemoryEntryRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO memories (id, title, body, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(entry.id, entry.title, entry.body, entry.updatedAt);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
