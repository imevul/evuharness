import {
  type ComposerAttachment,
  type ComposerChipRef,
  type ComposerValue,
  createChipElement,
  deleteChipBeforeCaret,
  mergeComposerAttachments,
  mergeComposerRefs,
  paintComposer,
  removeChipElement,
  serializeComposer,
  toWireAttachments,
  toWireRefs,
} from '@evu/harness-ui';
import { describe, expect, it } from 'vitest';

function ref(
  partial: Partial<ComposerChipRef> & Pick<ComposerChipRef, 'id' | 'label'>,
): ComposerChipRef {
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

    expect(chip.querySelector('[data-harness="chip-remove"]')?.getAttribute('aria-label')).toBe(
      'Remove API Gateway',
    );

    const value = serializeComposer(root);
    expect(value.text).toBe('see @service:api please');
    expect(value.text).not.toContain('×');
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
      attachments: [],
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
      attachments: [],
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
    const serialized: ComposerValue = { text: 'gone', caret: 0, refs: [], attachments: [] };
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
    expect(serializeComposer(root).text).toBe('x');
    root.remove();
  });
});

describe('attachment chips', () => {
  it('serializes attachment tokens into attachments[] separately from refs', () => {
    const root = document.createElement('div');
    const attachment: ComposerAttachment = {
      id: 'a1',
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      url: 'data:image/png;base64,abc',
      size: 3,
      label: 'shot.png',
      icon: 'image',
      tone: 'accent',
      asChip: true,
      token: '[image:shot.png]',
    };
    const value: ComposerValue = {
      text: 'see [image:shot.png] please',
      caret: 0,
      refs: [],
      attachments: [attachment],
    };
    paintComposer(root, value);
    const chip = root.querySelector('[data-kind="attachment"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('shot.png');

    const serialized = serializeComposer(root);
    expect(serialized.text).toBe('see [image:shot.png] please');
    expect(serialized.refs).toEqual([]);
    expect(chip?.getAttribute('data-url')).toBeNull();
    expect(serialized.attachments).toEqual([
      expect.objectContaining({
        id: 'a1',
        kind: 'image',
        name: 'shot.png',
        token: '[image:shot.png]',
      }),
    ]);
    expect(serialized.attachments[0]).not.toHaveProperty('url');

    const merged = mergeComposerAttachments(serialized, value.attachments);
    expect(toWireAttachments(merged)).toEqual([
      {
        id: 'a1',
        kind: 'image',
        name: 'shot.png',
        mimeType: 'image/png',
        size: 3,
        url: 'data:image/png;base64,abc',
      },
    ]);
  });
});

describe('removeChipElement', () => {
  it('drops the padding space left after a chip', () => {
    const root = document.createElement('div');
    const chip = createChipElement(document, ref({ id: 'api', label: 'API Gateway' }));
    root.appendChild(chip);
    root.appendChild(document.createTextNode(' '));
    root.appendChild(document.createElement('br'));

    removeChipElement(chip);

    expect(root.querySelector('[data-harness="chip"]')).toBeNull();
    expect(serializeComposer(root).text).toBe('');
  });
});
