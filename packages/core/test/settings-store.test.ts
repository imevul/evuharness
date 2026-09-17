import {
  applySettingsUpdate,
  createHarness,
  emptyStoredSettings,
  storedFromInput,
  toPublicProvider,
} from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

const LOCAL = storedFromInput({
  id: 'local',
  baseUrl: 'https://example.test/v1',
  model: 'm',
  apiKey: 'secret',
});

describe('toPublicProvider', () => {
  it('derives hasApiKey and cannot express the secret', () => {
    const publicProfile = toPublicProvider(LOCAL);

    expect(publicProfile.hasApiKey).toBe(true);
    expect(publicProfile).not.toHaveProperty('apiKey');
    expect(JSON.stringify(publicProfile)).not.toContain('secret');
  });
});

describe('applySettingsUpdate', () => {
  it('upserts by id without replacing unrelated profiles', () => {
    const current = emptyStoredSettings();
    current.providers = [LOCAL];

    const next = applySettingsUpdate(current, {
      providers: [{ id: 'cloud', baseUrl: 'https://cloud.test/v1', model: 'big' }],
    });

    expect(next.providers.map((p) => p.id)).toEqual(['local', 'cloud']);
    expect(next.providers[0]?.apiKey).toBe('secret');
  });

  it('leaves an omitted apiKey unchanged and clears on null', () => {
    const current = emptyStoredSettings();
    current.providers = [LOCAL];

    const kept = applySettingsUpdate(current, {
      providers: [{ id: 'local', baseUrl: 'https://example.test/v1', model: 'm2' }],
    });
    expect(kept.providers[0]).toMatchObject({ model: 'm2', apiKey: 'secret' });

    const cleared = applySettingsUpdate(kept, {
      providers: [{ id: 'local', baseUrl: 'https://example.test/v1', model: 'm2', apiKey: null }],
    });
    expect(cleared.providers[0]?.apiKey).toBeUndefined();
  });

  it('removes only the named ids', () => {
    const current = emptyStoredSettings();
    current.providers = [
      LOCAL,
      storedFromInput({ id: 'other', baseUrl: 'https://b.test/v1', model: 'n' }),
    ];
    current.activeProviderId = 'local';

    const next = applySettingsUpdate(current, { removeProviderIds: ['other'] });

    expect(next.providers.map((p) => p.id)).toEqual(['local']);
    expect(next.activeProviderId).toBe('local');
  });

  it('rejects an active id that is not in the store after the update', () => {
    expect(() =>
      applySettingsUpdate(emptyStoredSettings(), { activeProviderId: 'missing' }),
    ).toThrow(/Unknown activeProviderId/);
  });

  it('defaults active to the first profile when adding the first one', () => {
    const next = applySettingsUpdate(emptyStoredSettings(), {
      providers: [{ id: 'local', baseUrl: 'https://example.test/v1', model: 'm' }],
    });

    expect(next.activeProviderId).toBe('local');
  });

  it('repoints active when the current profile is removed', () => {
    const current = emptyStoredSettings();
    current.providers = [
      LOCAL,
      storedFromInput({ id: 'other', baseUrl: 'https://b.test/v1', model: 'n' }),
    ];
    current.activeProviderId = 'local';

    const next = applySettingsUpdate(current, { removeProviderIds: ['local'] });

    expect(next.activeProviderId).toBe('other');
  });

  it('replaces per-model overrides when sent and leaves them when omitted', () => {
    const current = emptyStoredSettings();
    current.providers = [
      storedFromInput({
        id: 'local',
        baseUrl: 'https://example.test/v1',
        model: 'a',
        modelContextWindows: { a: 8_192, b: 4_096 },
        modelContextWindowOverrides: { a: 2_048 },
      }),
    ];

    const left = applySettingsUpdate(current, {
      providers: [{ id: 'local', baseUrl: 'https://example.test/v1', model: 'b' }],
    });
    expect(left.providers[0]?.modelContextWindowOverrides).toEqual({ a: 2_048 });
    expect(left.providers[0]?.modelContextWindows).toEqual({ a: 8_192, b: 4_096 });

    const cleared = applySettingsUpdate(left, {
      providers: [
        {
          id: 'local',
          baseUrl: 'https://example.test/v1',
          model: 'b',
          modelContextWindowOverrides: { a: null, b: 1_024 },
        },
      ],
    });
    expect(cleared.providers[0]?.modelContextWindowOverrides).toEqual({ b: 1_024 });
  });

  it('upserts agents and search providers without replacing siblings', () => {
    const current = emptyStoredSettings();
    current.agents = [{ id: 'guide', soul: 'old' }];

    const next = applySettingsUpdate(current, {
      agents: [{ id: 'poet', label: 'Poet', soul: 'verse' }],
      searchProviders: [{ id: 'ddg', kind: 'duckduckgo', label: 'DuckDuckGo' }],
    });

    expect(next.agents.map((agent) => agent.id)).toEqual(['guide', 'poet']);
    expect(next.searchProviders.map((provider) => provider.id)).toEqual(['ddg']);
    expect(next.activeSearchProviderId).toBe('ddg');
  });

  it('merges prompt patches without wiping sibling modes', () => {
    const current = emptyStoredSettings();
    current.prompts = { global: 'g0', perMode: { ask: 'a0', agent: 'ag0' } };

    const next = applySettingsUpdate(current, {
      prompts: { global: 'g1', perMode: { ask: 'a1' } },
    });

    expect(next.prompts).toEqual({
      global: 'g1',
      perMode: { ask: 'a1', agent: 'ag0' },
    });
  });
});

describe('createHarness settings', () => {
  it('seeds once, then the store wins over config.providers', async () => {
    const runtime = createHarness({
      providers: [
        { id: 'env', baseUrl: 'https://env.test/v1', model: 'env-model', apiKey: 'from-env' },
      ],
    });

    await runtime.updateSettings({
      providers: [{ id: 'env', baseUrl: 'https://ui.test/v1', model: 'ui-model' }],
    });

    const settings = await runtime.getSettings();
    expect(settings.providers[0]).toMatchObject({
      baseUrl: 'https://ui.test/v1',
      model: 'ui-model',
      hasApiKey: true,
    });
    expect(JSON.stringify(settings)).not.toContain('from-env');
  });

  it('returns the secret only through getStoredProvider', async () => {
    const runtime = createHarness({
      providers: [{ id: 'env', baseUrl: 'https://env.test/v1', model: 'm', apiKey: 'from-env' }],
    });

    const stored = await runtime.getStoredProvider();
    expect(stored?.apiKey).toBe('from-env');
    expect(JSON.stringify(await runtime.getSettings())).not.toContain('from-env');
  });

  it('persists editable prompts and feeds the same compose path as preview', async () => {
    const runtime = createHarness({
      prompts: {
        global: 'seed',
        dynamic: [{ id: 'slot', label: 'Slot', render: () => 'live-slot' }],
      },
    });

    await runtime.updateSettings({
      prompts: {
        global: 'edited global',
        perMode: { ask: 'edited ask' },
      },
    });

    const settings = await runtime.getSettings();
    expect(settings.prompts).toEqual({
      global: 'edited global',
      perMode: { ask: 'edited ask' },
    });

    const preview = await runtime.previewPrompt({ mode: 'ask' });
    expect(preview.text).toContain('edited global');
    expect(preview.text).toContain('edited ask');
    expect(preview.text).toContain('live-slot');
    expect(preview.sections.find((section) => section.id === 'slot')?.dynamic).toBe(true);
  });
});

describe('tool approval policy settings', () => {
  it('merges toolApprovals without wiping sibling tools', () => {
    const current = emptyStoredSettings();
    current.policies.toolApprovals = { write_note: 'requires_approval' };

    const next = applySettingsUpdate(current, {
      policies: { toolApprovals: { echo: 'always_allow' } },
    });

    expect(next.policies.toolApprovals).toEqual({
      write_note: 'requires_approval',
      echo: 'always_allow',
    });
  });

  it('persists an override and reflects it in settings and catalog', async () => {
    const runtime = createHarness({
      tools: [
        {
          name: 'restart_service',
          description: 'restart',
          parameters: {},
          handler: () => 'ok',
        },
      ],
    });

    expect((await runtime.getSettings()).policies.toolApprovals.restart_service).toBe(
      'requires_approval',
    );

    await runtime.updateSettings({
      policies: { toolApprovals: { restart_service: 'always_allow' } },
    });

    expect((await runtime.getSettings()).policies.toolApprovals.restart_service).toBe(
      'always_allow',
    );
    expect(
      (await runtime.toolCatalog('agent')).tools.find((tool) => tool.name === 'restart_service')
        ?.approval,
    ).toBe('always_allow');
  });

  it('rejects gating a builtin tool', async () => {
    const runtime = createHarness();
    await expect(
      runtime.updateSettings({
        policies: { toolApprovals: { propose_plan: 'requires_approval' } },
      }),
    ).rejects.toThrow(/Builtin tool/);
  });
});
