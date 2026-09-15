import {
  type ChatModeId,
  type ContextMenuDescriptor,
  type ContextMenuItemsResponse,
  type PromptPreview,
  type ProviderProfile,
  ProviderProfileSchema,
  type Scope,
  type SessionDetail,
  type SessionSummary,
  type StatusResponse,
  type ToolCatalogResponse,
} from '@evu/harness-protocol';
import type { ContextMenuDefinition } from './context-menus/index.js';
import { ContextMenuRegistry } from './context-menus/index.js';
import type { GrantStore } from './grants.js';
import { createTurnPin, type TurnPin } from './mode-pinning.js';
import { type ModePolicy, ModeRegistry, STOCK_MODES } from './modes.js';
import { composePrompt, type PromptConfig } from './prompts.js';
import {
  createSessionRecord,
  type SessionRecord,
  toSessionDetail,
  toSessionSummary,
} from './session-record.js';
import type { ListSessionsOptions, SessionStore } from './stores.js';
import { InMemoryGrantStore, InMemorySessionStore } from './stores.js';
import { type ToolDefinition, ToolRegistry } from './tools.js';

export interface ProviderProfileInput {
  id: string;
  baseUrl: string;
  model: string;
  label?: string;
  apiKey?: string;
  models?: string[];
  supportsEffort?: boolean;
  supportsReasoning?: boolean;
  timeoutMs?: number;
}

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
  readonly providers: readonly ProviderProfile[];
  readonly activeProviderId: string | null;
  readonly policies: Required<HarnessPolicies>;
  readonly features: Required<HarnessFeatures>;

  status(): StatusResponse;
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
}

function defaultIdFactory(): () => string {
  return () => crypto.randomUUID();
}

export function createHarness(config: HarnessConfig = {}): Harness {
  const store = config.store ?? new InMemorySessionStore();
  const grants = config.grants ?? new InMemoryGrantStore();
  const modes = new ModeRegistry(config.modes ?? STOCK_MODES);
  const tools = new ToolRegistry(config.tools ?? []);
  const contextMenus = new ContextMenuRegistry(config.contextMenus ?? []);
  const prompts: PromptConfig = config.prompts ?? {};
  const newId = config.idFactory ?? defaultIdFactory();
  const now = config.clock ?? (() => new Date().toISOString());

  const providers: ProviderProfile[] = (config.providers ?? []).map((input) =>
    // `hasApiKey` is derived rather than accepted, so a credential can never be
    // echoed back through a settings response.
    ProviderProfileSchema.parse({
      id: input.id,
      ...(input.label === undefined ? {} : { label: input.label }),
      baseUrl: input.baseUrl,
      model: input.model,
      hasApiKey: input.apiKey !== undefined && input.apiKey !== '',
      models: input.models ?? [],
      supportsEffort: input.supportsEffort ?? false,
      supportsReasoning: input.supportsReasoning ?? false,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }),
  );

  const providerIds = new Set(providers.map((provider) => provider.id));
  if (providerIds.size !== providers.length) {
    throw new Error('Duplicate provider id');
  }
  if (config.activeProviderId !== undefined && !providerIds.has(config.activeProviderId)) {
    throw new Error(`Unknown activeProviderId: ${config.activeProviderId}`);
  }

  const activeProviderId = config.activeProviderId ?? providers[0]?.id ?? null;

  const policies: Required<HarnessPolicies> = {
    askUser: config.policies?.askUser ?? true,
    maxToolRounds: config.policies?.maxToolRounds ?? 12,
  };

  const features: Required<HarnessFeatures> = {
    settings: config.features?.settings ?? true,
    effort: config.features?.effort ?? true,
    attachments: config.features?.attachments ?? false,
  };

  async function loadRecord(id: string): Promise<SessionRecord> {
    const record = await store.get(id);
    if (record === null) {
      throw new Error(`Unknown session: ${id}`);
    }
    return record;
  }

  return {
    modes,
    tools,
    contextMenus,
    store,
    grants,
    providers,
    activeProviderId,
    policies,
    features,

    status(): StatusResponse {
      return {
        ready: true,
        modes: modes.ids(),
        activeProviderId,
        providerConfigured: providers.length > 0,
        toolCount: tools.size,
        contextMenuCount: contextMenus.size,
      };
    },

    async createSession(options: CreateSessionOptions = {}): Promise<SessionDetail> {
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
    },

    async getSession(id: string): Promise<SessionDetail | null> {
      const record = await store.get(id);
      return record === null ? null : toSessionDetail(record);
    },

    async listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
      return store.listSummaries(options);
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

    async pinTurn(input): Promise<TurnPin> {
      const record = await loadRecord(input.sessionId);
      if (!modes.has(input.mode)) {
        throw new Error(`Unknown mode: ${input.mode}`);
      }

      const scope: Scope =
        input.scope ??
        (record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId });

      const allowed = modes.toolNamesFor(input.mode, tools.modeContext());
      const prompt = await composePrompt({
        mode: input.mode,
        modes,
        prompts,
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
    },

    async previewPrompt(input): Promise<PromptPreview> {
      if (!modes.has(input.mode)) {
        throw new Error(`Unknown mode: ${input.mode}`);
      }
      return composePrompt({
        mode: input.mode,
        modes,
        prompts,
        scope: input.scope ?? {},
        sessionId: input.sessionId,
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
  };
}

export { toSessionSummary };
