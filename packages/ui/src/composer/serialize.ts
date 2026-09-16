import type { ContextRef } from '@evu/harness-protocol';

/**
 * A composer pick as the UI kit tracks it.
 *
 * `token` is what the wire text carries (byte-stable for the model). `label` /
 * `icon` / `tone` are presentation only and never leave the composer. `asChip`
 * is false for snippet-style picks that insert plain text.
 */
export interface ComposerChipRef extends ContextRef {
  label: string;
  icon?: string;
  tone?: 'neutral' | 'accent' | 'warn';
  asChip: boolean;
}

export interface ComposerValue {
  text: string;
  caret: number;
  refs: ComposerChipRef[];
}

/** Strip UI-only fields so a send payload matches `ContextRef`. */
export function toWireRefs(refs: readonly ComposerChipRef[]): ContextRef[] {
  return refs.map((ref) => {
    const wire: ContextRef = {
      menu: ref.menu,
      path: ref.path,
      id: ref.id,
    };
    if (ref.token !== undefined) wire.token = ref.token;
    if (ref.payload !== undefined) wire.payload = ref.payload;
    return wire;
  });
}

export function isChipElement(node: Node): node is HTMLElement {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as HTMLElement).dataset.harness === 'chip'
  );
}

/** Build an atomic chip node. `contenteditable=false` makes backspace delete it whole. */
export function createChipElement(doc: Document, ref: ComposerChipRef): HTMLElement {
  const chip = doc.createElement('span');
  chip.dataset.harness = 'chip';
  chip.contentEditable = 'false';
  chip.dataset.menu = ref.menu;
  chip.dataset.id = ref.id;
  chip.dataset.path = JSON.stringify(ref.path);
  chip.dataset.token = ref.token ?? '';
  chip.dataset.label = ref.label;
  if (ref.icon !== undefined && ref.icon !== '') {
    chip.dataset.icon = ref.icon;
  }
  if (ref.tone !== undefined) {
    chip.dataset.tone = ref.tone;
  }
  if (ref.payload !== undefined) {
    chip.dataset.payload = JSON.stringify(ref.payload);
  }

  if (ref.icon !== undefined && ref.icon !== '') {
    const icon = doc.createElement('span');
    icon.dataset.harness = 'chip-icon';
    icon.textContent = ref.icon;
    chip.appendChild(icon);
  }

  const label = doc.createElement('span');
  label.dataset.harness = 'chip-label';
  label.textContent = ref.label;
  chip.appendChild(label);

  return chip;
}

function readChipRef(el: HTMLElement): ComposerChipRef {
  let path: string[] = [];
  try {
    const parsed: unknown = JSON.parse(el.dataset.path ?? '[]');
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      path = parsed;
    }
  } catch {
    path = [];
  }

  let payload: Record<string, unknown> | undefined;
  if (el.dataset.payload !== undefined) {
    try {
      const parsed: unknown = JSON.parse(el.dataset.payload);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = undefined;
    }
  }

  const tone = el.dataset.tone;
  const ref: ComposerChipRef = {
    menu: el.dataset.menu ?? '',
    path,
    id: el.dataset.id ?? '',
    token: el.dataset.token ?? '',
    label: el.dataset.label ?? el.textContent ?? '',
    asChip: true,
  };
  if (el.dataset.icon !== undefined) ref.icon = el.dataset.icon;
  if (tone === 'neutral' || tone === 'accent' || tone === 'warn') ref.tone = tone;
  if (payload !== undefined) ref.payload = payload;
  return ref;
}

interface WalkCaret {
  node: Node;
  offset: number;
}

/**
 * Walk a contenteditable root into wire text plus structured refs.
 *
 * Chip elements contribute their `data-token` (not the visible label) so the
 * model-facing string stays byte-stable. Soft line breaks become `\n`.
 */
export function serializeComposer(
  root: HTMLElement,
  caret?: WalkCaret | null,
): ComposerValue {
  let text = '';
  let caretIndex = 0;
  let caretSet = false;
  const refs: ComposerChipRef[] = [];

  const markCaret = (beforeLength: number, withinOffset: number, length: number) => {
    if (caretSet || caret === null || caret === undefined) return;
    caretIndex = beforeLength + Math.max(0, Math.min(withinOffset, length));
    caretSet = true;
  };

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? '';
      if (caret !== null && caret !== undefined && caret.node === node) {
        markCaret(text.length, caret.offset, value.length);
      }
      text += value;
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const el = node as HTMLElement;

    if (el.tagName === 'BR') {
      if (caret !== null && caret !== undefined && caret.node === el) {
        markCaret(text.length, 0, 1);
      }
      text += '\n';
      return;
    }

    if (isChipElement(el)) {
      const ref = readChipRef(el);
      const token = ref.token ?? '';
      if (caret !== null && caret !== undefined) {
        if (caret.node === el || el.contains(caret.node)) {
          markCaret(text.length, token.length, token.length);
        }
      }
      refs.push(ref);
      text += token;
      return;
    }

    for (const child of Array.from(node.childNodes)) {
      visit(child);
    }
  };

  visit(root);

  if (!caretSet) {
    caretIndex = text.length;
  }

  return { text, caret: caretIndex, refs };
}

/**
 * Keep plain-text picks from the previous draft when their inserted text is still
 * present. Chip refs always come from the live DOM so backspace stays honest.
 */
export function mergeComposerRefs(
  serialized: ComposerValue,
  previous: readonly ComposerChipRef[],
): ComposerChipRef[] {
  const fromDom = serialized.refs;
  const textOnly = previous.filter(
    (ref) =>
      !ref.asChip &&
      ref.token !== undefined &&
      ref.token.length > 0 &&
      serialized.text.includes(ref.token),
  );

  if (textOnly.length === 0) {
    return fromDom;
  }

  const combined = [...fromDom, ...textOnly];
  return combined.sort((a, b) => {
    const aAt = a.token === undefined ? Number.MAX_SAFE_INTEGER : serialized.text.indexOf(a.token);
    const bAt = b.token === undefined ? Number.MAX_SAFE_INTEGER : serialized.text.indexOf(b.token);
    return aAt - bAt;
  });
}

/**
 * Paint wire text + chip refs into a contenteditable root.
 *
 * Chip tokens in `value.text` become atomic chip elements; everything else stays
 * a text node. Used after a catalog pick (or a full reset), not on every keystroke.
 */
export function paintComposer(root: HTMLElement, value: ComposerValue): void {
  const doc = root.ownerDocument;
  root.replaceChildren();

  const chips = value.refs.filter((ref) => ref.asChip && ref.token !== undefined && ref.token !== '');
  let cursor = 0;

  for (const ref of chips) {
    const token = ref.token!;
    const index = value.text.indexOf(token, cursor);
    if (index === -1) {
      continue;
    }
    if (index > cursor) {
      root.appendChild(doc.createTextNode(value.text.slice(cursor, index)));
    }
    root.appendChild(createChipElement(doc, ref));
    cursor = index + token.length;
  }

  if (cursor < value.text.length) {
    root.appendChild(doc.createTextNode(value.text.slice(cursor)));
  }

  if (root.childNodes.length === 0) {
    root.appendChild(doc.createTextNode(''));
  }
}

/**
 * Map a wire-text caret offset back onto a DOM selection inside `root`.
 */
export function setComposerCaret(root: HTMLElement, caret: number): void {
  const doc = root.ownerDocument;
  const selection = doc.getSelection();
  if (selection === null) return;

  let remaining = Math.max(0, caret);
  let targetNode: Node = root;
  let targetOffset = 0;
  let found = false;

  const visit = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = (node.textContent ?? '').length;
      if (remaining <= length) {
        targetNode = node;
        targetOffset = remaining;
        found = true;
        return true;
      }
      remaining -= length;
      return false;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const el = node as HTMLElement;
    if (el.tagName === 'BR') {
      if (remaining === 0) {
        targetNode = el.parentNode ?? root;
        targetOffset = Array.from(targetNode.childNodes).indexOf(el as ChildNode);
        found = true;
        return true;
      }
      remaining -= 1;
      return false;
    }

    if (isChipElement(el)) {
      const tokenLength = (el.dataset.token ?? '').length;
      if (remaining <= tokenLength) {
        const parent = el.parentNode ?? root;
        targetNode = parent;
        targetOffset = Array.from(parent.childNodes).indexOf(el as ChildNode) + 1;
        found = true;
        return true;
      }
      remaining -= tokenLength;
      return false;
    }

    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) return true;
    }
    return false;
  };

  visit(root);

  if (!found) {
    const last = root.lastChild;
    if (last !== null && last.nodeType === Node.TEXT_NODE) {
      targetNode = last;
      targetOffset = (last.textContent ?? '').length;
    } else {
      targetNode = root;
      targetOffset = root.childNodes.length;
    }
  }

  const range = doc.createRange();
  try {
    range.setStart(targetNode, targetOffset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // Invalid offsets can happen mid-input in some browsers; leave the caret alone.
  }
}

export function readSelectionCaret(root: HTMLElement): WalkCaret | null {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) {
    return null;
  }
  return { node: range.startContainer, offset: range.startOffset };
}

/**
 * If the caret sits immediately after a chip, remove that chip.
 * Returns true when it handled the key.
 */
export function deleteChipBeforeCaret(root: HTMLElement): boolean {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || !selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  const range = selection.getRangeAt(0);
  const { startContainer, startOffset } = range;

  let chip: HTMLElement | null = null;

  if (startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
    const previous = startContainer.previousSibling;
    if (previous !== null && isChipElement(previous)) {
      chip = previous;
    }
  } else if (startContainer.nodeType === Node.ELEMENT_NODE) {
    const el = startContainer as HTMLElement;
    const before = el.childNodes[startOffset - 1];
    if (before !== undefined && isChipElement(before)) {
      chip = before;
    }
  }

  if (chip === null) {
    return false;
  }

  const parent = chip.parentNode;
  const index = parent === null ? -1 : Array.from(parent.childNodes).indexOf(chip);
  chip.remove();

  if (parent !== null && index >= 0) {
    const nextRange = root.ownerDocument.createRange();
    nextRange.setStart(parent, Math.min(index, parent.childNodes.length));
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
  }

  return true;
}

/**
 * If the caret sits immediately before a chip, remove that chip.
 * Returns true when it handled the key.
 */
export function deleteChipAfterCaret(root: HTMLElement): boolean {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || !selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  const range = selection.getRangeAt(0);
  const { startContainer, startOffset } = range;

  let chip: HTMLElement | null = null;

  if (startContainer.nodeType === Node.TEXT_NODE) {
    const text = startContainer.textContent ?? '';
    if (startOffset === text.length) {
      const next = startContainer.nextSibling;
      if (next !== null && isChipElement(next)) {
        chip = next;
      }
    }
  } else if (startContainer.nodeType === Node.ELEMENT_NODE) {
    const el = startContainer as HTMLElement;
    const after = el.childNodes[startOffset];
    if (after !== undefined && isChipElement(after)) {
      chip = after;
    }
  }

  if (chip === null) {
    return false;
  }

  const parent = chip.parentNode;
  const index = parent === null ? -1 : Array.from(parent.childNodes).indexOf(chip);
  chip.remove();

  if (parent !== null && index >= 0) {
    const nextRange = root.ownerDocument.createRange();
    nextRange.setStart(parent, Math.min(index, parent.childNodes.length));
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
  }

  return true;
}
