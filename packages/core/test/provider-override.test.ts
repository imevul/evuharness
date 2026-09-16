import {
  createSessionRecord,
  mergeProviderOverrides,
  resolveProviderSelection,
  type StoredProviderProfile,
  setSessionProvider,
} from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

const LOCAL: StoredProviderProfile = {
  id: 'local',
  baseUrl: 'https://local.test/v1',
  model: 'local-model',
  supportsEffort: true,
  supportsReasoning: false,
  timeoutMs: 120_000,
  modelContextWindows: { 'local-model': 8_192 },
  modelContextWindowOverrides: {},
};

const CLOUD: StoredProviderProfile = {
  id: 'cloud',
  label: 'Cloud',
  baseUrl: 'https://cloud.test/v1',
  model: 'cloud-model',
  supportsEffort: true,
  supportsReasoning: true,
  timeoutMs: 120_000,
  modelContextWindows: { 'cloud-model': 128_000, 'bigger-model': 200_000 },
  modelContextWindowOverrides: {},
};

const profiles = new Map<string, StoredProviderProfile>([
  [LOCAL.id, LOCAL],
  [CLOUD.id, CLOUD],
]);

async function getProfile(id?: string): Promise<StoredProviderProfile | null> {
  if (id === undefined) return LOCAL;
  return profiles.get(id) ?? null;
}

describe('mergeProviderOverrides', () => {
  it('lets later layers win per field', () => {
    expect(
      mergeProviderOverrides(
        { providerId: 'local', model: 'a', effort: 'low' },
        { model: 'b', effort: 'high' },
      ),
    ).toEqual({ providerId: 'local', model: 'b', effort: 'high' });
  });

  it('returns undefined when every layer is empty', () => {
    expect(mergeProviderOverrides(undefined, null, {})).toBeUndefined();
  });
});

describe('resolveProviderSelection precedence', () => {
  it('uses the settings active profile when nothing is overridden', async () => {
    const resolved = await resolveProviderSelection(getProfile, undefined, undefined);
    expect(resolved).toMatchObject({ model: 'local-model', profile: { id: 'local' } });
    expect(resolved?.effort).toBeUndefined();
    expect(resolved?.override).toBeUndefined();
  });

  it('applies a session override over settings', async () => {
    const resolved = await resolveProviderSelection(
      getProfile,
      { providerId: 'cloud', effort: 'medium' },
      undefined,
    );
    expect(resolved).toMatchObject({
      profile: { id: 'cloud' },
      model: 'cloud-model',
      effort: 'medium',
    });
  });

  it('lets a turn override win over the session', async () => {
    const resolved = await resolveProviderSelection(
      getProfile,
      { providerId: 'cloud', model: 'cloud-model', effort: 'low' },
      { model: 'bigger-model', effort: 'high' },
    );
    expect(resolved).toMatchObject({
      profile: { id: 'cloud' },
      model: 'bigger-model',
      effort: 'high',
    });
  });

  it('can switch provider on the turn while keeping a session model override', async () => {
    const resolved = await resolveProviderSelection(
      getProfile,
      { model: 'session-model' },
      { providerId: 'cloud' },
    );
    expect(resolved).toMatchObject({
      profile: { id: 'cloud' },
      model: 'session-model',
    });
  });
});

describe('setSessionProvider', () => {
  it('persists a preference without mutating the prior record', () => {
    const stored = createSessionRecord({ id: 's1', mode: 'ask' });
    const next = setSessionProvider(stored, { model: 'bigger-model', effort: 'high' });
    expect(next.provider).toEqual({ model: 'bigger-model', effort: 'high' });
    expect(stored.provider).toBeUndefined();
  });

  it('clears with null', () => {
    const stored = setSessionProvider(createSessionRecord({ id: 's1', mode: 'ask' }), {
      model: 'm',
    });
    const cleared = setSessionProvider(stored, null);
    expect(cleared.provider).toBeUndefined();
  });
});
