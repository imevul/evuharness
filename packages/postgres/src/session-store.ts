import type { ListSessionsOptions, SessionRecord, SessionStore } from '@evu/harness-core';
import { toSessionSummary } from '@evu/harness-core';
import type { SessionSummary } from '@evu/harness-protocol';
import type { Pool } from 'pg';
import { type PostgresStoreOptions, resolvePool } from './pool-options.js';

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
  payload: SessionPayload | string;
}

/** The JSON half of a row: everything a listing does not need. */
interface SessionPayload {
  messages: SessionRecord['messages'];
  transcript: SessionRecord['transcript'];
  pending: SessionRecord['pending'];
  provider?: SessionRecord['provider'];
  agentId?: SessionRecord['agentId'];
  compaction?: SessionRecord['compaction'];
}

function parsePayload(raw: SessionRow['payload']): SessionPayload {
  return typeof raw === 'string' ? (JSON.parse(raw) as SessionPayload) : raw;
}

function rowToRecord(row: SessionRow): SessionRecord {
  const payload = parsePayload(row.payload);

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
      promptTokensTotal: Number(row.prompt_tokens),
      completionTokensTotal: Number(row.completion_tokens),
      lastPromptTokens: Number(row.last_prompt_tokens),
    },
    pending: payload.pending,
    ...(payload.provider === undefined ? {} : { provider: payload.provider }),
    ...(payload.agentId === undefined ? {} : { agentId: payload.agentId }),
    ...(payload.compaction === undefined ? {} : { compaction: payload.compaction }),
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
      promptTokensTotal: Number(row.prompt_tokens),
      completionTokensTotal: Number(row.completion_tokens),
      lastPromptTokens: Number(row.last_prompt_tokens),
    },
    turnInProgress: false,
  };
}

export class PostgresSessionStore implements SessionStore {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(options: PostgresStoreOptions) {
    const resolved = resolvePool(options);
    this.pool = resolved.pool;
    this.ready = resolved.ready;
  }

  async get(id: string): Promise<SessionRecord | null> {
    await this.ready;
    const result = await this.pool.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async upsert(record: SessionRecord): Promise<void> {
    await this.ready;
    const payload: SessionPayload = {
      messages: record.messages,
      transcript: record.transcript,
      pending: record.pending,
      ...(record.provider === undefined ? {} : { provider: record.provider }),
      ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
      ...(record.compaction === undefined ? {} : { compaction: record.compaction }),
    };

    await this.pool.query(
      `INSERT INTO sessions (
         id, title, mode, workspace_id, created_at, updated_at,
         prompt_tokens, completion_tokens, last_prompt_tokens, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title,
         mode = excluded.mode,
         updated_at = excluded.updated_at,
         prompt_tokens = excluded.prompt_tokens,
         completion_tokens = excluded.completion_tokens,
         last_prompt_tokens = excluded.last_prompt_tokens,
         payload = excluded.payload`,
      [
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
      ],
    );
  }

  async listSummaries(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    await this.ready;
    const limit = options.limit ?? 100;

    // Two statements rather than one with a nullable workspace: an unscoped
    // listing must return every session, including those that belong to a workspace.
    const result =
      options.workspaceId === undefined
        ? await this.pool.query<SessionRow>(
            `SELECT id, title, mode, workspace_id, created_at, updated_at,
                    prompt_tokens, completion_tokens, last_prompt_tokens
             FROM sessions
             ORDER BY updated_at DESC
             LIMIT $1`,
            [limit],
          )
        : await this.pool.query<SessionRow>(
            `SELECT id, title, mode, workspace_id, created_at, updated_at,
                    prompt_tokens, completion_tokens, last_prompt_tokens
             FROM sessions
             WHERE workspace_id = $1
             ORDER BY updated_at DESC
             LIMIT $2`,
            [options.workspaceId, limit],
          );

    return result.rows.map(rowToSummary);
  }

  async delete(id: string): Promise<boolean> {
    await this.ready;
    const result = await this.pool.query('DELETE FROM sessions WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { toSessionSummary };
