import type { ProviderOverride, ReasoningEffort } from '@evu/harness-protocol';
import { mergeProviderOverrides } from '@evu/harness-protocol';
import type { SessionRecord } from './session-record.js';
import type { StoredProviderProfile } from './settings-store.js';

export { mergeProviderOverrides };

/**
 * What a turn should call after applying session and turn overrides on top of
 * the settings active profile.
 *
 * Precedence is turn > session > settings. Named profiles are never mutated.
 */
export interface ResolvedProviderSelection {
  profile: StoredProviderProfile;
  model: string;
  effort?: ReasoningEffort | undefined;
  /** The merged override that produced this selection, if any field was set. */
  override?: ProviderOverride | undefined;
}

export async function resolveProviderSelection(
  getProfile: (id?: string) => StoredProviderProfile | null | Promise<StoredProviderProfile | null>,
  sessionOverride: ProviderOverride | undefined,
  turnOverride: ProviderOverride | undefined,
): Promise<ResolvedProviderSelection | null> {
  const override = mergeProviderOverrides(sessionOverride, turnOverride);
  const profile = await getProfile(override?.providerId);
  if (profile === null) {
    return null;
  }
  return {
    profile,
    model: override?.model ?? profile.model,
    ...(override?.effort === undefined ? {} : { effort: override.effort }),
    ...(override === undefined ? {} : { override }),
  };
}

/** Persist or clear the session-level provider preference. */
export function setSessionProvider(
  stored: SessionRecord,
  provider: ProviderOverride | null,
  now?: string,
): SessionRecord {
  const next = provider === null ? undefined : mergeProviderOverrides(provider);
  if (next === undefined) {
    if (stored.provider === undefined) {
      return stored;
    }
    const { provider: _removed, ...rest } = stored;
    return { ...rest, updatedAt: now ?? new Date().toISOString() };
  }

  return {
    ...stored,
    provider: next,
    updatedAt: now ?? new Date().toISOString(),
  };
}
