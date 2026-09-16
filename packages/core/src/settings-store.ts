import type {
  HarnessSettings,
  HarnessSettingsUpdate,
  PolicySettings,
  PromptSettings,
  ProviderProfile,
  ProviderProfileWrite,
} from '@evu/harness-protocol';
import { ProviderProfileSchema } from '@evu/harness-protocol';
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
}

export interface StoredSettings {
  providers: StoredProviderProfile[];
  activeProviderId: string | null;
  prompts: PromptSettings;
  policies: PolicySettings;
}

export interface SettingsStore {
  get(): Promise<StoredSettings>;
  put(settings: StoredSettings): Promise<void>;
}

export function emptyStoredSettings(): StoredSettings {
  return {
    providers: [],
    activeProviderId: null,
    prompts: { global: '', perMode: {} },
    policies: { toolApprovals: {}, askUserEnabled: true, maxToolRounds: 12 },
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
    (settings.policies.maxToolRounds ?? 12) === 12
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
  };
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
  builtinNames: ReadonlySet<string>,
): PolicySettings['toolApprovals'] {
  const merged: PolicySettings['toolApprovals'] = { ...defaults };
  for (const [name, rule] of Object.entries(overrides)) {
    if (builtinNames.has(name)) {
      merged[name] = 'always_allow';
      continue;
    }
    merged[name] = rule;
  }
  for (const name of builtinNames) {
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

  const providers = [...byId.values()];
  const providerIds = new Set(providers.map((provider) => provider.id));

  let activeProviderId = current.activeProviderId;
  if (update.activeProviderId !== undefined) {
    activeProviderId = update.activeProviderId;
    if (activeProviderId !== null && !providerIds.has(activeProviderId)) {
      throw new Error(`Unknown activeProviderId: ${activeProviderId}`);
    }
  } else if (activeProviderId !== null && !providerIds.has(activeProviderId)) {
    // The active profile was removed in this update. Repoint rather than
    // rejecting — a delete that names only the id must not require the client
    // to also send a new active id.
    activeProviderId = providers[0]?.id ?? null;
  } else if (activeProviderId === null && providers.length > 0) {
    // First upsert that forgot to set active: default to the first remaining id
    // so a UI that adds one profile does not leave the harness with nowhere to send.
    activeProviderId = providers[0]?.id ?? null;
  }

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
  };
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
