import {
  createChipElement,
  deleteChipBeforeCaret,
  mergeComposerRefs,
  paintComposer,
  serializeComposer,
  toWireRefs,
  type ComposerChipRef,
  type ComposerValue,
} from '@evu/harness-ui';
import { describe, expect, it } from 'vitest';

function ref(partial: Partial<ComposerChipRef> & Pick<ComposerChipRef, 'id' | 'label'>): ComposerChipRef {
  return {
    menu: 'mentions',
    path: ['service'],
    token: `@service:${partial.id}`,
    asChip: true,
    ...partial,
  };
}

describe('serializeComposer', () => {
  it('emits chip tokens into wire text, not display labels', () => {
    const root = document.createElement('div');
    const chip = createChipElement(
      document,
      ref({ id: 'api', label: 'API Gateway', icon: 'box', tone: 'accent' }),
    );
    root.appendChild(document.createTextNode('see '));
    root.appendChild(chip);
    root.appendChild(document.createTextNode(' please'));

    const value = serializeComposer(root);
    expect(value.text).toBe('see @service:api please');
    expect(value.refs).toEqual([
      expect.objectContaining({
        menu: 'mentions',
        path: ['service'],
        id: 'api',
        token: '@service:api',
        label: 'API Gateway',
        icon: 'box',
        tone: 'accent',
        asChip: true,
      }),
    ]);
  });

  it('maps the caret through chips by token length', () => {
    const root = document.createElement('div');
    const before = document.createTextNode('hi ');
    const chip = createChipElement(document, ref({ id: 'api', label: 'API' }));
    const after = document.createTextNode('!');
    root.append(before, chip, after);

    const value = serializeComposer(root, { node: after, offset: 0 });
    expect(value.text).toBe('hi @service:api!');
    expect(value.caret).toBe('hi @service:api'.length);
  });

  it('round-trips paint → serialize with stable tokens', () => {
    const root = document.createElement('div');
    const value: ComposerValue = {
      text: 'ping @service:api now',
      caret: 0,
      refs: [ref({ id: 'api', label: 'API Gateway', icon: 'box' })],
    };

    paintComposer(root, value);
    expect(root.querySelector('[data-harness="chip"]')?.textContent).toContain('API Gateway');
    expect(serializeComposer(root).text).toBe('ping @service:api now');
  });
});

describe('toWireRefs', () => {
  it('strips presentation fields', () => {
    const wire = toWireRefs([
      ref({ id: 'api', label: 'API Gateway', icon: 'box', tone: 'warn', payload: { k: 1 } }),
    ]);
    expect(wire).toEqual([
      {
        menu: 'mentions',
        path: ['service'],
        id: 'api',
        token: '@service:api',
        payload: { k: 1 },
      },
    ]);
    expect(JSON.stringify(wire)).not.toContain('API Gateway');
    expect(JSON.stringify(wire)).not.toContain('asChip');
  });
});

describe('mergeComposerRefs', () => {
  it('keeps plain-text picks whose inserted text remains', () => {
    const previous: ComposerChipRef[] = [
      {
        menu: 'emoji',
        path: [],
        id: 'smile',
        token: '🙂',
        label: '🙂',
        asChip: false,
      },
      ref({ id: 'api', label: 'API' }),
    ];
    const serialized: ComposerValue = {
      text: '🙂 and @service:api',
      caret: 0,
      refs: [ref({ id: 'api', label: 'API' })],
    };

    const merged = mergeComposerRefs(serialized, previous);
    expect(merged.map((r) => r.id)).toEqual(['smile', 'api']);
  });

  it('drops plain-text picks once their text is gone', () => {
    const previous: ComposerChipRef[] = [
      {
        menu: 'emoji',
        path: [],
        id: 'smile',
        token: '🙂',
        label: '🙂',
        asChip: false,
      },
    ];
    const serialized: ComposerValue = { text: 'gone', caret: 0, refs: [] };
    expect(mergeComposerRefs(serialized, previous)).toEqual([]);
  });
});

describe('deleteChipBeforeCaret', () => {
  it('removes the chip immediately before the caret', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const chip = createChipElement(document, ref({ id: 'api', label: 'API' }));
    const after = document.createTextNode(' x');
    root.append(chip, after);

    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(after, 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(deleteChipBeforeCaret(root)).toBe(true);
    expect(root.querySelector('[data-harness="chip"]')).toBeNull();
    expect(serializeComposer(root).text).toBe(' x');
    root.remove();
  });
});
