import type { ContextMenuDescriptor, ContextMenuNode } from '@evu/harness-protocol';
import { describe, expect, it } from 'vitest';
import {
  catalogMark,
  flattenMenuItems,
  insertCatalogItemAtCaret,
  matchesAddQuery,
} from '../src/composer/add-menu.js';
import type { ComposerValue } from '../src/composer/serialize.js';

const menu: ContextMenuDescriptor = {
  id: 'commands',
  trigger: '/',
  title: 'Commands',
  insert: 'chip',
  effect: 'prompt',
  emptyQueryBehavior: 'flat',
  searchScope: 'flat',
  minQueryLength: 0,
};

const empty: ComposerValue = { text: '', caret: 0, refs: [], attachments: [] };

describe('flattenMenuItems', () => {
  it('walks groups so search can see nested items', () => {
    const nodes: ContextMenuNode[] = [
      {
        kind: 'group',
        id: 'docs',
        label: 'Docs',
        children: [{ kind: 'item', id: 'spec', label: 'SPEC.md' }],
      },
      { kind: 'item', id: 'root', label: 'root' },
    ];

    expect(flattenMenuItems(nodes)).toEqual([
      { item: { kind: 'item', id: 'spec', label: 'SPEC.md' }, path: ['docs'] },
      { item: { kind: 'item', id: 'root', label: 'root' }, path: [] },
    ]);
  });
});

describe('matchesAddQuery', () => {
  it('matches any field and treats empty as all', () => {
    expect(matchesAddQuery('', 'Ask')).toBe(true);
    expect(matchesAddQuery('as', 'Ask', 'ask')).toBe(true);
    expect(matchesAddQuery('zz', 'Ask')).toBe(false);
  });
});

describe('catalogMark', () => {
  it('keeps a short glyph and falls back to the trigger for word tokens', () => {
    expect(catalogMark('/', '/')).toBe('/');
    expect(catalogMark('@', '@')).toBe('@');
    expect(catalogMark('search', '@')).toBe('@');
    expect(catalogMark(undefined, '/')).toBe('/');
  });
});

describe('insertCatalogItemAtCaret', () => {
  it('inserts a chip token and a trailing space', () => {
    const picked = insertCatalogItemAtCaret(empty, menu, {
      kind: 'item',
      id: 'doctor',
      label: 'doctor',
    });

    expect(picked.action).toBeUndefined();
    expect(picked.value.text).toBe('/doctor ');
    expect(picked.value.caret).toBe('/doctor '.length);
    expect(picked.value.refs[0]).toMatchObject({
      menu: 'commands',
      id: 'doctor',
      token: '/doctor',
      asChip: true,
    });
  });

  it('returns a pick-time action without changing the draft', () => {
    const picked = insertCatalogItemAtCaret(empty, menu, {
      kind: 'item',
      id: 'model',
      label: 'model',
      action: 'open-model-picker',
    });

    expect(picked.action).toBe('open-model-picker');
    expect(picked.value).toBe(empty);
  });
});
