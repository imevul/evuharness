import type {
  ChatMessage,
  ChatModeId,
  PendingGates,
  ProviderOverride,
  SessionDetail,
  SessionSummary,
  SessionUsage,
  TranscriptRow,
} from '@evu/harness-protocol';

/**
 * A session as stored.
 *
 * Richer than the protocol's `SessionDetail`: it also holds `messages`, the
 * thread sent to the model. The two representations are deliberately separate.
 * `transcript` carries presentation state such as `partial` and `cancelled` that
 * must never reach a model, and `messages` carries system content a UI should not
 * render verbatim.
 */
export interface SessionRecord {
  id: string;
  title: string;
  /**
   * The session default mode.
   *
   * Only three writers may change this: send-time pinning, an explicit set-mode,
   * and plan approval. A turn's persistence path must not touch it — see
   * `applyTurnPatch`.
   */
  mode: ChatModeId;
  /** Fixed at creation. A session never moves between workspaces. */
  workspaceId?: string | undefined;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  transcript: TranscriptRow[];
  usage: SessionUsage;
  pending: PendingGates;
  /** Session-level provider preference, distinct from a per-turn override. */
  provider?: ProviderOverride | undefined;
  /** Session pin of one agent. Unset means no agent. */
  agentId?: string | undefined;
  /** Rolling compaction cursor. Stored messages stay verbatim. */
  compaction?: { summary: string; throughIndex: number; updatedAt: string } | undefined;
}

export const DEFAULT_SESSION_TITLE = 'New chat';

export function emptyUsage(): SessionUsage {
  return { promptTokensTotal: 0, completionTokensTotal: 0, lastPromptTokens: 0 };
}

export function emptyGates(): PendingGates {
  return { toolApprovals: [], plan: null, modeSwitch: null, askUser: null };
}

export interface CreateSessionRecordInput {
  id: string;
  mode: ChatModeId;
  workspaceId?: string | undefined;
  title?: string | undefined;
  now?: string;
}

export function createSessionRecord(input: CreateSessionRecordInput): SessionRecord {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    title: input.title ?? DEFAULT_SESSION_TITLE,
    mode: input.mode,
    workspaceId: input.workspaceId,
    createdAt: now,
    updatedAt: now,
    messages: [],
    transcript: [],
    usage: emptyUsage(),
    pending: emptyGates(),
  };
}

/**
 * Derive a session title from its first user message.
 *
 * Titles are advisory, so this trims aggressively rather than trying to be
 * clever: a sidebar row has little space and a long first line is worse than a
 * truncated one.
 */
export function titleFromMessage(text: string, maxLength = 60): string {
  const firstLine = text.trim().split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') {
    return DEFAULT_SESSION_TITLE;
  }
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  return `${firstLine.slice(0, maxLength - 1).trimEnd()}…`;
}

export function toSessionSummary(record: SessionRecord, turnInProgress = false): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    mode: record.mode,
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    usage: record.usage,
    turnInProgress,
  };
}

/** Project a stored record onto the wire shape, dropping the model thread. */
export function toSessionDetail(record: SessionRecord, turnInProgress = false): SessionDetail {
  return {
    id: record.id,
    title: record.title,
    mode: record.mode,
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    usage: record.usage,
    turnInProgress,
    transcript: record.transcript,
    pending: record.pending,
    ...(record.provider === undefined ? {} : { provider: record.provider }),
    ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
  };
}

/** Persist or clear the session-level agent pin. */
export function setSessionAgent(
  stored: SessionRecord,
  agentId: string | null,
  now?: string,
): SessionRecord {
  if (agentId === null || agentId === '') {
    if (stored.agentId === undefined) {
      return stored;
    }
    const { agentId: _removed, ...rest } = stored;
    return { ...rest, updatedAt: now ?? new Date().toISOString() };
  }

  if (stored.agentId === agentId) {
    return stored;
  }

  return {
    ...stored,
    agentId,
    updatedAt: now ?? new Date().toISOString(),
  };
}
