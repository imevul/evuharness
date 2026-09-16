import type { AttachmentKind, AttachmentRef, ContextRef } from '@evu/harness-protocol';
import { attachmentToken } from '@evu/harness-protocol';

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

/**
 * An attachment chip tracked alongside context-menu refs.
 *
 * Wire text carries `attachmentToken(kind, name)`; the structured payload rides
 * `attachments[]` on send so core never re-parses the chip label.
 */
export interface ComposerAttachment extends AttachmentRef {
  label: string;
  icon?: string;
  tone?: 'neutral' | 'accent' | 'warn';
  /** Always true for attachment chips. */
  asChip: true;
  token: string;
}

export interface ComposerValue {
  text: string;
  caret: number;
  refs: ComposerChipRef[];
  attachments: ComposerAttachment[];
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

/** Strip UI-only fields so a send payload matches `AttachmentRef`. */
export function toWireAttachments(attachments: readonly ComposerAttachment[]): AttachmentRef[] {
  return attachments.map((attachment) => {
    const wire: AttachmentRef = {
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
    };
    if (attachment.size !== undefined) wire.size = attachment.size;
    if (attachment.url !== undefined) wire.url = attachment.url;
    if (attachment.text !== undefined) wire.text = attachment.text;
    return wire;
  });
}

export function isChipElement(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.harness === 'chip';
}

export function isAttachmentChipElement(node: Node): node is HTMLElement {
  return isChipElement(node) && (node as HTMLElement).dataset.kind === 'attachment';
}

/** Build a context-menu chip node. `contenteditable=false` makes backspace delete it whole. */
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

  appendChipVisuals(chip, ref.icon, ref.label);
  return chip;
}

/** Build an attachment chip that serializes into `attachments[]` plus a wire token. */
export function createAttachmentChipElement(
  doc: Document,
  attachment: ComposerAttachment,
): HTMLElement {
  const chip = doc.createElement('span');
  chip.dataset.harness = 'chip';
  chip.dataset.kind = 'attachment';
  chip.contentEditable = 'false';
  chip.dataset.id = attachment.id;
  chip.dataset.token = attachment.token;
  chip.dataset.label = attachment.label;
  chip.dataset.attachmentKind = attachment.kind;
  chip.dataset.name = attachment.name;
  chip.dataset.mimeType = attachment.mimeType;
  if (attachment.size !== undefined) {
    chip.dataset.size = String(attachment.size);
  }
  if (attachment.url !== undefined) {
    chip.dataset.url = attachment.url;
  }
  if (attachment.text !== undefined) {
    chip.dataset.text = attachment.text;
  }
  if (attachment.icon !== undefined && attachment.icon !== '') {
    chip.dataset.icon = attachment.icon;
  }
  if (attachment.tone !== undefined) {
    chip.dataset.tone = attachment.tone;
  }

  appendChipVisuals(chip, attachment.icon, attachment.label);
  return chip;
}

function appendChipVisuals(chip: HTMLElement, icon: string | undefined, label: string): void {
  if (icon !== undefined && icon !== '') {
    const el = chip.ownerDocument.createElement('span');
    el.dataset.harness = 'chip-icon';
    el.textContent = icon;
    chip.appendChild(el);
  }

  const labelEl = chip.ownerDocument.createElement('span');
  labelEl.dataset.harness = 'chip-label';
  labelEl.textContent = label;
  chip.appendChild(labelEl);
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

function readAttachmentChip(el: HTMLElement): ComposerAttachment {
  const kindRaw = el.dataset.attachmentKind;
  const kind: AttachmentKind = kindRaw === 'image' ? 'image' : 'file';
  const name = el.dataset.name ?? el.dataset.label ?? 'file';
  const tone = el.dataset.tone;
  const sizeRaw = el.dataset.size;
  const size =
    sizeRaw !== undefined && sizeRaw !== '' && Number.isFinite(Number(sizeRaw))
      ? Number(sizeRaw)
      : undefined;

  const attachment: ComposerAttachment = {
    id: el.dataset.id ?? '',
    kind,
    name,
    mimeType: el.dataset.mimeType ?? 'application/octet-stream',
    label: el.dataset.label ?? name,
    asChip: true,
    token: el.dataset.token ?? attachmentToken(kind, name),
  };
  if (size !== undefined) attachment.size = size;
  if (el.dataset.url !== undefined && el.dataset.url !== '') attachment.url = el.dataset.url;
  if (el.dataset.text !== undefined) attachment.text = el.dataset.text;
  if (el.dataset.icon !== undefined) attachment.icon = el.dataset.icon;
  if (tone === 'neutral' || tone === 'accent' || tone === 'warn') attachment.tone = tone;
  return attachment;
}

interface WalkCaret {
  node: Node;
  offset: number;
}

/**
 * Walk a contenteditable root into wire text plus structured refs and attachments.
 *
 * Chip elements contribute their `data-token` (not the visible label) so the
 * model-facing string stays byte-stable. Soft line breaks become `\n`.
 */
export function serializeComposer(root: HTMLElement, caret?: WalkCaret | null): ComposerValue {
  let text = '';
  let caretIndex = 0;
  let caretSet = false;
  const refs: ComposerChipRef[] = [];
  const attachments: ComposerAttachment[] = [];

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
      const token = el.dataset.token ?? '';
      if (caret !== null && caret !== undefined) {
        if (caret.node === el || el.contains(caret.node)) {
          markCaret(text.length, token.length, token.length);
        }
      }
      if (isAttachmentChipElement(el)) {
        attachments.push(readAttachmentChip(el));
      } else {
        refs.push(readChipRef(el));
      }
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

  return { text, caret: caretIndex, refs, attachments };
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
 * Paint wire text + chip refs + attachment chips into a contenteditable root.
 *
 * Chip tokens in `value.text` become atomic chip elements; everything else stays
 * a text node. Used after a catalog pick (or a full reset), not on every keystroke.
 */
export function paintComposer(root: HTMLElement, value: ComposerValue): void {
  const doc = root.ownerDocument;
  root.replaceChildren();

  type ChipPaint = { token: string; paint: () => HTMLElement };
  const chips: ChipPaint[] = [
    ...value.refs
      .filter((ref) => ref.asChip && ref.token !== undefined && ref.token !== '')
      .map((ref) => ({
        token: ref.token as string,
        paint: () => createChipElement(doc, ref),
      })),
    ...value.attachments
      .filter((attachment) => attachment.token !== '')
      .map((attachment) => ({
        token: attachment.token,
        paint: () => createAttachmentChipElement(doc, attachment),
      })),
  ];

  // Paint in text order so overlapping token searches stay left-to-right.
  chips.sort((a, b) => value.text.indexOf(a.token) - value.text.indexOf(b.token));

  let cursor = 0;
  for (const chip of chips) {
    const index = value.text.indexOf(chip.token, cursor);
    if (index === -1) {
      continue;
    }
    if (index > cursor) {
      root.appendChild(doc.createTextNode(value.text.slice(cursor, index)));
    }
    root.appendChild(chip.paint());
    cursor = index + chip.token.length;
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

/** Build a composer attachment from a browser File (images as data URLs, text inlined). */
export async function attachmentFromFile(
  file: File,
  idFactory: () => string = () => crypto.randomUUID(),
): Promise<ComposerAttachment> {
  const id = idFactory();
  const mimeType = file.type || 'application/octet-stream';
  const isImage = mimeType.startsWith('image/');

  if (isImage) {
    const url = await readFileAsDataUrl(file);
    const token = attachmentToken('image', file.name);
    return {
      id,
      kind: 'image',
      name: file.name,
      mimeType,
      size: file.size,
      url,
      label: file.name,
      icon: 'image',
      tone: 'accent',
      asChip: true,
      token,
    };
  }

  const text = await readFileAsText(file);
  const token = attachmentToken('file', file.name);
  return {
    id,
    kind: 'file',
    name: file.name,
    mimeType,
    size: file.size,
    ...(text === undefined ? {} : { text }),
    label: file.name,
    icon: 'file',
    tone: 'neutral',
    asChip: true,
    token,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string | undefined> {
  // Skip obviously binary types; the model gets a name-only stub instead.
  if (mimeLooksBinary(file.type) || file.size > 256 * 1024) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      // Reject if the buffer looks binary (NUL bytes).
      if (value.includes('\u0000')) {
        resolve(undefined);
        return;
      }
      resolve(value);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsText(file);
  });
}

function mimeLooksBinary(mime: string): boolean {
  if (mime === '' || mime.startsWith('text/') || mime === 'application/json') {
    return false;
  }
  if (
    mime === 'application/javascript' ||
    mime === 'application/xml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  ) {
    return false;
  }
  return true;
}

/** Insert an attachment chip at the caret into a composer value. */
export function insertAttachmentAtCaret(
  value: ComposerValue,
  attachment: ComposerAttachment,
): ComposerValue {
  const before = value.text.slice(0, value.caret);
  const after = value.text.slice(value.caret);
  const spacerBefore =
    before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : '';
  const spacerAfter =
    after.length > 0 && !after.startsWith(' ') && !after.startsWith('\n') ? ' ' : '';
  const inserted = `${spacerBefore}${attachment.token}${spacerAfter}`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
    refs: value.refs,
    attachments: [...value.attachments, attachment],
  };
}
