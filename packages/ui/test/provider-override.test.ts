import { mergeProviderOverrides, resolveActiveProviderSnapshot } from '@evu/harness-ui';
import { describe, expect, it } from 'vitest';

describe('resolveActiveProviderSnapshot', () => {
  const providers = [
    {
      id: 'local',
      label: 'Local',
      baseUrl: 'https://local.test/v1',
      model: 'local-m',
      hasApiKey: false,
      models: ['local-m'],
      supportsEffort: true,
      supportsReasoning: false,
      timeoutMs: 120_000,
      modelContextWindows: { 'local-m': 8_192 },
      modelContextWindowOverrides: {},
      active: true,
    },
    {
      id: 'cloud',
      label: 'Cloud',
      baseUrl: 'https://cloud.test/v1',
      model: 'cloud-m',
      hasApiKey: true,
      models: ['cloud-m', 'bigger'],
      supportsEffort: true,
      supportsReasoning: true,
      timeoutMs: 120_000,
      modelContextWindows: { 'cloud-m': 128_000, bigger: 200_000 },
      modelContextWindowOverrides: {},
      active: true,
    },
  ];

  const base = { id: 'local', label: 'Local', model: 'local-m', contextWindow: 8_192 };

  it('returns the settings snapshot when nothing is overridden', () => {
    expect(resolveActiveProviderSnapshot({ base, providers })).toEqual(base);
  });

  it('applies session then turn precedence', () => {
    expect(
      resolveActiveProviderSnapshot({
        base,
        providers,
        session: { providerId: 'cloud', effort: 'low' },
        turn: { model: 'bigger', effort: 'high' },
      }),
    ).toMatchObject({
      id: 'cloud',
      label: 'Cloud',
      model: 'bigger',
      effort: 'high',
      contextWindow: 200_000,
    });
  });

  it('field-merges the same way as the wire helper', () => {
    expect(
      mergeProviderOverrides({ providerId: 'cloud', effort: 'low' }, { effort: 'high' }),
    ).toEqual({ providerId: 'cloud', effort: 'high' });
  });
});
