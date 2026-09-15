import {
  createHarness,
  createSessionRecord,
  FakeProvider,
  InMemorySessionStore,
  mergeIntoLeadingSystemMessage,
  titleFromMessage,
} from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

function harness(overrides: Parameters<typeof createHarness>[0] = {}) {
  let counter = 0;
  return createHarness({
    idFactory: () => `session-${++counter}`,
    ...overrides,
  });
}

describe('createHarness defaults', () => {
  it('reports status without configuration', async () => {
    expect(await harness().status()).toMatchObject({
      ready: true,
      modes: ['ask', 'plan', 'agent'],
      activeProviderId: null,
      providerConfigured: false,
      toolCount: 0,
      contextMenuCount: 0,
    });
  });

  it('never exposes a provider credential, only whether one exists', async () => {
    const configured = harness({
      providers: [
        { id: 'main', baseUrl: 'https://example.test/v1', model: 'a-model', apiKey: 'secret' },
      ],
    });
    const settings = await configured.getSettings();
    const [provider] = settings.providers;

    expect(provider).toMatchObject({ id: 'main', hasApiKey: true });
    expect(JSON.stringify(settings)).not.toContain('secret');
  });

  it('reports hasApiKey false for an empty credential', async () => {
    const configured = harness({
      providers: [{ id: 'main', baseUrl: 'https://example.test/v1', model: 'm', apiKey: '' }],
    });

    expect((await configured.getSettings()).providers[0]?.hasApiKey).toBe(false);
  });

  it('defaults the active provider to the first one', async () => {
    const configured = harness({
      providers: [
        { id: 'first', baseUrl: 'https://a.test/v1', model: 'm' },
        { id: 'second', baseUrl: 'https://b.test/v1', model: 'm' },
      ],
    });

    expect((await configured.status()).activeProviderId).toBe('first');
    expect((await configured.status()).activeProvider).toMatchObject({
      id: 'first',
      model: 'm',
    });
  });

  it('resolves activeProvider.contextWindow per model, with override winning', async () => {
    const configured = harness({
      providers: [
        {
          id: 'local',
          baseUrl: 'https://example.test/v1',
          model: 'a',
          modelContextWindows: { a: 8_192, b: 4_096 },
          modelContextWindowOverrides: { a: 2_048 },
        },
      ],
    });

    expect((await configured.status()).activeProvider?.contextWindow).toBe(2_048);

    await configured.updateSettings({
      providers: [{ id: 'local', baseUrl: 'https://example.test/v1', model: 'b' }],
    });
    expect((await configured.status()).activeProvider).toMatchObject({
      model: 'b',
      contextWindow: 4_096,
    });
  });

  it('persists catalog windows per model when listing', async () => {
    const configured = harness({
      provider: new FakeProvider(),
      providers: [{ id: 'local', baseUrl: 'https://example.test/v1', model: 'fake-model' }],
    });

    const listed = await configured.listModels();
    expect(listed.models).toEqual([{ id: 'fake-model', contextWindow: 8_192 }]);
    expect((await configured.getSettings()).providers[0]?.modelContextWindows).toEqual({
      'fake-model': 8_192,
    });
    expect((await configured.status()).activeProvider?.contextWindow).toBe(8_192);
  });

  it('rejects an unknown activeProviderId', () => {
    expect(() =>
      harness({
        providers: [{ id: 'first', baseUrl: 'https://a.test/v1', model: 'm' }],
        activeProviderId: 'missing',
      }),
    ).toThrow(/Unknown activeProviderId/);
  });
});

describe('session lifecycle', () => {
  it('creates a session with the default mode', async () => {
    const session = await harness().createSession();
    expect(session).toMatchObject({ mode: 'ask', title: 'New chat' });
  });

  it('rejects an unknown mode at creation', async () => {
    await expect(harness().createSession({ mode: 'nope' })).rejects.toThrow(/Unknown mode/);
  });

  it('records an optional workspace id', async () => {
    const session = await harness().createSession({ workspaceId: 'ws-1' });
    expect(session.workspaceId).toBe('ws-1');
  });

  it('omits workspaceId entirely when unset', async () => {
    const session = await harness().createSession();
    expect('workspaceId' in session).toBe(false);
  });

  it('filters session listing by workspace', async () => {
    const instance = harness();
    await instance.createSession({ workspaceId: 'ws-1' });
    await instance.createSession({ workspaceId: 'ws-2' });
    await instance.createSession();

    expect(await instance.listSessions({ workspaceId: 'ws-1' })).toHaveLength(1);
    expect(await instance.listSessions()).toHaveLength(3);
  });

  it('returns null for a missing session', async () => {
    expect(await harness().getSession('nope')).toBeNull();
  });

  it('deletes a session and clears its session-scoped grants', async () => {
    const instance = harness();
    const session = await instance.createSession();

    await instance.grants.add({
      scope: 'session',
      scopeId: session.id,
      tool: 'restart_service',
      createdAt: new Date().toISOString(),
    });

    expect(await instance.deleteSession(session.id)).toBe(true);
    // Otherwise a grant could outlive its session and be resolved by a later one.
    expect(await instance.grants.list({ sessionId: session.id, tool: 'restart_service' })).toEqual(
      [],
    );
  });

  it('does not expose the model thread on the wire shape', async () => {
    const session = await harness().createSession();
    expect('messages' in session).toBe(false);
  });
});

describe('turn pinning through the harness', () => {
  it('pins the requested mode and its tool allowlist', async () => {
    const instance = harness({
      tools: [
        {
          name: 'read_status',
          description: 'read',
          parameters: {},
          mutates: false,
          handler: () => 'ok',
        },
        {
          name: 'restart_service',
          description: 'restart',
          parameters: {},
          handler: () => 'ok',
        },
      ],
    });
    const session = await instance.createSession({ mode: 'ask' });
    const pin = await instance.pinTurn({ sessionId: session.id, mode: 'ask' });

    expect(pin.mode).toBe('ask');
    expect(pin.toolNames.has('read_status')).toBe(true);
    expect(pin.toolNames.has('restart_service')).toBe(false);
  });

  it('derives the scope from the session workspace', async () => {
    const seen: (string | undefined)[] = [];
    const instance = harness({
      prompts: {
        dynamic: [
          {
            id: 'ws',
            label: 'Workspace',
            render: (ctx) => {
              seen.push(ctx.scope.workspaceId);
              return `workspace=${ctx.scope.workspaceId ?? 'none'}`;
            },
          },
        ],
      },
    });
    const session = await instance.createSession({ workspaceId: 'ws-9' });
    await instance.pinTurn({ sessionId: session.id, mode: 'ask' });

    expect(seen).toEqual(['ws-9']);
  });

  it('rejects pinning an unknown mode', async () => {
    const instance = harness();
    const session = await instance.createSession();

    await expect(instance.pinTurn({ sessionId: session.id, mode: 'nope' })).rejects.toThrow(
      /Unknown mode/,
    );
  });

  it('rejects pinning against a missing session', async () => {
    await expect(harness().pinTurn({ sessionId: 'nope', mode: 'ask' })).rejects.toThrow(
      /Unknown session/,
    );
  });
});

describe('prompt composition', () => {
  it('composes global, mode blurb, per-mode, and dynamic sections in order', async () => {
    const instance = harness({
      prompts: {
        global: 'You are a harness.',
        perMode: { ask: 'Answer concisely.' },
        dynamic: [{ id: 'inv', label: 'Inventory', render: () => 'two services running' }],
      },
    });

    const preview = await instance.previewPrompt({ mode: 'ask' });

    expect(preview.sections.map((section) => section.id)).toEqual([
      'global',
      'mode',
      'mode:ask',
      'inv',
    ]);
    expect(preview.text).toContain('You are a harness.');
    expect(preview.text).toContain('two services running');
  });

  it('marks dynamic sections so a preview can show what is computed', async () => {
    const instance = harness({
      prompts: { global: 'g', dynamic: [{ id: 'd', label: 'D', render: () => 'x' }] },
    });
    const preview = await instance.previewPrompt({ mode: 'ask' });

    expect(preview.sections.find((section) => section.id === 'd')?.dynamic).toBe(true);
    expect(preview.sections.find((section) => section.id === 'global')?.dynamic).toBe(false);
  });

  it('drops empty sections rather than emitting blank blocks', async () => {
    const instance = harness({
      prompts: { global: '   ', dynamic: [{ id: 'empty', label: 'E', render: () => '  ' }] },
    });
    const preview = await instance.previewPrompt({ mode: 'ask' });

    expect(preview.sections.map((section) => section.id)).toEqual(['mode']);
  });

  it('awaits asynchronous dynamic slots', async () => {
    const instance = harness({
      prompts: {
        dynamic: [{ id: 'slow', label: 'Slow', render: async () => 'resolved later' }],
      },
    });

    expect((await instance.previewPrompt({ mode: 'ask' })).text).toContain('resolved later');
  });

  it('previews and pins through the same composition', async () => {
    const instance = harness({
      prompts: { global: 'shared', dynamic: [{ id: 'd', label: 'D', render: () => 'dyn' }] },
    });
    const session = await instance.createSession({ mode: 'agent' });

    const preview = await instance.previewPrompt({ mode: 'agent', sessionId: session.id });
    const pin = await instance.pinTurn({ sessionId: session.id, mode: 'agent' });

    // A preview that used a second code path would drift, and a preview that lies
    // is worse than none.
    expect(pin.systemPrompt).toBe(preview.text);
  });

  it('differs per mode', async () => {
    const instance = harness({ prompts: { perMode: { ask: 'ask text', agent: 'agent text' } } });

    expect((await instance.previewPrompt({ mode: 'ask' })).text).toContain('ask text');
    expect((await instance.previewPrompt({ mode: 'agent' })).text).not.toContain('ask text');
  });
});

describe('tool catalog', () => {
  it('lists every tool with per-mode availability', () => {
    const instance = harness({
      tools: [
        { name: 'read', description: 'r', parameters: {}, mutates: false, handler: () => '' },
        { name: 'write', description: 'w', parameters: {}, handler: () => '' },
      ],
    });

    const catalog = instance.toolCatalog('ask');

    expect(catalog.tools).toHaveLength(2);
    expect(catalog.tools.find((tool) => tool.name === 'write')?.availableInMode).toBe(false);
  });
});

describe('session record helpers', () => {
  it('derives a title from the first line of a message', () => {
    expect(titleFromMessage('Restart the api\nand then check logs')).toBe('Restart the api');
  });

  it('truncates a long title', () => {
    const title = titleFromMessage('x'.repeat(200));
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to the default title for empty input', () => {
    expect(titleFromMessage('   \n  ')).toBe('New chat');
  });
});

describe('leading system message merge', () => {
  it('appends to an existing leading system message', () => {
    const messages = [
      { role: 'system', content: 'base' },
      { role: 'user', content: 'hi' },
    ];

    mergeIntoLeadingSystemMessage(messages, 'skill body');

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('base\n\nskill body');
  });

  it('inserts a system message when the thread has none', () => {
    const messages = [{ role: 'user', content: 'hi' }];

    mergeIntoLeadingSystemMessage(messages, 'skill body');

    expect(messages[0]).toEqual({ role: 'system', content: 'skill body' });
  });

  it('never adds a second system message mid-thread', () => {
    // Some models handle only one system message, so injected content merges into
    // the first rather than being appended as a later system turn.
    const messages = [
      { role: 'system', content: 'base' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'there' },
    ];

    mergeIntoLeadingSystemMessage(messages, 'extra');

    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
  });

  it('ignores an empty addition', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    mergeIntoLeadingSystemMessage(messages, '   ');

    expect(messages).toHaveLength(1);
  });
});

describe('in-memory store isolation', () => {
  it('does not hand out a live reference to stored state', async () => {
    const store = new InMemorySessionStore();
    const record = createSessionRecord({ id: 's1', mode: 'ask' });
    await store.upsert(record);

    const loaded = await store.get('s1');
    loaded!.mode = 'agent';

    // If the store aliased its state, mutating a loaded copy would write through
    // and hide exactly the class of bug applyTurnPatch guards against.
    expect((await store.get('s1'))?.mode).toBe('ask');
  });

  it('does not alias the record passed to upsert', async () => {
    const store = new InMemorySessionStore();
    const record = createSessionRecord({ id: 's1', mode: 'ask' });
    await store.upsert(record);

    record.mode = 'agent';

    expect((await store.get('s1'))?.mode).toBe('ask');
  });
});
