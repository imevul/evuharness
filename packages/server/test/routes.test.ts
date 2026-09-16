import {
  commandsMenu,
  createHarness,
  FakeProvider,
  type Harness,
  mentionsMenu,
} from '@evu/harness-core';
import { type Actor, CAPABILITIES, createHarnessRouter } from '@evu/harness-server';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

const MENTION_NODES = [
  {
    kind: 'group' as const,
    id: 'service',
    label: 'Services',
    icon: 'server',
    children: [{ kind: 'item' as const, id: 'api', label: 'api', hint: 'running' }],
  },
];

let harness: Harness;
let app: Hono;

function build(overrides: Parameters<typeof createHarness>[0] = {}) {
  let counter = 0;
  harness = createHarness({
    idFactory: () => `session-${++counter}`,
    tools: [
      {
        name: 'read_status',
        description: 'read',
        parameters: {},
        mutates: false,
        handler: () => 'ok',
      },
      { name: 'restart_service', description: 'restart', parameters: {}, handler: () => 'ok' },
    ],
    contextMenus: [
      mentionsMenu({ sources: [MENTION_NODES] }),
      commandsMenu({ sources: [[{ kind: 'item', id: 'doctor', label: 'doctor' }]] }),
    ],
    prompts: { global: 'You are a harness.' },
    ...overrides,
  });
  return harness;
}

async function get(path: string) {
  return app.request(path);
}

async function post(path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  app = createHarnessRouter({ harness: build() });
});

describe('health and status', () => {
  it('serves health without auth', async () => {
    const response = await get('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', name: 'evuharness' });
  });

  it('reports runtime status', async () => {
    const response = await get('/status');

    expect(await response.json()).toMatchObject({
      ready: true,
      modes: ['ask', 'plan', 'agent'],
      activeProvider: null,
      toolCount: 2,
      contextMenuCount: 2,
    });
  });
});

describe('session routes', () => {
  it('creates a session', async () => {
    const response = await post('/sessions', { mode: 'ask' });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ mode: 'ask', title: 'New chat' });
  });

  it('rejects a create without a mode', async () => {
    expect((await post('/sessions', {})).status).toBe(400);
  });

  it('rejects an unknown mode', async () => {
    const response = await post('/sessions', { mode: 'nonsense' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('accepts a workspace id at creation', async () => {
    const response = await post('/sessions', { mode: 'ask', workspaceId: 'ws-1' });

    expect(await response.json()).toMatchObject({ workspaceId: 'ws-1' });
  });

  it('lists sessions', async () => {
    await post('/sessions', { mode: 'ask' });
    await post('/sessions', { mode: 'agent' });

    const body = (await (await get('/sessions')).json()) as { sessions: unknown[] };

    expect(body.sessions).toHaveLength(2);
  });

  it('filters a listing by workspace', async () => {
    await post('/sessions', { mode: 'ask', workspaceId: 'ws-1' });
    await post('/sessions', { mode: 'ask', workspaceId: 'ws-2' });

    const body = (await (await get('/sessions?workspaceId=ws-1')).json()) as {
      sessions: unknown[];
    };

    expect(body.sessions).toHaveLength(1);
  });

  it('rejects a non-numeric limit', async () => {
    expect((await get('/sessions?limit=abc')).status).toBe(400);
  });

  it('fetches one session', async () => {
    const created = (await (await post('/sessions', { mode: 'ask' })).json()) as { id: string };
    const response = await get(`/sessions/${created.id}`);

    expect(await response.json()).toMatchObject({ id: created.id });
  });

  it('404s an unknown session', async () => {
    expect((await get('/sessions/nope')).status).toBe(404);
  });

  it('deletes a session', async () => {
    const created = (await (await post('/sessions', { mode: 'ask' })).json()) as { id: string };

    expect((await app.request(`/sessions/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await get(`/sessions/${created.id}`)).status).toBe(404);
  });

  it('404s deleting an unknown session', async () => {
    expect((await app.request('/sessions/nope', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('set-mode', () => {
  it('changes the session default mode', async () => {
    const created = (await (await post('/sessions', { mode: 'ask' })).json()) as { id: string };
    const response = await post(`/sessions/${created.id}/set-mode`, { mode: 'agent' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'agent' });
  });

  it('rejects an unknown mode', async () => {
    const created = (await (await post('/sessions', { mode: 'ask' })).json()) as { id: string };

    expect((await post(`/sessions/${created.id}/set-mode`, { mode: 'nope' })).status).toBe(400);
  });

  it('404s an unknown session', async () => {
    expect((await post('/sessions/nope/set-mode', { mode: 'agent' })).status).toBe(404);
  });
});

describe('chat', () => {
  it('validates the request before refusing', async () => {
    // A missing mode is a client error; it must not be reported as unimplemented.
    expect((await post('/chat', { messages: [{ text: 'hi' }] })).status).toBe(400);
  });

  it('rejects an unknown mode', async () => {
    expect((await post('/chat', { mode: 'nope', messages: [{ text: 'hi' }] })).status).toBe(400);
  });

  it('streams a turn as SSE', async () => {
    app = createHarnessRouter({
      harness: build({
        provider: new FakeProvider(),
        providers: [{ id: 'p', baseUrl: 'https://example.test/v1', model: 'm' }],
      }),
    });
    const created = await (await post('/sessions', { mode: 'ask' })).json();
    const response = await post('/chat', {
      sessionId: (created as { id: string }).id,
      mode: 'ask',
      messages: [{ text: 'hello' }],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const body = await response.text();
    expect(body).toContain('"event":"status"');
    expect(body).toContain('"event":"done"');
  });

  it('cancels a session that exists', async () => {
    app = createHarnessRouter({
      harness: build({
        provider: new FakeProvider(),
        providers: [{ id: 'p', baseUrl: 'https://example.test/v1', model: 'm' }],
      }),
    });
    const created = await (await post('/sessions', { mode: 'ask' })).json();
    const response = await post(`/sessions/${(created as { id: string }).id}/cancel`, {
      reason: 'operator',
    });

    expect(response.status).toBe(204);
  });
});

describe('gates', () => {
  it.each(['/sessions/s1/approve-plan', '/sessions/s1/discard-plan', '/sessions/s1/mode-switch'])(
    'reports 501 for %s',
    async (path) => {
      expect((await post(path, {})).status).toBe(501);
    },
  );

  it('validates an approval decision before refusing', async () => {
    expect((await post('/sessions/s1/tool-approvals/a1', { decision: 'maybe' })).status).toBe(400);
  });

  it('returns 404 when no approval is pending', async () => {
    const created = await (await post('/sessions', { mode: 'agent' })).json();

    for (const decision of [
      'allow_once',
      'allow_session',
      'allow_workspace',
      'allow_always',
      'deny',
    ]) {
      const response = await post(`/sessions/${created.id}/tool-approvals/missing`, { decision });
      expect(response.status).toBe(404);
    }
  });

  it('accepts a decision for a live tool-approval gate', async () => {
    app = createHarnessRouter({
      harness: build({
        provider: new FakeProvider([
          {
            events: [
              {
                kind: 'message',
                message: {
                  role: 'assistant',
                  content: '',
                  toolCalls: [{ id: 'c1', name: 'restart_service', arguments: { id: 'api' } }],
                },
              },
            ],
          },
          {
            events: [
              { kind: 'delta', text: 'ok' },
              { kind: 'message', message: { role: 'assistant', content: 'ok' } },
            ],
          },
        ]),
        providers: [{ id: 'p', baseUrl: 'https://example.test/v1', model: 'm' }],
      }),
    });

    const created = (await (await post('/sessions', { mode: 'agent' })).json()) as { id: string };
    const chat = await app.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.id,
        mode: 'agent',
        messages: [{ text: 'restart' }],
      }),
    });
    expect(chat.status).toBe(200);
    const reader = chat.body!.getReader();
    const decoder = new TextDecoder();
    let approvalId: string | null = null;
    let buffer = '';
    while (approvalId === null) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/"approvalId":"([^"]+)"/);
      if (match) {
        approvalId = match[1] ?? null;
      }
    }
    expect(approvalId).not.toBeNull();

    const response = await post(`/sessions/${created.id}/tool-approvals/${approvalId}`, {
      decision: 'allow_once',
    });
    expect(response.status).toBe(204);

    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  });

  it('rejects an ask-user answer when nothing is pending', async () => {
    app = createHarnessRouter({
      harness: build({
        provider: new FakeProvider(),
        providers: [{ id: 'p', baseUrl: 'https://example.test/v1', model: 'm' }],
      }),
    });
    const created = (await (await post('/sessions', { mode: 'ask' })).json()) as { id: string };
    const response = await post(`/sessions/${created.id}/ask-user/missing`, {
      answers: [{ questionId: 'q1', selected: ['a'] }],
    });
    expect(response.status).toBe(404);
  });

  it('validates ask-user answers before looking up the gate', async () => {
    expect((await post('/sessions/s1/ask-user/a1', { answers: [] })).status).toBe(400);
  });
});

describe('settings', () => {
  it('never returns a provider credential', async () => {
    app = createHarnessRouter({
      harness: build({
        providers: [
          { id: 'main', baseUrl: 'https://example.test/v1', model: 'm', apiKey: 'super-secret' },
        ],
      }),
    });

    const raw = await (await get('/settings')).text();

    expect(raw).not.toContain('super-secret');
    expect(raw).toContain('"hasApiKey":true');
  });

  it('reports per-tool approval policy', async () => {
    const body = (await (await get('/settings')).json()) as {
      policies: { toolApprovals: Record<string, string> };
    };

    expect(body.policies.toolApprovals.restart_service).toBe('requires_approval');
  });

  it('upserts a provider and never echoes the key', async () => {
    const response = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [
          {
            id: 'local',
            baseUrl: 'https://example.test/v1',
            model: 'm',
            apiKey: 'super-secret',
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: { hasApiKey: boolean }[] };
    expect(body.providers[0]?.hasApiKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain('super-secret');
  });

  it('rejects an unknown activeProviderId', async () => {
    const response = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeProviderId: 'missing' }),
    });

    expect(response.status).toBe(400);
  });

  it('lists models as catalog entries after a provider is configured', async () => {
    app = createHarnessRouter({
      harness: build({
        provider: new FakeProvider(),
        providers: [{ id: 'local', baseUrl: 'https://example.test/v1', model: 'fake-model' }],
      }),
    });

    const response = await post('/models', { providerId: 'local' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providerId: 'local',
      models: [{ id: 'fake-model', contextWindow: 8192 }],
    });
  });

  it('returns ok:false from /test when no provider is configured', async () => {
    const response = await post('/test', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});

describe('prompt preview', () => {
  it('composes a preview for the default mode', async () => {
    const body = (await (await get('/prompt/preview')).json()) as { text: string; mode: string };

    expect(body.mode).toBe('ask');
    expect(body.text).toContain('You are a harness.');
  });

  it('composes for an explicit mode', async () => {
    const body = (await (await get('/prompt/preview?mode=agent')).json()) as { mode: string };

    expect(body.mode).toBe('agent');
  });

  it('rejects an unknown mode', async () => {
    expect((await get('/prompt/preview?mode=nope')).status).toBe(400);
  });
});

describe('tool catalog', () => {
  it('flags availability for the requested mode', async () => {
    const body = (await (await get('/tools?mode=ask')).json()) as {
      tools: { name: string; availableInMode: boolean }[];
    };

    expect(body.tools.find((tool) => tool.name === 'read_status')?.availableInMode).toBe(true);
    expect(body.tools.find((tool) => tool.name === 'restart_service')?.availableInMode).toBe(false);
  });

  it('rejects an unknown mode', async () => {
    expect((await get('/tools?mode=nope')).status).toBe(400);
  });
});

describe('context menu endpoints', () => {
  it('advertises the catalog', async () => {
    const body = (await (await get('/context-menus')).json()) as {
      menus: { id: string; trigger: string }[];
    };

    expect(body.menus.map((menu) => menu.trigger)).toEqual(['@', '/']);
  });

  it('serves items for a query', async () => {
    const response = await post('/context-menus/mentions/items', { query: 'api' });
    const body = (await response.json()) as { nodes: { id: string }[] };

    expect(body.nodes.map((node) => node.id)).toEqual(['api']);
  });

  it('serves a browse level for an empty query', async () => {
    const body = (await (await post('/context-menus/mentions/items', {})).json()) as {
      nodes: { id: string }[];
    };

    expect(body.nodes.map((node) => node.id)).toEqual(['service']);
  });

  it('serves a drill-in path', async () => {
    const body = (await (
      await post('/context-menus/mentions/items', { path: ['service'] })
    ).json()) as { path: string[]; nodes: { id: string }[] };

    expect(body.path).toEqual(['service']);
    expect(body.nodes.map((node) => node.id)).toEqual(['api']);
  });

  it('404s an unknown menu', async () => {
    expect((await post('/context-menus/nope/items', {})).status).toBe(404);
  });

  it('reports a failing host source as a bad gateway, not a bad request', async () => {
    app = createHarnessRouter({
      harness: build({
        contextMenus: [
          {
            id: 'broken',
            trigger: '%',
            source: () => {
              throw new Error('source exploded');
            },
          },
        ],
      }),
    });

    const response = await post('/context-menus/broken/items', {});

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'source_failed' });
  });
});

describe('auth hooks', () => {
  it('rejects an unresolved actor as unauthenticated', async () => {
    app = createHarnessRouter({ harness: build(), auth: { getActor: () => null } });

    expect((await get('/status')).status).toBe(401);
  });

  it('still serves health when unauthenticated', async () => {
    app = createHarnessRouter({ harness: build(), auth: { getActor: () => null } });

    expect((await get('/health')).status).toBe(200);
  });

  it('rejects a missing capability as forbidden', async () => {
    app = createHarnessRouter({
      harness: build(),
      auth: {
        getActor: (): Actor => ({ id: 'viewer', capabilities: [CAPABILITIES.read] }),
        requireCapability: (actor, capability) => (actor?.capabilities ?? []).includes(capability),
      },
    });

    // A viewer may read but must not be able to start a turn.
    expect((await get('/status')).status).toBe(200);
    expect((await post('/chat', { mode: 'ask', messages: [{ text: 'hi' }] })).status).toBe(403);
    expect((await post('/sessions', { mode: 'ask' })).status).toBe(403);
  });

  it('names the missing capability in the rejection', async () => {
    app = createHarnessRouter({
      harness: build(),
      auth: { getActor: (): Actor => ({ id: 'viewer' }), requireCapability: () => false },
    });

    expect(await (await get('/status')).json()).toMatchObject({
      error: 'forbidden',
      detail: CAPABILITIES.read,
    });
  });

  it('separates decide from chat capability', async () => {
    app = createHarnessRouter({
      harness: build(),
      auth: {
        getActor: (): Actor => ({ id: 'operator', capabilities: [CAPABILITIES.chat] }),
        requireCapability: (actor, capability) => (actor?.capabilities ?? []).includes(capability),
      },
    });

    expect((await post('/sessions', { mode: 'ask' })).status).toBe(201);
    expect((await post('/sessions/s1/approve-plan', {})).status).toBe(403);
  });

  it('allows everything when no hooks are supplied', async () => {
    expect((await get('/status')).status).toBe(200);
    expect((await post('/sessions', { mode: 'ask' })).status).toBe(201);
  });
});
