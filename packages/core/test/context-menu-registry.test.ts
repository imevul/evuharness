import {
  ContextMenuRegistry,
  commandsMenu,
  createHarness,
  defaultToken,
  filterNodes,
  findItem,
  groupsAlongPath,
  mentionsMenu,
  modelCommandItem,
  nodesAtPath,
  planCommandItem,
  resolveChip,
  staticSource,
  walkItems,
} from '@evu/harness-core';
import type { ContextMenuNode } from '@evu/harness-protocol';
import { describe, expect, it, vi } from 'vitest';

/** Mirrors the example catalog in the specification. */
const MENTION_NODES: ContextMenuNode[] = [
  {
    kind: 'group',
    id: 'service',
    label: 'Services',
    hint: 'Pin a managed unit',
    icon: 'server',
    children: [
      { kind: 'item', id: 'api', label: 'api', hint: 'running' },
      {
        kind: 'item',
        id: 'embed-bge',
        label: 'embed-bge',
        hint: 'stopped',
        keywords: ['embedding', 'bge'],
      },
    ],
  },
  { kind: 'group', id: 'file', label: 'Files', icon: 'file', lazy: true },
  {
    kind: 'item',
    id: 'host',
    label: 'This host',
    hint: 'GPU + RAM snapshot',
    icon: 'cpu',
    chip: { tone: 'accent' },
  },
];

const COMMAND_NODES: ContextMenuNode[] = [
  { kind: 'item', id: 'doctor', label: 'doctor', hint: 'Diagnose the stack' },
  { kind: 'item', id: 'tune-service', label: 'tune-service', hint: 'Auto-tune a unit' },
];

describe('registry validation', () => {
  it('rejects a duplicate menu id', () => {
    expect(
      () =>
        new ContextMenuRegistry([
          { id: 'a', trigger: '@', source: [] },
          { id: 'a', trigger: '#', source: [] },
        ]),
    ).toThrow(/Duplicate context menu id/);
  });

  it('rejects a duplicate trigger, which would make one menu unreachable', () => {
    expect(
      () =>
        new ContextMenuRegistry([
          { id: 'a', trigger: '@', source: [] },
          { id: 'b', trigger: '@', source: [] },
        ]),
    ).toThrow(/already used by/);
  });

  it('rejects a multi-character trigger', () => {
    expect(() => new ContextMenuRegistry([{ id: 'a', trigger: '@@', source: [] }])).toThrow(
      /single non-whitespace character/,
    );
  });

  it('rejects a whitespace trigger', () => {
    expect(() => new ContextMenuRegistry([{ id: 'a', trigger: ' ', source: [] }])).toThrow(
      /single non-whitespace character/,
    );
  });

  it('throws on an unknown menu lookup', () => {
    expect(() => new ContextMenuRegistry().get('nope')).toThrow(/Unknown context menu/);
  });

  it('looks a menu up by trigger', () => {
    const registry = new ContextMenuRegistry([{ id: 'corpora', trigger: '#', source: [] }]);

    expect(registry.byTrigger('#')?.descriptor.id).toBe('corpora');
    expect(registry.byTrigger('@')).toBeNull();
  });
});

describe('source shapes', () => {
  it('accepts a static array', async () => {
    const registry = new ContextMenuRegistry([
      { id: 'm', trigger: '@', source: COMMAND_NODES, emptyQueryBehavior: 'flat' },
    ]);

    expect((await registry.listItems('m')).nodes).toHaveLength(2);
  });

  it('accepts a bare function', async () => {
    const registry = new ContextMenuRegistry([
      { id: 'm', trigger: '@', source: () => COMMAND_NODES, emptyQueryBehavior: 'flat' },
    ]);

    expect((await registry.listItems('m')).nodes).toHaveLength(2);
  });

  it('accepts an async source', async () => {
    const registry = new ContextMenuRegistry([
      {
        id: 'm',
        trigger: '@',
        source: async () => COMMAND_NODES,
        emptyQueryBehavior: 'flat',
      },
    ]);

    expect((await registry.listItems('m')).nodes).toHaveLength(2);
  });

  it('passes query, path, and scope to the source', async () => {
    const list = vi.fn(() => [] as ContextMenuNode[]);
    const registry = new ContextMenuRegistry([
      { id: 'm', trigger: '@', source: { id: 's', list } },
    ]);

    await registry.listItems('m', {
      query: 'ap',
      path: ['file', 'src'],
      scope: { workspaceId: 'ws-1' },
    });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'ap',
        path: ['file', 'src'],
        scope: { workspaceId: 'ws-1' },
      }),
    );
  });

  it('resolves a drill-in path against a static tree', async () => {
    // A static source holds the whole tree, so it must descend rather than return
    // the top level for every request.
    const registry = new ContextMenuRegistry([{ id: 'm', trigger: '@', source: MENTION_NODES }]);

    const top = await registry.listItems('m');
    expect(top.nodes.map((node) => node.id)).toEqual(['service', 'file', 'host']);

    const drilled = await registry.listItems('m', { path: ['service'] });
    expect(drilled.nodes.map((node) => node.id)).toEqual(['api', 'embed-bge']);
  });

  it('resolves a drill-in path through a preset', async () => {
    const registry = new ContextMenuRegistry([mentionsMenu({ sources: [MENTION_NODES] })]);
    const drilled = await registry.listItems('mentions', { path: ['service'] });

    expect(drilled.nodes.map((node) => node.id)).toEqual(['api', 'embed-bge']);
  });

  it('yields nothing for a path into a lazy group of a static tree', async () => {
    const registry = new ContextMenuRegistry([{ id: 'm', trigger: '@', source: MENTION_NODES }]);

    expect((await registry.listItems('m', { path: ['file'] })).nodes).toEqual([]);
  });

  it('leaves path handling to a function source', async () => {
    const seen: string[][] = [];
    const registry = new ContextMenuRegistry([
      {
        id: 'm',
        trigger: '@',
        source: ({ path }) => {
          seen.push(path);
          return [{ kind: 'item', id: path.join('/') || 'root', label: 'x' }];
        },
      },
    ]);

    await registry.listItems('m', { path: ['a', 'b'] });

    expect(seen).toEqual([['a', 'b']]);
  });

  it('combines several sources in order', async () => {
    const menu = mentionsMenu({
      sources: [
        staticSource('first', [{ kind: 'item', id: 'a', label: 'a' }]),
        staticSource('second', [{ kind: 'item', id: 'b', label: 'b' }]),
      ],
    });
    const registry = new ContextMenuRegistry([menu]);
    const response = await registry.listItems('mentions');

    expect(response.nodes.map((node) => node.id)).toEqual(['a', 'b']);
  });
});

describe('presets', () => {
  it('gives mentions the @ trigger and an inline text effect', () => {
    const registry = new ContextMenuRegistry([mentionsMenu({ sources: [MENTION_NODES] })]);
    const descriptor = registry.get('mentions').descriptor;

    expect(descriptor).toMatchObject({
      trigger: '@',
      effect: 'text',
      emptyQueryBehavior: 'groups',
    });
  });

  it('ships an optional /model item that is a pick-time action, not a send', async () => {
    const item = modelCommandItem();
    expect(item).toMatchObject({
      kind: 'item',
      id: 'model',
      label: 'model',
      action: 'open-model-picker',
    });

    const registry = new ContextMenuRegistry([commandsMenu({ sources: [[item]] })]);
    const response = await registry.listItems('commands');
    expect(response.nodes).toEqual([item]);
  });

  it('ships an optional /plan item that is a pick-time action, not a send', async () => {
    const item = planCommandItem();
    expect(item).toMatchObject({
      kind: 'item',
      id: 'plan',
      label: 'plan',
      action: 'switch-to-plan-mode',
    });

    const registry = new ContextMenuRegistry([commandsMenu({ sources: [[item]] })]);
    const response = await registry.listItems('commands');
    expect(response.nodes).toEqual([item]);
  });

  it('gives commands the / trigger and a prompt effect', () => {
    const registry = new ContextMenuRegistry([commandsMenu({ sources: [COMMAND_NODES] })]);
    const descriptor = registry.get('commands').descriptor;

    // Prompt rather than text: a command body merges into the leading system
    // message instead of being sent as conversation.
    expect(descriptor).toMatchObject({
      trigger: '/',
      effect: 'prompt',
      emptyQueryBehavior: 'flat',
    });
  });

  it('lets a preset be retriggered on a different character', () => {
    const registry = new ContextMenuRegistry([
      mentionsMenu({ sources: [] }),
      mentionsMenu({ id: 'people', trigger: '~', sources: [] }),
    ]);

    expect(registry.byTrigger('~')?.descriptor.id).toBe('people');
  });

  it('coexists with a raw host-defined entry', () => {
    const registry = new ContextMenuRegistry([
      mentionsMenu({ sources: [] }),
      commandsMenu({ sources: [] }),
      { id: 'corpora', trigger: '#', source: [], title: 'Corpora' },
    ]);

    expect(registry.descriptors().map((entry) => entry.id)).toEqual([
      'mentions',
      'commands',
      'corpora',
    ]);
  });
});

describe('node tree navigation', () => {
  it('walks items with their group paths', () => {
    const entries = [...walkItems(MENTION_NODES)];

    expect(entries).toEqual([
      { item: expect.objectContaining({ id: 'api' }), path: ['service'] },
      { item: expect.objectContaining({ id: 'embed-bge' }), path: ['service'] },
      { item: expect.objectContaining({ id: 'host' }), path: [] },
    ]);
  });

  it('descends a drill-in path', () => {
    const level = nodesAtPath(MENTION_NODES, ['service']);

    expect(level?.map((node) => node.id)).toEqual(['api', 'embed-bge']);
  });

  it('returns null for a lazy group, so the source gets asked', () => {
    expect(nodesAtPath(MENTION_NODES, ['file'])).toBeNull();
  });

  it('returns null for an unknown path', () => {
    expect(nodesAtPath(MENTION_NODES, ['nope'])).toBeNull();
  });

  it('collects the ancestor chain along a path', () => {
    const nested: ContextMenuNode[] = [
      {
        kind: 'group',
        id: 'outer',
        label: 'Outer',
        icon: 'folder',
        children: [
          {
            kind: 'group',
            id: 'inner',
            label: 'Inner',
            children: [{ kind: 'item', id: 'leaf', label: 'leaf' }],
          },
        ],
      },
    ];

    expect(groupsAlongPath(nested, ['outer', 'inner']).map((group) => group.id)).toEqual([
      'outer',
      'inner',
    ]);
  });

  it('finds an item at a path', () => {
    expect(findItem(MENTION_NODES, ['service'], 'api')?.label).toBe('api');
  });

  it('finds an item picked from a flattened search result', () => {
    // A flat search shows an item without its group, so the caller's path may not
    // match where the item actually lives.
    expect(findItem(MENTION_NODES, [], 'embed-bge')?.label).toBe('embed-bge');
  });

  it('returns null for a missing item', () => {
    expect(findItem(MENTION_NODES, [], 'nope')).toBeNull();
  });
});

describe('filtering', () => {
  it('keeps structure for an empty query in groups mode', () => {
    const nodes = filterNodes(MENTION_NODES, { query: '', emptyQueryBehavior: 'groups' });

    expect(nodes.map((node) => node.id)).toEqual(['service', 'file', 'host']);
  });

  it('flattens an empty query in flat mode', () => {
    const nodes = filterNodes(MENTION_NODES, { query: '', emptyQueryBehavior: 'flat' });

    expect(nodes.map((node) => node.id)).toEqual(['api', 'embed-bge', 'host']);
  });

  it('searches into groups and returns bare items', () => {
    const nodes = filterNodes(MENTION_NODES, { query: 'api', searchScope: 'flat' });

    expect(nodes.map((node) => node.id)).toEqual(['api']);
  });

  it('matches keywords that are never displayed', () => {
    const nodes = filterNodes(MENTION_NODES, { query: 'embedding', searchScope: 'flat' });

    expect(nodes.map((node) => node.id)).toEqual(['embed-bge']);
  });

  it('matches hint text, which is what disambiguates rows', () => {
    const nodes = filterNodes(MENTION_NODES, { query: 'snapshot', searchScope: 'flat' });

    expect(nodes.map((node) => node.id)).toEqual(['host']);
  });

  it('is case insensitive', () => {
    expect(filterNodes(MENTION_NODES, { query: 'API' }).map((node) => node.id)).toEqual(['api']);
  });

  it('surfaces a lazy group whose own label matches', () => {
    // A lazy group cannot be searched into, so hiding it would make its contents
    // unreachable by search.
    const nodes = filterNodes(MENTION_NODES, { query: 'files', searchScope: 'flat' });

    expect(nodes.map((node) => node.id)).toEqual(['file']);
  });

  it('filters only the visible level in current-level mode', () => {
    const nodes = filterNodes(MENTION_NODES, { query: 'api', searchScope: 'current-level' });

    // 'api' lives inside the Services group, so a current-level search misses it.
    expect(nodes).toEqual([]);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(filterNodes(MENTION_NODES, { query: 'zzzz' })).toEqual([]);
  });
});

describe('chip resolution', () => {
  it('uses the item label and icon by default', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'api', label: 'api', icon: 'box' },
      trigger: '@',
    });

    expect(chip).toEqual({ label: 'api', icon: 'box', tone: 'neutral' });
  });

  it('inherits an icon from the nearest ancestor group', () => {
    // This is what keeps source data lean: the group declares one icon and its
    // items declare none.
    const chip = resolveChip({
      item: { kind: 'item', id: 'api', label: 'api' },
      groups: [{ kind: 'group', id: 'service', label: 'Services', icon: 'server' }],
      trigger: '@',
    });

    expect(chip?.icon).toBe('server');
  });

  it('prefers the nearest group when several ancestors declare icons', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'leaf', label: 'leaf' },
      groups: [
        { kind: 'group', id: 'outer', label: 'Outer', icon: 'folder' },
        { kind: 'group', id: 'inner', label: 'Inner', icon: 'file' },
      ],
      trigger: '@',
    });

    expect(chip?.icon).toBe('file');
  });

  it('falls back to the menu icon', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'x', label: 'x' },
      menuIcon: 'at-sign',
      trigger: '@',
    });

    expect(chip?.icon).toBe('at-sign');
  });

  it('falls back to the trigger character last', () => {
    const chip = resolveChip({ item: { kind: 'item', id: 'x', label: 'x' }, trigger: '@' });

    expect(chip?.icon).toBe('@');
  });

  it('lets the item icon win over group inheritance', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'host', label: 'This host', icon: 'cpu' },
      groups: [{ kind: 'group', id: 'g', label: 'G', icon: 'server' }],
      trigger: '@',
    });

    expect(chip?.icon).toBe('cpu');
  });

  it('lets a chip override win over the item icon', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'x', label: 'x', icon: 'cpu', chip: { icon: 'star' } },
      trigger: '@',
    });

    expect(chip?.icon).toBe('star');
  });

  it('suppresses the icon on an explicit null', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'x', label: 'x', icon: 'cpu', chip: { icon: null } },
      trigger: '@',
    });

    expect(chip?.icon).toBe('');
  });

  it('overrides the label when the row label needs its hint for sense', () => {
    const chip = resolveChip({
      item: {
        kind: 'item',
        id: 'src/runtime.ts',
        label: 'runtime.ts',
        hint: 'src/ · 12 KB',
        chip: { label: 'src/runtime.ts' },
      },
      trigger: '@',
    });

    expect(chip?.label).toBe('src/runtime.ts');
  });

  it('never puts the hint in the chip', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'api', label: 'api', hint: 'running · llamacpp' },
      trigger: '@',
    });

    expect(chip?.label).toBe('api');
    expect(JSON.stringify(chip)).not.toContain('running');
  });

  it('carries a tone override', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'x', label: 'x', chip: { tone: 'warn' } },
      trigger: '@',
    });

    expect(chip?.tone).toBe('warn');
  });

  it('returns null when the item opts out of a chip', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'smile', label: '🙂', chip: false },
      trigger: ':',
    });

    expect(chip).toBeNull();
  });

  it('returns null when the menu inserts plain text', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'smile', label: '🙂' },
      menuInsert: 'text',
      trigger: ':',
    });

    expect(chip).toBeNull();
  });

  it('lets an item opt back into a chip on a text menu', () => {
    const chip = resolveChip({
      item: { kind: 'item', id: 'x', label: 'x', chip: { tone: 'accent' } },
      menuInsert: 'text',
      trigger: ':',
    });

    expect(chip).toMatchObject({ tone: 'accent' });
  });
});

describe('token defaults', () => {
  it('qualifies a token with its group path', () => {
    expect(defaultToken({ trigger: '@', path: ['service'], itemId: 'api' })).toBe('@service:api');
  });

  it('omits the path segment for a top-level item', () => {
    expect(defaultToken({ trigger: '/', path: [], itemId: 'doctor' })).toBe('/doctor');
  });

  it('joins a nested path with colons', () => {
    expect(defaultToken({ trigger: '@', path: ['file', 'src'], itemId: 'runtime.ts' })).toBe(
      '@file:src:runtime.ts',
    );
  });

  it('is used by the registry unless a menu overrides it', () => {
    const registry = new ContextMenuRegistry([
      { id: 'm', trigger: '@', source: [] },
      { id: 'custom', trigger: '#', source: [], token: (pick) => `#${pick.item.label}!` },
    ]);
    const item = { kind: 'item', id: 'api', label: 'API' } as const;

    expect(registry.tokenFor({ menuId: 'm', trigger: '@', path: ['service'], item })).toBe(
      '@service:api',
    );
    expect(registry.tokenFor({ menuId: 'custom', trigger: '#', path: [], item })).toBe('#API!');
  });
});

describe('resolver effects', () => {
  it('defaults to the menu effect', async () => {
    const registry = new ContextMenuRegistry([mentionsMenu({ sources: [] })]);
    const resolution = await registry.get('mentions').resolve({
      ref: { menu: 'mentions', path: [], id: 'api' },
      scope: {},
      mode: 'ask',
      sessionId: 's1',
      text: '@service:api',
    });

    expect(resolution).toEqual({ effect: 'text' });
  });

  it('lets a menu return a context block', async () => {
    const registry = new ContextMenuRegistry([
      {
        id: 'files',
        trigger: '@',
        source: [],
        resolve: () => ({ effect: 'context', text: 'file contents', label: 'runtime.ts' }),
      },
    ]);

    const resolution = await registry.get('files').resolve({
      ref: { menu: 'files', path: [], id: 'runtime.ts' },
      scope: {},
      mode: 'ask',
      sessionId: 's1',
      text: '@runtime.ts',
    });

    expect(resolution).toMatchObject({ effect: 'context', text: 'file contents' });
  });

  it('lets a command rewrite the turn before it starts', async () => {
    const registry = new ContextMenuRegistry([
      {
        id: 'commands',
        trigger: '/',
        source: [],
        resolve: () => ({
          effect: 'command',
          replaceText: 'run diagnostics',
          mode: 'agent',
          preferTools: ['read_status'],
        }),
      },
    ]);

    const resolution = await registry.get('commands').resolve({
      ref: { menu: 'commands', path: [], id: 'doctor' },
      scope: {},
      mode: 'ask',
      sessionId: 's1',
      text: '/doctor',
    });

    expect(resolution).toMatchObject({ effect: 'command', mode: 'agent' });
  });

  it('receives the workspace scope', async () => {
    const resolve = vi.fn(() => ({ effect: 'text' }) as const);
    const registry = new ContextMenuRegistry([{ id: 'm', trigger: '@', source: [], resolve }]);

    await registry.get('m').resolve({
      ref: { menu: 'm', path: [], id: 'x' },
      scope: { workspaceId: 'ws-1' },
      mode: 'ask',
      sessionId: 's1',
      text: '@x',
    });

    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { workspaceId: 'ws-1' } }),
    );
  });
});

describe('harness integration', () => {
  it('exposes the catalog and serves menu items', async () => {
    const harness = createHarness({
      contextMenus: [
        mentionsMenu({ sources: [MENTION_NODES] }),
        commandsMenu({ sources: [COMMAND_NODES] }),
      ],
    });

    expect(harness.menuCatalog().map((entry) => entry.trigger)).toEqual(['@', '/']);
    expect((await harness.status()).contextMenuCount).toBe(2);

    const items = await harness.listMenuItems('mentions', { query: 'api' });
    expect(items.nodes.map((node) => node.id)).toEqual(['api']);
  });

  it('serves a drill-in level for a lazy group', async () => {
    const harness = createHarness({
      contextMenus: [
        {
          id: 'files',
          trigger: '@',
          source: ({ path }) =>
            path.length === 0
              ? [{ kind: 'group', id: 'src', label: 'src/', lazy: true }]
              : [{ kind: 'item', id: 'src/runtime.ts', label: 'runtime.ts', hint: 'src/' }],
        },
      ],
    });

    const top = await harness.listMenuItems('files');
    expect(top.nodes.map((node) => node.id)).toEqual(['src']);

    const drilled = await harness.listMenuItems('files', { path: ['src'] });
    expect(drilled.nodes.map((node) => node.id)).toEqual(['src/runtime.ts']);
    expect(drilled.path).toEqual(['src']);
  });
});
