import {
  type AskUserResponseRequest,
  type ChatRequest,
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type ContextMenuCatalogResponse,
  type ContextMenuItemsRequest,
  type ContextMenuItemsResponse,
  type CreateSessionRequest,
  type HarnessSettings,
  type HarnessSettingsUpdate,
  type HealthResponse,
  type ListSessionsResponse,
  type MemoryEntry,
  type MemoryEntryWrite,
  type ModelListRequest,
  type ModelListResponse,
  type ModeSwitchDecisionRequest,
  type PromptPreview,
  type PromptPreviewRequest,
  ROUTES,
  type SessionDetail,
  type SetAgentRequest,
  type SetModeRequest,
  type SetProviderRequest,
  SseDecoder,
  type StatusResponse,
  type StreamEvent,
  type ToolApprovalDecisionRequest,
  type ToolCatalogResponse,
  type UserProfile,
} from '@evu/harness-protocol';

export interface HarnessClientOptions {
  /** Where the router is mounted, e.g. `/api/harness` or `http://localhost:8080`. */
  baseUrl: string;
  /**
   * Extra headers per request, resolved at call time.
   *
   * A function rather than a fixed object so a host can supply a token that
   * rotates without rebuilding the client.
   */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof globalThis.fetch;
}

/** A non-2xx response, carrying the server's structured error when it sent one. */
export class HarnessRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'HarnessRequestError';
  }
}

/**
 * A typed client for the harness HTTP/SSE surface.
 *
 * Deliberately not a React hook and not stateful beyond its options: the same
 * client works in a component, a test, or a non-React surface. Hooks in this
 * package wrap it rather than reimplementing transport.
 *
 * Responses are returned as protocol types without re-validating them. The server
 * validates on the way in and constructs responses from the same schemas, so
 * parsing here would cost bundle size to re-check what the peer already checked.
 * A host that does not trust its own server can parse with the exported schemas.
 */
export class HarnessClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: HarnessClientOptions) {
    // Normalized once so route concatenation cannot produce a double slash.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<TResult>(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<TResult> {
    const { json, ...rest } = init;
    const extra = this.options.headers === undefined ? {} : await this.options.headers();

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...rest,
      headers: {
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
        ...rest.headers,
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });

    if (!response.ok) {
      throw await toRequestError(response);
    }

    if (response.status === 204) {
      return undefined as TResult;
    }

    return (await response.json()) as TResult;
  }

  health(): Promise<HealthResponse> {
    return this.request(ROUTES.health);
  }

  status(): Promise<StatusResponse> {
    return this.request(ROUTES.status);
  }

  listSessions(
    query: { workspaceId?: string; limit?: number } = {},
  ): Promise<ListSessionsResponse> {
    const params = new URLSearchParams();
    if (query.workspaceId !== undefined) params.set('workspaceId', query.workspaceId);
    if (query.limit !== undefined) params.set('limit', String(query.limit));

    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    return this.request(`${ROUTES.sessions}${suffix}`);
  }

  createSession(body: CreateSessionRequest): Promise<SessionDetail> {
    return this.request(ROUTES.sessions, { method: 'POST', json: body });
  }

  getSession(id: string): Promise<SessionDetail> {
    return this.request(ROUTES.session(id));
  }

  deleteSession(id: string): Promise<void> {
    return this.request(ROUTES.session(id), { method: 'DELETE' });
  }

  /**
   * Change the session's default mode.
   *
   * This is the only client call that writes the stored mode. It has no effect on a
   * turn already running: that turn carries the mode it was sent with. A composer
   * that tracks a draft mode should call this on an explicit change, not per
   * keystroke, and must not treat the response as authority over a live turn.
   */
  setMode(id: string, body: SetModeRequest): Promise<SessionDetail> {
    return this.request(ROUTES.setMode(id), { method: 'POST', json: body });
  }

  /**
   * Persist a session-level provider preference, or clear it with `provider: null`.
   *
   * Does not rewrite named settings profiles. A per-turn override on `chat()`
   * still wins for that turn only.
   */
  setProvider(id: string, body: SetProviderRequest): Promise<SessionDetail> {
    return this.request(ROUTES.setProvider(id), { method: 'POST', json: body });
  }

  /**
   * Persist a session-level agent pin, or clear it with `agentId: null`.
   *
   * Null means no agent. Does not rewrite agent profiles.
   */
  setAgent(id: string, body: SetAgentRequest): Promise<SessionDetail> {
    return this.request(ROUTES.setAgent(id), { method: 'POST', json: body });
  }

  cancel(id: string, reason: 'operator' | 'follow_up' = 'operator'): Promise<void> {
    return this.request(ROUTES.cancel(id), { method: 'POST', json: { reason } });
  }

  decideToolApproval(
    id: string,
    approvalId: string,
    body: ToolApprovalDecisionRequest,
  ): Promise<void> {
    return this.request(ROUTES.toolApproval(id, approvalId), { method: 'POST', json: body });
  }

  approvePlan(id: string): Promise<void> {
    return this.request(ROUTES.approvePlan(id), { method: 'POST' });
  }

  discardPlan(id: string): Promise<void> {
    return this.request(ROUTES.discardPlan(id), { method: 'POST' });
  }

  decideModeSwitch(id: string, body: ModeSwitchDecisionRequest): Promise<void> {
    return this.request(ROUTES.modeSwitch(id), { method: 'POST', json: body });
  }

  answerAskUser(id: string, askId: string, body: AskUserResponseRequest): Promise<void> {
    return this.request(ROUTES.askUser(id, askId), { method: 'POST', json: body });
  }

  getSettings(): Promise<HarnessSettings> {
    return this.request(ROUTES.settings);
  }

  updateSettings(body: HarnessSettingsUpdate): Promise<HarnessSettings> {
    return this.request(ROUTES.settings, { method: 'PATCH', json: body });
  }

  getUserProfile(): Promise<UserProfile> {
    return this.request(ROUTES.memoryUser);
  }

  setUserProfile(text: string): Promise<UserProfile> {
    return this.request(ROUTES.memoryUser, { method: 'PUT', json: { text } });
  }

  listMemories(query?: string): Promise<{ memories: MemoryEntry[] }> {
    const params = query === undefined || query === '' ? '' : `?q=${encodeURIComponent(query)}`;
    return this.request(`${ROUTES.memories}${params}`);
  }

  upsertMemory(body: MemoryEntryWrite): Promise<MemoryEntry> {
    return body.id === undefined
      ? this.request(ROUTES.memories, { method: 'POST', json: body })
      : this.request(ROUTES.memory(body.id), { method: 'PATCH', json: body });
  }

  deleteMemory(id: string): Promise<void> {
    return this.request(ROUTES.memory(id), { method: 'DELETE' });
  }

  resetCompaction(sessionId: string): Promise<void> {
    return this.request(ROUTES.compactionReset(sessionId), { method: 'POST' });
  }

  probeMcp(serverId: string): Promise<ConnectionTestResult> {
    return this.request(ROUTES.mcpHealth(serverId), { method: 'POST' });
  }

  testConnection(body: ConnectionTestRequest = {}): Promise<ConnectionTestResult> {
    return this.request(ROUTES.testConnection, { method: 'POST', json: body });
  }

  listModels(body: ModelListRequest = {}): Promise<ModelListResponse> {
    return this.request(ROUTES.models, { method: 'POST', json: body });
  }

  /**
   * Preview the composed system prompt.
   *
   * A GET with query parameters, not a POST: preview has no side effects and its
   * input is three scalars. Sending a body would misrepresent it as a mutation.
   */
  previewPrompt(request: PromptPreviewRequest): Promise<PromptPreview> {
    const params = new URLSearchParams({ mode: request.mode });
    if (request.workspaceId !== undefined) params.set('workspaceId', request.workspaceId);
    if (request.sessionId !== undefined) params.set('sessionId', request.sessionId);

    return this.request(`${ROUTES.promptPreview}?${params.toString()}`);
  }

  tools(mode?: string): Promise<ToolCatalogResponse> {
    if (mode === undefined) {
      return this.request(ROUTES.tools);
    }
    const params = new URLSearchParams({ mode });
    return this.request(`${ROUTES.tools}?${params.toString()}`);
  }

  contextMenus(): Promise<ContextMenuCatalogResponse> {
    return this.request(ROUTES.contextMenus);
  }

  contextMenuItems(
    menuId: string,
    body: ContextMenuItemsRequest,
    signal?: AbortSignal,
  ): Promise<ContextMenuItemsResponse> {
    return this.request(ROUTES.contextMenuItems(menuId), {
      method: 'POST',
      json: body,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Open a turn and yield stream events as they arrive.
   *
   * `fetch` with a readable body rather than `EventSource`, for three reasons that
   * all matter here: a turn is a POST with a body, it needs auth headers, and it
   * must be cancellable via `AbortSignal`. `EventSource` supports none of those.
   *
   * The generator holds the reader for its lifetime, so a consumer that breaks out
   * of the loop early should pass a signal and abort it; the `finally` cancels the
   * reader so an abandoned turn does not leak a socket.
   */
  async *chat(body: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const extra = this.options.headers === undefined ? {} : await this.options.headers();

    const response = await this.fetchImpl(`${this.baseUrl}${ROUTES.chat}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...extra },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw await toRequestError(response);
    }

    if (response.body === null) {
      throw new HarnessRequestError(response.status, 'empty_stream');
    }

    const reader = response.body.getReader();
    const utf8 = new TextDecoder();
    const decoder = new SseDecoder();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        // `stream: true` so a multi-byte character split across two network
        // chunks is held until complete rather than decoded as replacement chars.
        for (const event of decoder.push(utf8.decode(value, { stream: true }))) {
          yield event;
        }
      }
    } finally {
      reader.cancel().catch(() => {
        // The stream is already being torn down; a cancel failure has nowhere to go.
      });
    }
  }
}

async function toRequestError(response: Response): Promise<HarnessRequestError> {
  try {
    const body = (await response.json()) as { error?: string; detail?: string };
    return new HarnessRequestError(response.status, body.error ?? 'request_failed', body.detail);
  } catch {
    // A proxy or gateway can fail a request without the JSON shape.
    return new HarnessRequestError(response.status, 'request_failed', response.statusText);
  }
}
