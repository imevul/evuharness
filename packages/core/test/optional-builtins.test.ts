import {
  capUserProfile,
  createHarness,
  InMemoryMemoryStore,
  USER_PROMPT_CHAR_BUDGET,
} from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

describe('optional builtin registration', () => {
  it('registers no optional tools when every flag is off', async () => {
    const harness = createHarness();
    const names = (await harness.toolCatalog('agent')).tools.map((tool) => tool.name);

    expect(names).not.toContain('read_user');
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('http_request');
    expect(names).not.toContain('mcp_list');
    expect(harness.features).toMatchObject({
      agents: false,
      memory: false,
      webSearch: false,
      httpRequest: false,
      compaction: false,
      mcp: false,
    });
  });

  it('registers memory tools only when the memory flag is on', async () => {
    const harness = createHarness({ features: { memory: true } });
    const tools = await harness.toolCatalog('agent');
    const byName = Object.fromEntries(tools.tools.map((tool) => [tool.name, tool]));

    expect(byName.read_user?.approval).toBe('always_allow');
    expect(byName.write_user?.approval).toBe('requires_approval');
    expect(byName.search_memory?.approval).toBe('always_allow');
    expect(byName.remember?.approval).toBe('requires_approval');
    expect(byName.forget?.approval).toBe('requires_approval');
    expect(byName.read_user?.description).toMatch(/USER\.md/);
    expect(byName.remember?.description).toMatch(/Never store user facts/);
  });

  it('registers search and HTTP tools only when those flags are on', async () => {
    const off = createHarness();
    const on = createHarness({ features: { webSearch: true, httpRequest: true } });

    expect((await off.toolCatalog('agent')).tools.map((tool) => tool.name)).not.toContain(
      'web_search',
    );
    const names = (await on.toolCatalog('agent')).tools.map((tool) => tool.name);
    expect(names).toContain('web_search');
    expect(names).toContain('http_request');
  });

  it('registers mcp_list and mcp_call only when mcp is on', async () => {
    const off = createHarness();
    const on = createHarness({ features: { mcp: true } });
    expect((await off.toolCatalog('agent')).tools.map((tool) => tool.name)).not.toContain(
      'mcp_call',
    );
    const names = (await on.toolCatalog('agent')).tools.map((tool) => tool.name);
    expect(names).toContain('mcp_list');
    expect(names).toContain('mcp_call');
  });

  it('seeds DuckDuckGo when web search is first enabled', async () => {
    const harness = createHarness({ features: { webSearch: true } });
    const settings = await harness.getSettings();

    expect(settings.searchProviders).toEqual([
      expect.objectContaining({ id: 'duckduckgo', kind: 'duckduckgo' }),
    ]);
    expect(settings.activeSearchProviderId).toBe('duckduckgo');
  });
});

describe('soul and user prompt sections', () => {
  it('inserts soul after per-mode text when agents is on', async () => {
    const harness = createHarness({
      features: { agents: true },
      prompts: { global: 'global text', perMode: { ask: 'ask text' } },
    });
    await harness.updateSettings({
      agents: [{ id: 'guide', label: 'Guide', soul: 'Speak like a careful editor.' }],
      activeAgentId: 'guide',
    });

    const preview = await harness.previewPrompt({ mode: 'ask' });
    expect(preview.sections.map((section) => section.id)).toEqual([
      'global',
      'mode',
      'mode:ask',
      'soul',
    ]);
    expect(preview.sections.find((section) => section.id === 'soul')?.text).toBe(
      'Speak like a careful editor.',
    );
  });

  it('omits soul when the agents flag is off even if a profile is stored', async () => {
    const harness = createHarness({
      features: { agents: false },
      prompts: { global: 'g' },
    });
    await harness.updateSettings({
      agents: [{ id: 'guide', soul: 'hidden soul' }],
      activeAgentId: 'guide',
    });

    const preview = await harness.previewPrompt({ mode: 'ask' });
    expect(preview.sections.map((section) => section.id)).not.toContain('soul');
    expect(preview.text).not.toContain('hidden soul');
  });

  it('injects a capped USER section and leaves MEMORY out of the prompt', async () => {
    const memory = new InMemoryMemoryStore();
    await memory.setUser('Name: Ada\nNever use em dashes.');
    await memory.upsert({
      id: 'm1',
      title: 'Project',
      body: 'We tried X and it failed.',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const harness = createHarness({ features: { memory: true }, memory });
    const preview = await harness.previewPrompt({ mode: 'ask' });
    const user = preview.sections.find((section) => section.id === 'user');

    expect(user?.dynamic).toBe(true);
    expect(user?.text).toContain('USER.md is standing facts');
    expect(user?.text).toContain('Name: Ada');
    expect(preview.text).not.toContain('We tried X and it failed.');
  });

  it('caps a long USER.md so the injected section stays bounded', () => {
    const text = 'x'.repeat(USER_PROMPT_CHAR_BUDGET + 40);
    const capped = capUserProfile(text);
    expect(capped.length).toBeLessThan(text.length);
    expect(capped.endsWith('…')).toBe(true);
  });
});

describe('memory store tools', () => {
  it('splits USER writes from MEMORY rows', async () => {
    const memory = new InMemoryMemoryStore();
    const harness = createHarness({
      features: { memory: true },
      memory,
      idFactory: () => 'mem-1',
      clock: () => '2026-01-02T00:00:00.000Z',
    });

    await harness.setUserProfile('Pronouns: they/them');
    const remembered = await harness.upsertMemory({
      title: 'Decision',
      body: 'Ship the list/call MCP.',
    });
    expect(remembered.id).toBe('mem-1');

    expect((await harness.getUserProfile()).text).toBe('Pronouns: they/them');
    expect(await harness.listMemories('list/call')).toEqual([
      expect.objectContaining({ title: 'Decision', body: 'Ship the list/call MCP.' }),
    ]);
    expect(await harness.deleteMemory('mem-1')).toBe(true);
    expect(await harness.listMemories()).toEqual([]);
  });
});
