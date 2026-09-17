import type {
  ApprovalDecision,
  AskUserAnswer,
  ChatModeId,
  ChatRequest,
  ConnectionTestResult,
  ContextMenuDescriptor,
  ContextMenuItemsResponse,
  HarnessSettings,
  HarnessSettingsUpdate,
  MemoryEntry,
  MemoryEntryWrite,
  ModelListResponse,
  PromptPreview,
  Scope,
  SessionDetail,
  SessionSummary,
  StatusResponse,
  StreamEvent,
  ToolApprovalRule,
  ToolCatalogResponse,
  UserProfile,
} from '@evu/harness-protocol';
import { BUILTIN_TOOL_NAMES, isBuiltinToolName } from '@evu/harness-protocol';
import { builtinMcpTools } from './builtin-mcp-tools.js';
import { builtinMemoryTools } from './builtin-memory-tools.js';
import { builtinGateTools } from './builtin-tools.js';
import { builtinHttpRequestTool, builtinWebSearchTool } from './builtin-web-tools.js';
import type { CompactContext } from './context-compaction.js';
import { defaultCompactContext } from './context-compaction.js';
import type { ContextMenuDefinition } from './context-menus/index.js';
import { ContextMenuRegistry } from './context-menus/index.js';
import type { ProviderAdapter } from './fake-provider.js';
import { GateWaiterRegistry } from './gate-waiters.js';
import type { GrantStore } from './grants.js';
import { createMcpClient } from './mcp-client.js';
import { DEFAULT_MCP_PERMISSIONS, resolveMcpCallApproval } from './mcp-permissions.js';
import { capUserProfile, InMemoryMemoryStore, type MemoryStore } from './memory-store.js';
import { createTurnPin, type ModeWriter, setSessionMode, type TurnPin } from './mode-pinning.js';
import { resolveContextWindow } from './model-catalog.js';
import { type ModePolicy, ModeRegistry, STOCK_MODES } from './modes.js';
import { OpenAICompatibleClient } from './openai-client.js';
import { composePrompt, type PromptConfig } from './prompts.js';
import { createRollingCompactor } from './rolling-compaction.js';
import { type SessionCacheOptions, withSessionLock, wrapSessionStore } from './session-cache.js';
import {
  createSessionRecord,
  type SessionRecord,
  toSessionDetail,
  toSessionSummary,
} from './session-record.js';
import {
  applySettingsUpdate,
  effectiveToolApprovals,
  emptyStoredSettings,
  InMemorySettingsStore,
  isPristineStoredSettings,
  normalizeStoredSettings,
  type ProviderProfileInput,
  type SettingsStore,
  type StoredProviderProfile,
  storedFromInput,
  toPublicSettings,
} from './settings-store.js';
import { builtinLoadSkillTool, type SkillCatalog, type SkillSummary } from './skills/index.js';
import type { HttpRequestPolicy } from './ssrf.js';
import type { ListSessionsOptions, SessionStore } from './stores.js';
import { InMemoryGrantStore, InMemorySessionStore } from './stores.js';
import { type ToolDefinition, ToolRegistry } from './tools.js';
import { createTurnController } from './turn-loop.js';

export type {
  ProviderProfileInput,
  SettingsStore,
  StoredProviderProfile,
} from './settings-store.js';
export { effectiveToolApprovals, InMemorySettingsStore } from './settings-store.js';

export interface HarnessPolicies {
  askUser?: boolean;
  maxToolRounds?: number;
}

export interface HarnessFeatures {
  settings?: boolean;
  effort?: boolean;
  attachments?: boolean;
  agents?: boolean;
  memory?: boolean;
  webSearch?: boolean;
  httpRequest?: boolean;
  compaction?: boolean;
  mcp?: boolean;
}

/**
 * The host composition surface.
 *
 * Every list is an extension point. A host adds modes, tools, menus, prompt slots,
 * and providers; it does not fork the turn loop.
 */
export interface HarnessConfig {
  store?: SessionStore;
  /**
   * In-process session cache in front of `store`.
   *
   * Defaults to an LRU of 128 entries with per-session locks. Pass `false` to
   * talk to the durable store directly (tests that assert store call shapes).
   */
  cache?: SessionCacheOptions | false;
  grants?: GrantStore;
  settings?: SettingsStore;
  /**
   * Seed profiles used only when the settings store is empty.
   *
   * After the first write, the store wins. Passing this on every boot must not
   * overwrite a UI edit, which is why it is a seed and not a live override.
   */
  providers?: ProviderProfileInput[];
  activeProviderId?: string;
  modes?: ModePolicy[];
  tools?: ToolDefinition[];
  contextMenus?: ContextMenuDefinition[];
  prompts?: PromptConfig;
  /**
   * Host skill store. When set, the skills catalog is composed into the system
   * prompt and `load_skill` is registered for leading-system injection.
   */
  skills?: SkillCatalog;
  /**
   * Context compaction hook invoked when building the outbound model thread.
   *
   * Defaults to a naive truncating compactor. Pass a custom hook to summarize,
   * or an identity function to disable compaction.
   */
  compactContext?: CompactContext;
  policies?: HarnessPolicies;
  features?: HarnessFeatures;
  /** USER.md / MEMORY.md store. Used only when `features.memory` is on. */
  memory?: MemoryStore;
  /** SSRF exceptions for `http_request`. */
  httpRequest?: HttpRequestPolicy;
  idFactory?: () => string;
  clock?: () => string;
  fetch?: typeof globalThis.fetch;
  /** Override the OpenAI-compatible client. Tests and smoke inject `FakeProvider`. */
  provider?: ProviderAdapter;
}

export interface CreateSessionOptions {
  mode?: ChatModeId;
  workspaceId?: string;
  title?: string;
}

/**
 * A configured harness.
 *
 * Presentation-free by design: this is the object a server adapter wraps and a
 * non-web surface imports directly.
 */
export interface Harness {
  readonly modes: ModeRegistry;
  readonly tools: ToolRegistry;
  readonly contextMenus: ContextMenuRegistry;
  readonly store: SessionStore;
  readonly grants: GrantStore;
  readonly settingsStore: SettingsStore;
  readonly features: Required<HarnessFeatures>;
  readonly memoryStore: MemoryStore;

  status(): Promise<StatusResponse>;
  getUserProfile(): Promise<UserProfile>;
  setUserProfile(text: string): Promise<UserProfile>;
  listMemories(query?: string): Promise<MemoryEntry[]>;
  upsertMemory(write: MemoryEntryWrite): Promise<MemoryEntry>;
  deleteMemory(id: string): Promise<boolean>;
  resetCompaction(sessionId: string): Promise<void>;
  probeMcp(serverId: string): Promise<ConnectionTestResult>;

  getSettings(): Promise<HarnessSettings>;
  updateSettings(update: HarnessSettingsUpdate): Promise<HarnessSettings>;
  /** The stored profile including the key. Never sent over the wire. */
  getStoredProvider(id?: string): Promise<StoredProviderProfile | null>;
  testConnection(providerId?: string): Promise<ConnectionTestResult>;
  listModels(providerId?: string): Promise<ModelListResponse>;
  createSession(options?: CreateSessionOptions): Promise<SessionDetail>;
  getSession(id: string): Promise<SessionDetail | null>;
  listSessions(options?: ListSessionsOptions): Promise<SessionSummary[]>;
  deleteSession(id: string): Promise<boolean>;

  /**
   * Capture a turn's immutable setup.
   *
   * The requested mode is the pin for this turn and also becomes the session
   * default, quietly. Everything downstream reads the pin, never the session, so a
   * later mode change cannot reach a running turn.
   */
  pinTurn(input: { sessionId: string; mode: ChatModeId; scope?: Scope }): Promise<TurnPin>;

  previewPrompt(input: {
    mode: ChatModeId;
    scope?: Scope;
    sessionId?: string;
  }): Promise<PromptPreview>;

  /** Summaries from the configured skill catalog, or an empty list. */
  listSkills(): Promise<SkillSummary[]>;

  toolCatalog(mode: ChatModeId): Promise<ToolCatalogResponse>;
  menuCatalog(): ContextMenuDescriptor[];
  listMenuItems(
    menuId: string,
    options?: { query?: string; path?: string[]; scope?: Scope },
  ): Promise<ContextMenuItemsResponse>;

  runTurn(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
  cancel(sessionId: string, reason?: 'operator' | 'follow_up'): Promise<void>;
  decideToolApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  answerAskUser(sessionId: string, askId: string, answers: AskUserAnswer[]): Promise<void>;
  approvePlan(sessionId: string): Promise<void>;
  discardPlan(sessionId: string): Promise<void>;
  decideModeSwitch(sessionId: string, approve: boolean): Promise<void>;
}

function defaultIdFactory(): () => string {
  return () => crypto.randomUUID();
}

export function createHarness(config: HarnessConfig = {}): Harness {
  const store = wrapSessionStore(config.store ?? new InMemorySessionStore(), config.cache);
  const grants = config.grants ?? new InMemoryGrantStore();
  const settingsStore = config.settings ?? new InMemorySettingsStore();
  const memoryStore = config.memory ?? new InMemoryMemoryStore();
  const modes = new ModeRegistry(config.modes ?? STOCK_MODES);
  const skills = config.skills ?? null;
  const hostPrompts: PromptConfig = config.prompts ?? {};
  const newId = config.idFactory ?? defaultIdFactory();
  const now = config.clock ?? (() => new Date().toISOString());
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const openai = new OpenAICompatibleClient({
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
  const provider: ProviderAdapter = config.provider ?? openai;

  const features: Required<HarnessFeatures> = {
    settings: config.features?.settings ?? true,
    effort: config.features?.effort ?? true,
    attachments: config.features?.attachments ?? false,
    agents: config.features?.agents ?? false,
    memory: config.features?.memory ?? false,
    webSearch: config.features?.webSearch ?? false,
    httpRequest: config.features?.httpRequest ?? false,
    compaction: config.features?.compaction ?? false,
    mcp: config.features?.mcp ?? false,
  };

  const optionalTools: ToolDefinition[] = [];
  if (features.memory) {
    optionalTools.push(...builtinMemoryTools(memoryStore, now));
  }
  if (features.webSearch) {
    optionalTools.push(
      builtinWebSearchTool({
        fetch: fetchImpl,
        activeSearch: async () => {
          const stored = await loadStored();
          const id = stored.activeSearchProviderId;
          const row =
            id === null
              ? (stored.searchProviders[0] ?? null)
              : (stored.searchProviders.find((entry) => entry.id === id) ?? null);
          return row;
        },
      }),
    );
  }
  if (features.httpRequest) {
    optionalTools.push(
      builtinHttpRequestTool({
        fetch: fetchImpl,
        activeSearch: async () => null,
        ...(config.httpRequest === undefined ? {} : { httpPolicy: config.httpRequest }),
      }),
    );
  }
  if (features.mcp) {
    optionalTools.push(
      ...builtinMcpTools({
        fetch: fetchImpl,
        listServers: async () =>
          (await loadStored()).mcpServers.map((server) => ({
            ...server,
            permissions: server.permissions ?? DEFAULT_MCP_PERMISSIONS,
          })),
      }),
    );
  }

  const tools = new ToolRegistry([
    ...(config.tools ?? []),
    ...builtinGateTools(),
    ...(skills === null ? [] : [builtinLoadSkillTool()]),
    ...optionalTools,
  ]);
  const contextMenus = new ContextMenuRegistry(config.contextMenus ?? []);

  async function skillSummaries(): Promise<SkillSummary[]> {
    if (skills === null) {
      return [];
    }
    return [...(await skills.list())];
  }

  const seedProviders = (config.providers ?? []).map(storedFromInput);
  const seedIds = new Set(seedProviders.map((provider) => provider.id));
  if (seedIds.size !== seedProviders.length) {
    throw new Error('Duplicate provider id');
  }
  if (config.activeProviderId !== undefined && !seedIds.has(config.activeProviderId)) {
    throw new Error(`Unknown activeProviderId: ${config.activeProviderId}`);
  }

  /**
   * Load settings, seeding only when the store has never been written.
   *
   * Env and `config.providers` are a first-boot convenience. After a UI writes
   * once, they must not come back on the next process start. Pristine is the
   * empty default shape — not "no providers" — so prompt-only edits stick.
   */
  async function loadStored() {
    const current = normalizeStoredSettings(await settingsStore.get());
    // After any UI write (providers, prompts, or tool approvals), the store wins.
    if (!isPristineStoredSettings(current)) {
      if (features.webSearch && current.searchProviders.length === 0) {
        current.searchProviders = [{ id: 'duckduckgo', kind: 'duckduckgo', label: 'DuckDuckGo' }];
        current.activeSearchProviderId = 'duckduckgo';
        await settingsStore.put(current);
      }
      return current;
    }

    const seeded = emptyStoredSettings();
    seeded.providers = seedProviders;
    seeded.activeProviderId = config.activeProviderId ?? seedProviders[0]?.id ?? null;
    seeded.prompts = {
      global: hostPrompts.global ?? '',
      perMode: hostPrompts.perMode ?? {},
    };
    seeded.policies = {
      toolApprovals: {},
      askUserEnabled: config.policies?.askUser ?? true,
      maxToolRounds: config.policies?.maxToolRounds ?? 12,
    };
    if (features.webSearch) {
      seeded.searchProviders = [{ id: 'duckduckgo', kind: 'duckduckgo', label: 'DuckDuckGo' }];
      seeded.activeSearchProviderId = 'duckduckgo';
    }
    if (
      seeded.providers.length > 0 ||
      seeded.prompts.global !== '' ||
      Object.keys(seeded.prompts.perMode).length > 0 ||
      seeded.searchProviders.length > 0
    ) {
      await settingsStore.put(seeded);
    }
    return seeded;
  }

  async function composeExtras(stored: Awaited<ReturnType<typeof loadStored>>) {
    const soul =
      features.agents !== true
        ? undefined
        : stored.agents.find((agent) => agent.id === stored.activeAgentId)?.soul;
    const userProfile =
      features.memory !== true ? undefined : capUserProfile(await memoryStore.getUser());
    let mcpSnapshot: string | undefined;
    if (features.mcp) {
      const enabled = stored.mcpServers.filter((server) => server.enabled);
      if (enabled.length > 0) {
        const client = createMcpClient(fetchImpl);
        const lines: string[] = ['Configured MCP servers (call via mcp_list / mcp_call):'];
        for (const server of enabled) {
          try {
            const listed = await client.listTools(server);
            const names = listed.map((tool) => tool.name).join(', ');
            lines.push(`- ${server.label ?? server.id}: ${names === '' ? '(none listed)' : names}`);
          } catch {
            lines.push(`- ${server.label ?? server.id}: (unreachable)`);
          }
        }
        mcpSnapshot = lines.join('\n');
      }
    }
    return {
      ...(soul === undefined || soul.trim() === '' ? {} : { soul }),
      ...(userProfile === undefined || userProfile === '' ? {} : { userProfile }),
      ...(mcpSnapshot === undefined ? {} : { mcpSnapshot }),
    };
  }

  function promptsFor(stored: Awaited<ReturnType<typeof loadStored>>): PromptConfig {
    const global = stored.prompts.global || hostPrompts.global;
    return {
      ...(global === undefined || global === '' ? {} : { global }),
      perMode: { ...hostPrompts.perMode, ...stored.prompts.perMode },
      ...(hostPrompts.dynamic === undefined ? {} : { dynamic: hostPrompts.dynamic }),
    };
  }

  function registryApprovals(): Record<string, 'always_allow' | 'requires_approval'> {
    return Object.fromEntries(tools.specs().map((spec) => [spec.name, spec.approval]));
  }

  function gateNames(): Set<string> {
    return new Set(Object.values(BUILTIN_TOOL_NAMES));
  }

  function approvalsFor(stored: Awaited<ReturnType<typeof loadStored>>) {
    return effectiveToolApprovals(
      registryApprovals(),
      stored.policies.toolApprovals ?? {},
      gateNames(),
    );
  }

  function publicFrom(stored: Awaited<ReturnType<typeof loadStored>>): HarnessSettings {
    return toPublicSettings(stored, {
      modes: modes.ids(),
      toolApprovals: approvalsFor(stored),
    });
  }

  async function toolApprovalRule(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolApprovalRule> {
    if (!tools.has(name)) {
      return 'requires_approval';
    }
    if (isBuiltinToolName(name)) {
      return 'always_allow';
    }
    if (name === 'http_request') {
      const method = String(args.method ?? 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') return 'always_allow';
      return 'requires_approval';
    }
    if (name === 'mcp_call') {
      const stored = await loadStored();
      const server = stored.mcpServers.find((entry) => entry.id === args.serverId);
      return resolveMcpCallApproval(server?.permissions, String(args.tool ?? ''));
    }
    const spec = tools.get(name).spec;
    const stored = await loadStored();
    return stored.policies.toolApprovals?.[name] ?? spec.approval;
  }

  async function loadRecord(id: string): Promise<SessionRecord> {
    const record = await store.get(id);
    if (record === null) {
      throw new Error(`Unknown session: ${id}`);
    }
    return record;
  }

  async function writeSessionMode(
    sessionId: string,
    mode: ChatModeId,
    writer: ModeWriter,
  ): Promise<void> {
    await withSessionLock(store, sessionId, async () => {
      const record = await loadRecord(sessionId);
      await store.upsert(setSessionMode(record, mode, writer, now()));
    });
  }

  async function getStoredProvider(id?: string): Promise<StoredProviderProfile | null> {
    const stored = await loadStored();
    const wanted = id ?? stored.activeProviderId;
    if (wanted === null) return null;
    return stored.providers.find((entry) => entry.id === wanted) ?? null;
  }

  async function createSession(options: CreateSessionOptions = {}): Promise<SessionDetail> {
    const mode = options.mode ?? modes.defaultMode;
    if (!modes.has(mode)) {
      throw new Error(`Unknown mode: ${mode}`);
    }

    const record = createSessionRecord({
      id: newId(),
      mode,
      workspaceId: options.workspaceId,
      title: options.title,
      now: now(),
    });

    await store.upsert(record);
    return toSessionDetail(record);
  }

  async function pinTurn(input: {
    sessionId: string;
    mode: ChatModeId;
    scope?: Scope;
  }): Promise<TurnPin> {
    const record = await loadRecord(input.sessionId);
    if (!modes.has(input.mode)) {
      throw new Error(`Unknown mode: ${input.mode}`);
    }

    const scope: Scope =
      input.scope ?? (record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId });

    const allowed = modes.toolNamesFor(input.mode, tools.modeContext());
    const stored = await loadStored();
    const prompt = await composePrompt({
      mode: input.mode,
      modes,
      prompts: promptsFor(stored),
      scope,
      sessionId: record.id,
      skills: await skillSummaries(),
      ...(await composeExtras(stored)),
    });

    return createTurnPin({
      sessionId: record.id,
      mode: input.mode,
      toolNames: allowed,
      systemPrompt: prompt.text,
      startedAt: now(),
    });
  }

  const turns = createTurnController({
    store,
    grants,
    tools,
    contextMenus,
    provider,
    gates: new GateWaiterRegistry(),
    newId,
    getStoredProvider,
    pinTurn,
    createSession,
    hasMode: (id) => modes.has(id),
    writeSessionMode,
    maxToolRounds: async () => (await loadStored()).policies.maxToolRounds,
    askUserEnabled: async () => (await loadStored()).policies.askUserEnabled,
    toolApprovalRule,
    ...(skills === null ? {} : { skills }),
    compactContext:
      config.compactContext ??
      (features.compaction
        ? createRollingCompactor({
            loadState: async (sessionId) => (await loadRecord(sessionId)).compaction,
            saveState: async (sessionId, state) => {
              await withSessionLock(store, sessionId, async () => {
                const record = await loadRecord(sessionId);
                await store.upsert({ ...record, compaction: state });
              });
            },
            getSettings: async () => (await loadStored()).compaction,
            summarize: async (text) => {
              const profile = await getStoredProvider();
              if (profile === null) return null;
              let collected = '';
              try {
                for await (const event of provider.complete(profile, {
                  messages: [
                    {
                      role: 'system',
                      content:
                        'Summarize the earlier conversation for a later turn. Factual, compact, no tools. If there is nothing to keep, reply skip.',
                    },
                    { role: 'user', content: text },
                  ],
                  tools: [],
                  model: profile.model,
                  signal: new AbortController().signal,
                })) {
                  if (event.kind === 'delta') collected += event.text;
                }
              } catch {
                return null;
              }
              const trimmed = collected.trim();
              if (trimmed === '' || trimmed.toLowerCase().startsWith('skip')) return null;
              return trimmed;
            },
            now,
          })
        : defaultCompactContext),
    attachmentsEnabled: features.attachments,
    now,
  });

  return {
    modes,
    tools,
    contextMenus,
    store,
    grants,
    settingsStore,
    memoryStore,
    features,

    async getUserProfile(): Promise<UserProfile> {
      return { text: await memoryStore.getUser() };
    },

    async setUserProfile(text: string): Promise<UserProfile> {
      await memoryStore.setUser(text);
      return { text };
    },

    async listMemories(query?: string): Promise<MemoryEntry[]> {
      return memoryStore.list(query);
    },

    async upsertMemory(write: MemoryEntryWrite): Promise<MemoryEntry> {
      const entry: MemoryEntry = {
        id: write.id ?? newId(),
        title: write.title,
        body: write.body,
        updatedAt: now(),
      };
      await memoryStore.upsert(entry);
      return entry;
    },

    async deleteMemory(id: string): Promise<boolean> {
      return memoryStore.delete(id);
    },

    async resetCompaction(sessionId: string): Promise<void> {
      await withSessionLock(store, sessionId, async () => {
        const record = await loadRecord(sessionId);
        const { compaction: _cleared, ...rest } = record;
        await store.upsert(rest);
      });
    },

    async probeMcp(serverId: string): Promise<ConnectionTestResult> {
      const stored = await loadStored();
      const server = stored.mcpServers.find((entry) => entry.id === serverId);
      if (server === undefined) {
        return { ok: false, message: `Unknown MCP server: ${serverId}` };
      }
      const started = Date.now();
      try {
        await createMcpClient(fetchImpl).listTools(server);
        return { ok: true, latencyMs: Date.now() - started };
      } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
      }
    },

    async status(): Promise<StatusResponse> {
      const stored = await loadStored();
      const profile =
        stored.activeProviderId === null
          ? null
          : (stored.providers.find((entry) => entry.id === stored.activeProviderId) ?? null);
      const contextWindow =
        profile === null ? undefined : resolveContextWindow(profile, profile.model);
      return {
        ready: true,
        modes: modes.ids(),
        activeProviderId: stored.activeProviderId,
        activeProvider:
          profile === null
            ? null
            : {
                id: profile.id,
                ...(profile.label === undefined ? {} : { label: profile.label }),
                model: profile.model,
                ...(contextWindow === undefined ? {} : { contextWindow }),
              },
        providerConfigured: stored.providers.length > 0,
        toolCount: tools.size,
        contextMenuCount: contextMenus.size,
        features,
      };
    },

    async getSettings(): Promise<HarnessSettings> {
      return publicFrom(await loadStored());
    },

    async updateSettings(update: HarnessSettingsUpdate): Promise<HarnessSettings> {
      const approvals = update.policies?.toolApprovals;
      if (approvals !== undefined) {
        for (const [name, rule] of Object.entries(approvals)) {
          if (!tools.has(name)) {
            throw new Error(`Unknown tool: ${name}`);
          }
          if (isBuiltinToolName(name) && rule !== 'always_allow') {
            throw new Error(`Builtin tool '${name}' cannot require approval`);
          }
        }
      }
      const next = applySettingsUpdate(await loadStored(), update);
      await settingsStore.put(next);
      return publicFrom(next);
    },

    getStoredProvider,

    async testConnection(providerId?: string): Promise<ConnectionTestResult> {
      const profile = await getStoredProvider(providerId);
      if (profile === null) {
        return { ok: false, message: 'No provider configured' };
      }
      if (provider.testConnection !== undefined) {
        return provider.testConnection(profile);
      }
      return openai.testConnection(profile);
    },

    async listModels(providerId?: string): Promise<ModelListResponse> {
      const stored = await loadStored();
      const wanted = providerId ?? stored.activeProviderId;
      if (wanted === null) {
        throw new Error('No provider configured');
      }
      const profile = stored.providers.find((entry) => entry.id === wanted);
      if (profile === undefined) {
        throw new Error(`Unknown provider: ${wanted}`);
      }
      const models =
        provider.listModels === undefined
          ? await openai.listModels(profile)
          : await provider.listModels(profile);

      const windows = { ...(profile.modelContextWindows ?? {}) };
      let changed = false;
      for (const entry of models) {
        if (entry.contextWindow !== undefined && windows[entry.id] !== entry.contextWindow) {
          windows[entry.id] = entry.contextWindow;
          changed = true;
        }
      }
      if (changed) {
        await settingsStore.put({
          ...stored,
          providers: stored.providers.map((entry) =>
            entry.id === wanted ? { ...entry, modelContextWindows: windows } : entry,
          ),
        });
      }

      return { providerId: wanted, models };
    },

    createSession,

    async getSession(id: string): Promise<SessionDetail | null> {
      const record = await store.get(id);
      return record === null ? null : toSessionDetail(record, turns.isLive(id));
    },

    async listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
      const summaries = await store.listSummaries(options);
      return summaries.map((summary) =>
        turns.isLive(summary.id) ? { ...summary, turnInProgress: true } : summary,
      );
    },

    async deleteSession(id: string): Promise<boolean> {
      const deleted = await store.delete(id);
      if (deleted) {
        // Session-scoped grants would otherwise outlive their session and could be
        // resolved by a future session that reused the id.
        await grants.clearSession(id);
      }
      return deleted;
    },

    pinTurn,

    async previewPrompt(input): Promise<PromptPreview> {
      if (!modes.has(input.mode)) {
        throw new Error(`Unknown mode: ${input.mode}`);
      }
      const stored = await loadStored();
      return composePrompt({
        mode: input.mode,
        modes,
        prompts: promptsFor(stored),
        scope: input.scope ?? {},
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        skills: await skillSummaries(),
        ...(await composeExtras(stored)),
      });
    },

    async listSkills(): Promise<SkillSummary[]> {
      return skillSummaries();
    },

    async toolCatalog(mode: ChatModeId): Promise<ToolCatalogResponse> {
      const allowed = modes.toolNamesFor(mode, tools.modeContext());
      const approvals = approvalsFor(await loadStored());
      return {
        mode,
        tools: tools.catalogForMode(allowed).map((entry) => ({
          ...entry,
          approval: approvals[entry.name] ?? entry.approval,
        })),
      };
    },

    menuCatalog(): ContextMenuDescriptor[] {
      return contextMenus.descriptors();
    },

    async listMenuItems(menuId, options = {}): Promise<ContextMenuItemsResponse> {
      return contextMenus.listItems(menuId, options);
    },

    runTurn: (request, signal) => turns.runTurn(request, signal),
    cancel: (sessionId, reason) =>
      reason === undefined ? turns.cancel(sessionId) : turns.cancel(sessionId, reason),
    decideToolApproval: (sessionId, approvalId, decision) =>
      turns.decideToolApproval(sessionId, approvalId, decision),
    answerAskUser: (sessionId, askId, answers) => turns.answerAskUser(sessionId, askId, answers),
    approvePlan: (sessionId) => turns.approvePlan(sessionId),
    discardPlan: (sessionId) => turns.discardPlan(sessionId),
    decideModeSwitch: (sessionId, approve) => turns.decideModeSwitch(sessionId, approve),
  };
}

export { toSessionSummary };
