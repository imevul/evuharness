import type {
  ActiveProviderSnapshot,
  ProviderOverride,
  ProviderProfile,
  ReasoningEffort,
} from '@evu/harness-protocol';
import { mergeProviderOverrides } from '@evu/harness-protocol';

export { mergeProviderOverrides };

/**
 * Resolve the status-bar snapshot after session and optional draft/turn overrides.
 *
 * `base` is the settings active profile snapshot from `/status`. When an override
 * names another `providerId`, that profile is looked up in `providers`. Named
 * profiles are never mutated — this only projects what a turn would call.
 *
 * Precedence: turn/draft > session > settings.
 */
export function resolveActiveProviderSnapshot(input: {
  base: ActiveProviderSnapshot | null;
  providers?: readonly ProviderProfile[];
  session?: ProviderOverride | null | undefined;
  turn?: ProviderOverride | null | undefined;
}): ActiveProviderSnapshot | null {
  const override = mergeProviderOverrides(input.session, input.turn);
  if (override === undefined) {
    return input.base;
  }

  const profile =
    override.providerId === undefined
      ? null
      : (input.providers?.find((entry) => entry.id === override.providerId) ?? null);

  if (
    override.providerId !== undefined &&
    profile === null &&
    input.base?.id !== override.providerId
  ) {
    if (input.base === null) return null;
    return withOverride(input.base, override.model, override.effort);
  }

  const base: ActiveProviderSnapshot | null =
    profile === null
      ? input.base
      : {
          id: profile.id,
          ...(profile.label === undefined ? {} : { label: profile.label }),
          model: profile.model,
          ...(resolveModelContextWindow(profile, profile.model) === undefined
            ? {}
            : { contextWindow: resolveModelContextWindow(profile, profile.model) }),
        };

  if (base === null) {
    return null;
  }

  const model = override.model ?? base.model;
  const window =
    profile === null
      ? base.contextWindow
      : (resolveModelContextWindow(profile, model) ??
        (model === base.model ? base.contextWindow : undefined));

  return {
    id: base.id,
    ...(base.label === undefined ? {} : { label: base.label }),
    model,
    ...(override.effort === undefined ? {} : { effort: override.effort }),
    ...(window === undefined ? {} : { contextWindow: window }),
  };
}

function withOverride(
  base: ActiveProviderSnapshot,
  model: string | undefined,
  effort: ReasoningEffort | undefined,
): ActiveProviderSnapshot {
  return {
    ...base,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/**
 * The context window in force for a model: the user's override, else the catalog
 * value the provider last reported.
 *
 * Exported because the settings hint and the status bar donut must not be able to
 * disagree about which number a turn will actually use.
 */
export function resolveModelContextWindow(
  profile: ProviderProfile,
  model: string,
): number | undefined {
  return profile.modelContextWindowOverrides[model] ?? profile.modelContextWindows[model];
}
