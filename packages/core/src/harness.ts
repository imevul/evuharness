import type {
  ChatModeId,
  ChatRequest,
  ConnectionTestResult,
  ContextMenuDescriptor,
  ContextMenuItemsResponse,
  HarnessSettings,
  HarnessSettingsUpdate,
  ModelListResponse,
  PromptPreview,
  Scope,
  SessionDetail,
  SessionSummary,
  StatusResponse,
  StreamEvent,
  ToolCatalogResponse,
} from '@evu/harness-protocol';
import type { ContextMenuDefinition } from './context-menus/index.js';
import { ContextMenuRegistry } from './context-menus/index.js';
import type { ProviderAdapter } from './fake-provider.js';
import type { GrantStore } from './grants.js';
import { createTurnPin, setSessionMode, type TurnPin } from './mode-pinning.js';
import { resolveContextWindow } from './model-catalog.js';
import { type ModePolicy, ModeRegistry, STOCK_MODES } from './modes.js';
import { OpenAICompatibleClient } from './openai-client.js';
import { composePrompt, type PromptConfig } from './prompts.js';
import {
  createSessionRecord,
  type SessionRecord,
  toSessionDetail,
  toSessionSummary,
} from './session-record.js';
import {
  applySettingsUpdate,
  emptyStoredSettings,
  InMemorySettingsStore,
  type ProviderProfileInput,
  type SettingsStore,
  type StoredProviderProfile,
  storedFromInput,
  toPublicSettings,
} from './settings-store.js';
import type { ListSessionsOptions, SessionStore } from './stores.js';
import { InMemoryGrantStore, InMemorySessionStore } from './stores.js';
import { type ToolDefinition, ToolRegistry } from './tools.js';
import { createTurnController } from './turn-loop.js';

export type {
  ProviderProfileInput,
  SettingsStore,
  StoredProviderProfile,
} from './settings-store.js';
export { InMemorySettingsStore } from './settings-store.js';

export interface HarnessPolicies {
  askUser?: boolean;
  maxToolRounds?: number;
}

export interface HarnessFeatures {
  settings?: boolean;
  effort?: boolean;
  attachments?: boolean;
}

/**
 * The host composition surface.
 *
 * Every list is an extension point. A host adds modes, tools, menus, prompt slots,
 * and providers; it does not fork the turn loop.
 */
export interface HarnessConfig {
  store?: SessionStore;
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
  policies?: HarnessPolicies;
  features?: HarnessFeatures;
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

  status(): Promise<StatusResponse>;
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

  toolCatalog(mode: ChatModeId): ToolCatalogResponse;
  menuCatalog(): ContextMenuDescriptor[];
  listMenuItems(
    menuId: string,
    options?: { query?: string; path?: string[]; scope?: Scope },
  ): Promise<ContextMenuItemsResponse>;

  runTurn(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
  cancel(sessionId: string, reason?: 'operator' | 'follow_up'): Promise<void>;
}

function defaultIdFactory(): () => string {
  return () => crypto.randomUUID();
}

export function createHarness(config: HarnessConfig = {}): Harness {
  const store = config.store ?? new InMemorySessionStore();
  const grants = config.grants ?? new InMemoryGrantStore();
  const settingsStore = config.settings ?? new InMemorySettingsStore();
  const modes = new ModeRegistry(config.modes ?? STOCK_MODES);
  const tools = new ToolRegistry(config.tools ?? []);
  const contextMenus = new ContextMenuRegistry(config.contextMenus ?? []);
  const hostPrompts: PromptConfig = config.prompts ?? {};
  const newId = config.idFactory ?? defaultIdFactory();
  const now = config.clock ?? (() => new Date().toISOString());
  const openai = new OpenAICompatibleClient({
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
  const provider: ProviderAdapter = config.provider ?? openai;

  const seedProviders = (config.providers ?? []).map(storedFromInput);
  const seedIds = new Set(seedProviders.map((provider) => provider.id));
  if (seedIds.size !== seedProviders.length) {
    throw new Error('Duplicate provider id');
  }
  if (config.activeProviderId !== undefined && !seedIds.has(config.activeProviderId)) {
    throw new Error(`Unknown activeProviderId: ${config.activeProviderId}`);
  }

  const features: Required<HarnessFeatures> = {
    settings: config.features?.settings ?? true,
    effort: config.features?.effort ?? true,
    attachments: config.features?.attachments ?? false,
  };

  /**
   * Load settings, seeding only when the store has never been written.
   *
   * Env and `config.providers` are a first-boot convenience. After a UI writes
   * once, they must not come back on the next process start.
   */
  async function loadStored() {
    const current = await settingsStore.get();
    if (current.providers.length > 0) {
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
      askUserEnabled: config.policies?.askUser ?? true,
      maxToolRounds: config.policies?.maxToolRounds ?? 12,
    };
    if (seeded.providers.length > 0 || seeded.prompts.global !== '') {
      await settingsStore.put(seeded);
    }
    return seeded;
  }

  function promptsFor(stored: Awaited<ReturnType<typeof loadStored>>): PromptConfig {
    const global = stored.prompts.global || hostPrompts.global;
    return {
      ...(global === undefined || global === '' ? {} : { global }),
      perMode: { ...hostPrompts.perMode, ...stored.prompts.perMode },
      ...(hostPrompts.dynamic === undefined ? {} : { dynamic: hostPrompts.dynamic }),
    };
  }

  function publicFrom(stored: Awaited<ReturnType<typeof loadStored>>): HarnessSettings {
    return toPublicSettings(stored, {
      modes: modes.ids(),
      toolApprovals: Object.fromEntries(tools.specs().map((spec) => [spec.name, spec.approval])),
    });
  }

  async function loadRecord(id: string): Promise<SessionRecord> {
    const record = await store.get(id);
    if (record === null) {
      throw new Error(`Unknown session: ${id}`);
    }
    return record;
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
    getStoredProvider,
    pinTurn,
    createSession,
    setSessionMode: async (sessionId, mode) => {
      const record = await loadRecord(sessionId);
      await store.upsert(setSessionMode(record, mode, 'send-time-pin', now()));
    },
    maxToolRounds: async () => (await loadStored()).policies.maxToolRounds,
    now,
  });

  return {
    modes,
    tools,
    contextMenus,
    store,
    grants,
    settingsStore,
    features,

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
      };
    },

    async getSettings(): Promise<HarnessSettings> {
      return publicFrom(await loadStored());
    },

    async updateSettings(update: HarnessSettingsUpdate): Promise<HarnessSettings> {
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
      });
    },

    toolCatalog(mode: ChatModeId): ToolCatalogResponse {
      const allowed = modes.toolNamesFor(mode, tools.modeContext());
      return { mode, tools: tools.catalogForMode(allowed) };
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
  };
}

export { toSessionSummary };
