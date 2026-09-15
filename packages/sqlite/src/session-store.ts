import type { DatabaseSync } from 'node:sqlite';
import type { ListSessionsOptions, SessionRecord, SessionStore } from '@evu/harness-core';
import { toSessionSummary } from '@evu/harness-core';
import type { SessionSummary } from '@evu/harness-protocol';
import { asRow, asRows } from './rows.js';
import { openDatabase } from './schema.js';

interface SessionRow {
  id: string;
  title: string;
  mode: string;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
  prompt_tokens: number;
  completion_tokens: number;
  last_prompt_tokens: number;
  payload: string;
}

/** The JSON half of a row: everything a listing does not need. */
interface SessionPayload {
  messages: SessionRecord['messages'];
  transcript: SessionRecord['transcript'];
  pending: SessionRecord['pending'];
  provider?: SessionRecord['provider'];
}

function rowToRecord(row: SessionRow): SessionRecord {
  const payload = JSON.parse(row.payload) as SessionPayload;

  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: payload.messages,
    transcript: payload.transcript,
    usage: {
      promptTokensTotal: row.prompt_tokens,
      completionTokensTotal: row.completion_tokens,
      lastPromptTokens: row.last_prompt_tokens,
    },
    pending: payload.pending,
    ...(payload.provider === undefined ? {} : { provider: payload.provider }),
  };
}

/**
 * Build a summary from columns only.
 *
 * Deliberately does not touch `payload`: parsing a transcript per row is what
 * makes a session list slow down as history accumulates.
 */
function rowToSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    usage: {
      promptTokensTotal: row.prompt_tokens,
      completionTokensTotal: row.completion_tokens,
      lastPromptTokens: row.last_prompt_tokens,
    },
    turnInProgress: false,
  };
}

export interface SqliteSessionStoreOptions {
  path: string;
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteSessionStoreOptions | { db: DatabaseSync }) {
    this.db = 'db' in options ? options.db : openDatabase({ path: options.path });
  }

  async get(id: string): Promise<SessionRecord | null> {
    const row = asRow<SessionRow>(this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));

    return row === undefined ? null : rowToRecord(row);
  }

  async upsert(record: SessionRecord): Promise<void> {
    const payload: SessionPayload = {
      messages: record.messages,
      transcript: record.transcript,
      pending: record.pending,
      ...(record.provider === undefined ? {} : { provider: record.provider }),
    };

    this.db
      .prepare(
        `INSERT INTO sessions (
           id, title, mode, workspace_id, created_at, updated_at,
           prompt_tokens, completion_tokens, last_prompt_tokens, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           mode = excluded.mode,
           updated_at = excluded.updated_at,
           prompt_tokens = excluded.prompt_tokens,
           completion_tokens = excluded.completion_tokens,
           last_prompt_tokens = excluded.last_prompt_tokens,
           payload = excluded.payload`,
      )
      .run(
        record.id,
        record.title,
        record.mode,
        record.workspaceId ?? null,
        record.createdAt,
        record.updatedAt,
        record.usage.promptTokensTotal,
        record.usage.completionTokensTotal,
        record.usage.lastPromptTokens,
        JSON.stringify(payload),
      );
  }

  async listSummaries(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const limit = options.limit ?? 100;

    // Two statements rather than one with `(? IS NULL OR workspace_id = ?)`: an
    // unscoped listing must return every session, including those that do belong
    // to a workspace, so the filter has to be absent rather than permissive.
    const rows =
      options.workspaceId === undefined
        ? asRows<SessionRow>(
            this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit),
          )
        : asRows<SessionRow>(
            this.db
              .prepare(
                'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?',
              )
              .all(options.workspaceId, limit),
          );

    return rows.map(rowToSummary);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

export { toSessionSummary };
