import type {
  AgentProfile,
  AgentProfileWrite,
  CompactionSettings,
  HarnessSettings,
  HarnessSettingsUpdate,
  McpPermissions,
  McpServer,
  McpServerWrite,
  PolicySettings,
  PromptSettings,
  ProviderProfile,
  ProviderProfileWrite,
  SearchProvider,
  SearchProviderWrite,
} from '@evu/harness-protocol';
import {
  McpServerSchema,
  ProviderProfileSchema,
  SearchProviderSchema,
} from '@evu/harness-protocol';
import { DEFAULT_MCP_PERMISSIONS } from './mcp-permissions.js';
import { compactOverrideMap } from './model-catalog.js';

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
  modelContextWindows?: Record<string, number>;
  modelContextWindowOverrides?: Record<string, number>;
  active?: boolean;
}

/**
 * A provider as stored, including the credential.
 *
 * This type never crosses a network boundary. `toPublicProvider` is the only
 * conversion out, and it cannot express `apiKey`.
 */
export interface StoredProviderProfile {
  id: string;
  label?: string | undefined;
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  models: string[];
  supportsEffort: boolean;
  supportsReasoning: boolean;
  timeoutMs: number;
  modelContextWindows: Record<string, number>;
  modelContextWindowOverrides: Record<string, number>;
  active: boolean;
}

export interface StoredSearchProvider {
  id: string;
  kind: SearchProvider['kind'];
  label?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
}

export interface StoredMcpServer {
  id: string;
  label?: string | undefined;
  url: string;
  transport: 'streamable-http' | 'sse';
  enabled: boolean;
  apiKey?: string | undefined;
  permissions: McpPermissions;
}

export interface StoredSettings {
  providers: StoredProviderProfile[];
  activeProviderId: string | null;
  prompts: PromptSettings;
  policies: PolicySettings;
  agents: AgentProfile[];
  searchProviders: StoredSearchProvider[];
  activeSearchProviderId: string | null;
  mcpServers: StoredMcpServer[];
  compaction: CompactionSettings;
}

export interface SettingsStore {
  get(): Promise<StoredSettings>;
  put(settings: StoredSettings): Promise<void>;
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  strategy: 'rolling',
  targetPercent: 75,
  keepRecent: 16,
};

export function emptyStoredSettings(): StoredSettings {
  return {
    providers: [],
    activeProviderId: null,
    prompts: { global: '', perMode: {} },
    policies: { toolApprovals: {}, askUserEnabled: true, maxToolRounds: 12 },
    agents: [],
    searchProviders: [],
    activeSearchProviderId: null,
    mcpServers: [],
    compaction: { ...DEFAULT_COMPACTION },
  };
}

/** Fill fields added after a settings payload was first written. */
export function normalizeStoredSettings(raw: StoredSettings): StoredSettings {
  const empty = emptyStoredSettings();
  return {
    ...empty,
    ...raw,
    prompts: { ...empty.prompts, ...raw.prompts },
    policies: { ...empty.policies, ...raw.policies },
    providers: (raw.providers ?? []).map((profile) => ({
      ...profile,
      active: profile.active ?? true,
    })),
    agents: migrateAgents(raw),
    searchProviders: raw.searchProviders ?? [],
    activeSearchProviderId: raw.activeSearchProviderId ?? null,
    mcpServers: raw.mcpServers ?? [],
    compaction: { ...DEFAULT_COMPACTION, ...raw.compaction },
  };
}

/**
 * True when the store still looks like a never-written default.
 *
 * Used to decide whether env/config seeding may run. Checking only
 * `providers.length` would re-seed on every read when a host has prompts or
 * policy edits but no provider profiles, wiping those saves.
 */
export function isPristineStoredSettings(settings: StoredSettings): boolean {
  return (
    settings.providers.length === 0 &&
    settings.activeProviderId === null &&
    settings.prompts.global === '' &&
    Object.keys(settings.prompts.perMode).length === 0 &&
    Object.keys(settings.policies.toolApprovals ?? {}).length === 0 &&
    (settings.policies.askUserEnabled ?? true) === true &&
    (settings.policies.maxToolRounds ?? 12) === 12 &&
    (settings.agents ?? []).length === 0 &&
    (settings.searchProviders ?? []).length === 0 &&
    (settings.mcpServers ?? []).length === 0
  );
}

export function storedFromInput(input: ProviderProfileInput): StoredProviderProfile {
  return {
    id: input.id,
    ...(input.label === undefined ? {} : { label: input.label }),
    baseUrl: input.baseUrl,
    model: input.model,
    ...(input.apiKey === undefined || input.apiKey === '' ? {} : { apiKey: input.apiKey }),
    models: input.models ?? [],
    supportsEffort: input.supportsEffort ?? false,
    supportsReasoning: input.supportsReasoning ?? false,
    timeoutMs: input.timeoutMs ?? 120_000,
    modelContextWindows: input.modelContextWindows ?? {},
    modelContextWindowOverrides: input.modelContextWindowOverrides ?? {},
    active: input.active ?? true,
  };
}

/**
 * The public profile: whether a key exists, never the key.
 *
 * Derived rather than redacted, so a missed strip cannot leak a credential.
 */
export function toPublicProvider(stored: StoredProviderProfile): ProviderProfile {
  return ProviderProfileSchema.parse({
    id: stored.id,
    ...(stored.label === undefined ? {} : { label: stored.label }),
    baseUrl: stored.baseUrl,
    model: stored.model,
    hasApiKey: stored.apiKey !== undefined && stored.apiKey !== '',
    models: stored.models,
    supportsEffort: stored.supportsEffort,
    supportsReasoning: stored.supportsReasoning,
    timeoutMs: stored.timeoutMs,
    modelContextWindows: stored.modelContextWindows ?? {},
    modelContextWindowOverrides: stored.modelContextWindowOverrides ?? {},
    active: stored.active,
  });
}

export function toPublicSettings(
  stored: StoredSettings,
  extras: { modes: string[]; toolApprovals: PolicySettings['toolApprovals'] },
): HarnessSettings {
  return {
    providers: stored.providers.map(toPublicProvider),
    activeProviderId: stored.activeProviderId,
    prompts: stored.prompts,
    policies: {
      // Effective map (registry defaults merged with overrides), not the raw
      // override bag — a settings UI must show every registered tool.
      toolApprovals: extras.toolApprovals,
      askUserEnabled: stored.policies.askUserEnabled ?? true,
      maxToolRounds: stored.policies.maxToolRounds ?? 12,
    },
    modes: extras.modes,
    agents: stored.agents ?? [],
    searchProviders: (stored.searchProviders ?? []).map(toPublicSearchProvider),
    activeSearchProviderId: stored.activeSearchProviderId ?? null,
    mcpServers: (stored.mcpServers ?? []).map(toPublicMcpServer),
    compaction: stored.compaction ?? DEFAULT_COMPACTION,
  };
}

function toPublicSearchProvider(stored: StoredSearchProvider): SearchProvider {
  return SearchProviderSchema.parse({
    id: stored.id,
    kind: stored.kind,
    ...(stored.label === undefined ? {} : { label: stored.label }),
    ...(stored.baseUrl === undefined ? {} : { baseUrl: stored.baseUrl }),
    hasApiKey: stored.apiKey !== undefined && stored.apiKey !== '',
  });
}

function toPublicMcpServer(stored: StoredMcpServer): McpServer {
  return McpServerSchema.parse({
    id: stored.id,
    ...(stored.label === undefined ? {} : { label: stored.label }),
    url: stored.url,
    transport: stored.transport,
    enabled: stored.enabled,
    hasAuth: stored.apiKey !== undefined && stored.apiKey !== '',
    permissions: stored.permissions,
  });
}

/**
 * Merge registry defaults with stored per-tool overrides.
 *
 * Builtin gate tools stay `always_allow`: they open a human gate rather than
 * causing a side effect, so a settings override must not force an approval on
 * them (see SPEC.md builtin exemption).
 */
export function effectiveToolApprovals(
  defaults: PolicySettings['toolApprovals'],
  overrides: PolicySettings['toolApprovals'],
  /**
   * Gate tools only. Side-effect builtins (write_user, mcp_call, …) keep their
   * own approval rule so a settings override can still require a decision.
   */
  gateNames: ReadonlySet<string>,
): PolicySettings['toolApprovals'] {
  const merged: PolicySettings['toolApprovals'] = { ...defaults };
  for (const [name, rule] of Object.entries(overrides)) {
    if (gateNames.has(name)) {
      merged[name] = 'always_allow';
      continue;
    }
    merged[name] = rule;
  }
  for (const name of gateNames) {
    merged[name] = 'always_allow';
  }
  return merged;
}

function upsertProvider(
  current: StoredProviderProfile | undefined,
  write: ProviderProfileWrite,
): StoredProviderProfile {
  const created: StoredProviderProfile = {
    id: write.id,
    baseUrl: write.baseUrl,
    model: write.model,
    models: [],
    supportsEffort: false,
    supportsReasoning: false,
    timeoutMs: 120_000,
    modelContextWindows: {},
    modelContextWindowOverrides: {},
    active: true,
  };
  const base: StoredProviderProfile = {
    ...(current ?? created),
    modelContextWindows: current?.modelContextWindows ?? {},
    modelContextWindowOverrides: current?.modelContextWindowOverrides ?? {},
  };

  const next: StoredProviderProfile = {
    ...base,
    baseUrl: write.baseUrl,
    model: write.model,
    ...(write.label === undefined ? {} : { label: write.label }),
    models: write.models ?? base.models,
    supportsEffort: write.supportsEffort ?? base.supportsEffort,
    supportsReasoning: write.supportsReasoning ?? base.supportsReasoning,
    timeoutMs: write.timeoutMs ?? base.timeoutMs,
    modelContextWindows: write.modelContextWindows ?? base.modelContextWindows,
    modelContextWindowOverrides:
      write.modelContextWindowOverrides === undefined
        ? base.modelContextWindowOverrides
        : compactOverrideMap(write.modelContextWindowOverrides),
    active: write.active ?? base.active,
  };

  if (write.apiKey === undefined) {
    return next;
  }
  if (write.apiKey === null || write.apiKey === '') {
    const { apiKey: _cleared, ...rest } = next;
    return rest;
  }
  return { ...next, apiKey: write.apiKey };
}

/**
 * Apply a partial settings update.
 *
 * Providers are upserted by id. Removals are explicit. The active id is checked
 * against the post-update set so a tab cannot point at a profile that no longer
 * exists, including one it just deleted.
 */
export function applySettingsUpdate(
  current: StoredSettings,
  update: HarnessSettingsUpdate,
): StoredSettings {
  const byId = new Map(current.providers.map((provider) => [provider.id, provider]));

  for (const id of update.removeProviderIds ?? []) {
    byId.delete(id);
  }
  for (const write of update.providers ?? []) {
    byId.set(write.id, upsertProvider(byId.get(write.id), write));
  }

  let providers = [...byId.values()];
  const providerIds = new Set(providers.map((provider) => provider.id));

  let activeProviderId = current.activeProviderId;
  if (update.activeProviderId !== undefined) {
    activeProviderId = update.activeProviderId;
    if (activeProviderId !== null && !providerIds.has(activeProviderId)) {
      throw new Error(`Unknown activeProviderId: ${activeProviderId}`);
    }
    if (activeProviderId !== null) {
      // Default implies available in the picker.
      providers = providers.map((profile) =>
        profile.id === activeProviderId ? { ...profile, active: true } : profile,
      );
    }
  } else if (activeProviderId !== null && !providerIds.has(activeProviderId)) {
    // The default profile was removed in this update. Repoint rather than
    // rejecting — a delete that names only the id must not require the client
    // to also send a new default id.
    activeProviderId = firstActiveProviderId(providers);
  } else if (activeProviderId === null && providers.length > 0) {
    // First upsert that forgot to set default: pick the first active (or first)
    // so a UI that adds one profile does not leave the harness with nowhere to send.
    activeProviderId = firstActiveProviderId(providers) ?? providers[0]?.id ?? null;
  }

  if (
    activeProviderId !== null &&
    providers.find((profile) => profile.id === activeProviderId)?.active === false
  ) {
    activeProviderId = firstActiveProviderId(providers);
  }

  const agents = upsertNamed(
    current.agents ?? [],
    update.agents,
    update.removeAgentIds,
    upsertAgent,
  );

  const searchProviders = upsertNamed(
    current.searchProviders ?? [],
    update.searchProviders,
    update.removeSearchProviderIds,
    upsertSearchProvider,
  );
  const activeSearchProviderId = nextActiveId(
    current.activeSearchProviderId ?? null,
    update.activeSearchProviderId,
    searchProviders.map((provider) => provider.id),
  );

  const mcpServers = upsertNamed(
    current.mcpServers ?? [],
    update.mcpServers,
    update.removeMcpServerIds,
    upsertMcpServer,
  );

  return {
    providers,
    activeProviderId,
    prompts: {
      global: update.prompts?.global ?? current.prompts.global,
      perMode: { ...current.prompts.perMode, ...update.prompts?.perMode },
    },
    policies: {
      // Upsert-by-name, same reason as providers: a tools tab must not wipe
      // approvals another tab did not send.
      toolApprovals: {
        ...(current.policies.toolApprovals ?? {}),
        ...(update.policies?.toolApprovals ?? {}),
      },
      askUserEnabled: update.policies?.askUserEnabled ?? current.policies.askUserEnabled ?? true,
      maxToolRounds: update.policies?.maxToolRounds ?? current.policies.maxToolRounds ?? 12,
    },
    agents,
    searchProviders,
    activeSearchProviderId,
    mcpServers,
    compaction: {
      strategy:
        update.compaction?.strategy ?? current.compaction?.strategy ?? DEFAULT_COMPACTION.strategy,
      targetPercent:
        update.compaction?.targetPercent ??
        current.compaction?.targetPercent ??
        DEFAULT_COMPACTION.targetPercent,
      keepRecent:
        update.compaction?.keepRecent ??
        current.compaction?.keepRecent ??
        DEFAULT_COMPACTION.keepRecent,
    },
  };
}

function nextActiveId(
  current: string | null,
  update: string | null | undefined,
  ids: string[],
): string | null {
  const set = new Set(ids);
  if (update !== undefined) {
    if (update !== null && !set.has(update)) {
      throw new Error(`Unknown id: ${update}`);
    }
    return update;
  }
  if (current !== null && !set.has(current)) return ids[0] ?? null;
  if (current === null && ids.length > 0) return ids[0] ?? null;
  return current;
}

function upsertNamed<TStored extends { id: string }, TWrite extends { id: string }>(
  current: TStored[],
  writes: TWrite[] | undefined,
  removeIds: string[] | undefined,
  upsert: (existing: TStored | undefined, write: TWrite) => TStored,
): TStored[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const id of removeIds ?? []) {
    byId.delete(id);
  }
  for (const write of writes ?? []) {
    byId.set(write.id, upsert(byId.get(write.id), write));
  }
  return [...byId.values()];
}

function firstActiveProviderId(providers: readonly StoredProviderProfile[]): string | null {
  return providers.find((profile) => profile.active)?.id ?? null;
}

function migrateAgents(raw: StoredSettings & { activeAgentId?: string | null }): AgentProfile[] {
  const previous = raw.activeAgentId ?? null;
  return (raw.agents ?? []).map((agent) => ({
    ...agent,
    active: agent.active ?? (previous !== null && previous === agent.id),
  }));
}

function upsertAgent(current: AgentProfile | undefined, write: AgentProfileWrite): AgentProfile {
  return {
    id: write.id,
    ...(write.label === undefined ? {} : { label: write.label }),
    soul: write.soul,
    active: write.active ?? current?.active ?? true,
  };
}

function keepOptional<T>(write: T | undefined, current: T | undefined): { value?: T } {
  if (write !== undefined) return { value: write };
  if (current !== undefined) return { value: current };
  return {};
}

function upsertSearchProvider(
  current: StoredSearchProvider | undefined,
  write: SearchProviderWrite,
): StoredSearchProvider {
  const label = keepOptional(write.label, current?.label);
  const baseUrl = keepOptional(write.baseUrl, current?.baseUrl);
  const next: StoredSearchProvider = {
    id: write.id,
    kind: write.kind,
    ...(label.value === undefined ? {} : { label: label.value }),
    ...(baseUrl.value === undefined ? {} : { baseUrl: baseUrl.value }),
    ...(current?.apiKey === undefined ? {} : { apiKey: current.apiKey }),
  };
  if (write.apiKey === undefined) return next;
  if (write.apiKey === null || write.apiKey === '') {
    const { apiKey: _cleared, ...rest } = next;
    return rest;
  }
  return { ...next, apiKey: write.apiKey };
}

function upsertMcpServer(
  current: StoredMcpServer | undefined,
  write: McpServerWrite,
): StoredMcpServer {
  const label = keepOptional(write.label, current?.label);
  const next: StoredMcpServer = {
    id: write.id,
    url: write.url,
    transport: write.transport ?? current?.transport ?? 'streamable-http',
    enabled: write.enabled ?? current?.enabled ?? true,
    permissions: write.permissions ?? current?.permissions ?? DEFAULT_MCP_PERMISSIONS,
    ...(label.value === undefined ? {} : { label: label.value }),
    ...(current?.apiKey === undefined ? {} : { apiKey: current.apiKey }),
  };
  if (write.apiKey === undefined) return next;
  if (write.apiKey === null || write.apiKey === '') {
    const { apiKey: _cleared, ...rest } = next;
    return rest;
  }
  return { ...next, apiKey: write.apiKey };
}

export class InMemorySettingsStore implements SettingsStore {
  private settings: StoredSettings;

  constructor(initial: StoredSettings = emptyStoredSettings()) {
    this.settings = structuredClone(initial);
  }

  async get(): Promise<StoredSettings> {
    return structuredClone(this.settings);
  }

  async put(settings: StoredSettings): Promise<void> {
    this.settings = structuredClone(settings);
  }
}
