import type {
  AttachmentRef,
  ChatModeId,
  ContextMenuDescriptor,
  ContextMenuItem,
  ContextRef,
} from '@evu/harness-protocol';
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { insertCatalogItemAtCaret } from '../composer/add-menu.js';
import { isComposerMultiline } from '../composer/layout.js';
import {
  attachmentFromFile,
  type ComposerValue,
  deleteChipAfterCaret,
  deleteChipBeforeCaret,
  insertAttachmentAtCaret,
  mergeComposerAttachments,
  mergeComposerRefs,
  paintComposer,
  readSelectionCaret,
  removeChipElement,
  serializeComposer,
  setComposerCaret,
  toWireAttachments,
  toWireRefs,
} from '../composer/serialize.js';
import { type ContextMenuFetcher, useContextMenu } from '../hooks/use-context-menu.js';
import { ComposerAddMenu } from './ComposerAddMenu.js';
import { ContextMenuPopup } from './ContextMenuPopup.js';
import { ModeGlyph, titleCaseMode } from './ModeGlyph.js';

export interface ComposerProps {
  menus: readonly ContextMenuDescriptor[];
  fetchItems: ContextMenuFetcher;
  /** Modes offered by the mode chip, in cycle order. */
  modes: readonly ChatModeId[];
  mode: ChatModeId;
  onModeChange: (mode: ChatModeId) => void;
  /**
   * Called with wire text plus structured refs and attachments. Presentation
   * fields on chips are stripped — the payload matches `UserTurnInput`.
   */
  onSend: (value: {
    text: string;
    refs: ContextRef[];
    attachments: AttachmentRef[];
    caret: number;
  }) => void;
  /**
   * Pick-time client actions from catalog items that declare `action`.
   * The composer has already removed the trigger; this must not send a turn.
   */
  onAction?: (action: string) => void;
  onCancel?: () => void;
  turnInProgress?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Forwarded to `useContextMenu`; tests may set `0` to skip the keystroke debounce. */
  menuDebounceMs?: number;
  /**
   * When true, show the attach control and accept image/file chips.
   * Mirrors harness `features.attachments` (default off).
   */
  attachmentsEnabled?: boolean;
  /**
   * Contents of the attach button (bar) or the attach row in the add menu
   * (inlaid). A host passing an icon keeps the control labelled either way:
   * the accessible name comes from `aria-label`, not from whatever is here.
   */
  attachLabel?: ReactNode;
  /**
   * Toolbar chrome. `inlaid` (default) puts a `+` add menu, a dismissible
   * mode chip, and icon send/stop inside the composer. `bar` is the original
   * row under the editor. Hosts that want the old chrome pass `bar`.
   */
  chrome?: ComposerChrome;
  /**
   * Mode that paints no chip in `inlaid` chrome. Defaults to `agent`.
   * `bar` always shows the current mode.
   */
  unmarkedMode?: ChatModeId;
  /**
   * Extra trailing controls, inlaid before send/stop. Voice belongs here later.
   */
  trailingActions?: ReactNode;
  addLabel?: ReactNode;
  sendLabel?: ReactNode;
  cancelLabel?: ReactNode;
}

export type ComposerChrome = 'bar' | 'inlaid';

const EMPTY: ComposerValue = { text: '', caret: 0, refs: [], attachments: [] };

/** Copy a live `FileList` before the input that owns it is reset. */
function snapshotFiles(files: FileList | null | undefined): File[] {
  return files === null || files === undefined ? [] : Array.from(files);
}

/**
 * The message composer: contenteditable input, inline chips, mode chip, and the
 * catalog popup.
 *
 * Keyboard handling lives here rather than in the popup because the events arrive
 * on the editor. When a trigger is active the arrow keys, Enter, and Escape drive
 * the menu; otherwise they do their ordinary thing. That split is why the popup is
 * pure rendering.
 *
 * The mode chip writes only local draft state. It is the caller's decision whether
 * a change also persists as the session default; this component never assumes it
 * does, so cycling modes during a turn stays harmless.
 *
 * Contenteditable is the editing surface; `serializeComposer` turns it into wire
 * text (chip tokens, not labels) plus `refs[]` / `attachments[]` at send time.
 */
export function Composer(props: ComposerProps) {
  const {
    menus,
    fetchItems,
    modes,
    mode,
    onModeChange,
    onSend,
    onAction,
    onCancel,
    turnInProgress = false,
    disabled = false,
    placeholder = 'Send a message…',
    className,
    menuDebounceMs,
    attachmentsEnabled = false,
    attachLabel = 'Attach',
    chrome = 'inlaid',
    unmarkedMode = 'agent',
    trailingActions,
    addLabel = '+',
    sendLabel,
    cancelLabel,
  } = props;

  const [value, setValue] = useState<ComposerValue>(EMPTY);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Menu picks rewrite the DOM from the wire value; keystrokes must not, or the
  // caret jumps on every character.
  const needsPaint = useRef(false);
  // FileReader is async. Blur/input from the picker must not serialize the
  // pre-chip DOM over a pending attach.
  const attaching = useRef(false);

  const applyValue = useCallback((next: ComposerValue, paint: boolean) => {
    if (paint) needsPaint.current = true;
    setValue(next);
  }, []);

  const menu = useContextMenu({
    menus,
    fetchItems,
    value,
    onChange: (next) => applyValue(next, true),
    ...(onAction === undefined ? {} : { onAction }),
    ...(menuDebounceMs === undefined ? {} : { debounceMs: menuDebounceMs }),
  });

  useLayoutEffect(() => {
    const root = editorRef.current;
    if (root === null || !needsPaint.current) return;
    needsPaint.current = false;
    paintComposer(root, value);
    setComposerCaret(root, value.caret);
  }, [value]);

  const readEditor = useCallback((): ComposerValue => {
    const root = editorRef.current;
    if (root === null) return value;
    const serialized = serializeComposer(root, readSelectionCaret(root));
    return {
      ...serialized,
      refs: mergeComposerRefs(serialized, value.refs),
      attachments: mergeComposerAttachments(serialized, value.attachments),
    };
  }, [value]);

  const syncFromEditor = useCallback(() => {
    if (attaching.current) return;
    applyValue(readEditor(), false);
  }, [applyValue, readEditor]);

  const commitComposer = useCallback((next: ComposerValue) => {
    const root = editorRef.current;
    if (root !== null) {
      paintComposer(root, next);
      setComposerCaret(root, next.caret);
      needsPaint.current = false;
    } else {
      needsPaint.current = true;
    }
    setValue(next);
  }, []);

  const submit = useCallback(() => {
    if (disabled) return;
    const current = readEditor();
    if (current.text.trim() === '' && current.attachments.length === 0) return;
    onSend({
      text: current.text,
      caret: current.caret,
      refs: toWireRefs(current.refs),
      attachments: toWireAttachments(current.attachments),
    });
    needsPaint.current = true;
    setValue(EMPTY);
  }, [disabled, readEditor, onSend]);

  const cycleMode = useCallback(() => {
    const index = modes.indexOf(mode);
    const next = modes[(index + 1) % modes.length];
    if (next !== undefined) onModeChange(next);
  }, [modes, mode, onModeChange]);

  const clearMode = useCallback(() => {
    const fallback = modes.includes(unmarkedMode) ? unmarkedMode : (modes[0] ?? unmarkedMode);
    onModeChange(fallback);
  }, [modes, unmarkedMode, onModeChange]);

  const cycleMarkedMode = useCallback(() => {
    const marked = modes.filter((entry) => entry !== unmarkedMode);
    if (marked.length === 0) {
      cycleMode();
      return;
    }
    const index = marked.indexOf(mode);
    const next = marked[(index + 1) % marked.length];
    if (next !== undefined) onModeChange(next);
  }, [cycleMode, mode, modes, unmarkedMode, onModeChange]);

  const insertTrigger = useCallback(
    (trigger: string) => {
      const current = readEditor();
      const before = current.text.slice(0, current.caret);
      const after = current.text.slice(current.caret);
      const needsSpace =
        before.length > 0 &&
        !before.endsWith(' ') &&
        !before.endsWith('\n') &&
        !before.endsWith(trigger);
      const inserted = `${needsSpace ? ' ' : ''}${trigger}`;
      commitComposer({
        ...current,
        text: `${before}${inserted}${after}`,
        caret: before.length + inserted.length,
      });
      editorRef.current?.focus();
    },
    [commitComposer, readEditor],
  );

  const onAttachClick = useCallback(() => {
    setAddOpen(false);
    fileInputRef.current?.click();
  }, []);

  const onAddInsertTrigger = useCallback(
    (trigger: string) => {
      setAddOpen(false);
      insertTrigger(trigger);
    },
    [insertTrigger],
  );

  const onAddPickItem = useCallback(
    (menu: ContextMenuDescriptor, item: ContextMenuItem, path: string[]) => {
      setAddOpen(false);
      const picked = insertCatalogItemAtCaret(readEditor(), menu, item, path);
      if (picked.action !== undefined) {
        onAction?.(picked.action);
        return;
      }
      commitComposer(picked.value);
      editorRef.current?.focus();
    },
    [commitComposer, onAction, readEditor],
  );

  const onAddMode = useCallback(
    (next: ChatModeId) => {
      onModeChange(next);
      setAddOpen(false);
    },
    [onModeChange],
  );

  useEffect(() => {
    if (!addOpen) return;

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setAddOpen(false);
    };
    const onPointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && addMenuRef.current?.contains(target) === true) return;
      setAddOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [addOpen]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      if (disabled || !attachmentsEnabled) return;
      const list = Array.from(files);
      if (list.length === 0) return;

      attaching.current = true;
      try {
        let next = readEditor();
        let added = 0;
        for (const file of list) {
          try {
            const attachment = await attachmentFromFile(file);
            next = insertAttachmentAtCaret(next, attachment);
            added += 1;
          } catch {
            // Skip unreadable files rather than blocking the rest of the selection.
          }
        }
        if (added > 0) {
          commitComposer(next);
        }
      } finally {
        attaching.current = false;
      }
    },
    [attachmentsEnabled, commitComposer, disabled, readEditor],
  );

  const onFilesChosen = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      // FileList is live: clearing the input empties the same object. Copy first.
      const list = snapshotFiles(event.target.files);
      event.target.value = '';
      if (list.length === 0) return;
      void addFiles(list);
    },
    [addFiles],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const list = snapshotFiles(event.clipboardData?.files);
      if (list.length === 0 || !attachmentsEnabled) {
        return;
      }
      event.preventDefault();
      void addFiles(list);
    },
    [addFiles, attachmentsEnabled],
  );

  const onDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!attachmentsEnabled || disabled) return;
      if (!Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [attachmentsEnabled, disabled],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!attachmentsEnabled || disabled) return;
      const list = snapshotFiles(event.dataTransfer.files);
      if (list.length === 0) return;
      event.preventDefault();
      void addFiles(list);
    },
    [addFiles, attachmentsEnabled, disabled],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Shift+Tab cycles modes whether or not a menu is open, and must not move
      // focus out of the composer.
      if (event.key === 'Tab' && event.shiftKey) {
        event.preventDefault();
        cycleMode();
        return;
      }

      const root = editorRef.current;
      const menuOpen = menu.match !== null && (menu.nodes.length > 0 || menu.loading);

      if (menuOpen) {
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            menu.setHighlighted((menu.highlighted + 1) % menu.nodes.length);
            return;
          case 'ArrowUp':
            event.preventDefault();
            menu.setHighlighted((menu.highlighted - 1 + menu.nodes.length) % menu.nodes.length);
            return;
          case 'Enter':
          case 'Tab': {
            const node = menu.nodes[menu.highlighted];
            if (node !== undefined) {
              // Enter commits the highlighted row instead of sending: a half-typed
              // trigger is not a message the user meant to send.
              event.preventDefault();
              menu.select(node);
            }
            return;
          }
          case 'ArrowRight': {
            // Only drill in from the end of the query, so ArrowRight still moves the
            // caret through text the user is editing.
            const node = menu.nodes[menu.highlighted];
            if (node !== undefined && value.caret === (menu.match?.end ?? -1)) {
              event.preventDefault();
              menu.select(node);
            }
            return;
          }
          case 'ArrowLeft':
            if (menu.path.length > 0 && value.caret === (menu.match?.end ?? -1)) {
              event.preventDefault();
              menu.back();
            }
            return;
          case 'Escape':
            event.preventDefault();
            menu.dismiss();
            return;
          default:
            break;
        }
      }

      if (
        (event.key === 'Backspace' || event.key === 'Delete') &&
        value.text.trim() === '' &&
        value.attachments.length === 0
      ) {
        // Contenteditable inserts a filler <br> on backspace-from-empty; that
        // serializes as a newline. Clear leftovers instead of leaving a blank.
        event.preventDefault();
        if (value.text !== '') {
          commitComposer(EMPTY);
        }
        return;
      }

      if (root !== null && event.key === 'Backspace' && deleteChipBeforeCaret(root)) {
        event.preventDefault();
        syncFromEditor();
        return;
      }

      if (root !== null && event.key === 'Delete' && deleteChipAfterCaret(root)) {
        event.preventDefault();
        syncFromEditor();
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
        return;
      }

      if (event.key === 'Escape' && turnInProgress && onCancel !== undefined) {
        event.preventDefault();
        onCancel();
      }
    },
    [menu, value, cycleMode, submit, turnInProgress, onCancel, syncFromEditor, commitComposer],
  );

  const onEditorMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('[data-harness="chip-remove"]')) {
      // Keep the caret out of the chip; the click handler owns the delete.
      event.preventDefault();
    }
  }, []);

  const onEditorClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (disabled) {
        syncFromEditor();
        return;
      }
      if (event.target instanceof Element) {
        const button = event.target.closest('[data-harness="chip-remove"]');
        if (button !== null) {
          event.preventDefault();
          const chip = button.closest('[data-harness="chip"]');
          if (chip instanceof HTMLElement && editorRef.current?.contains(chip)) {
            removeChipElement(chip);
            syncFromEditor();
          }
          return;
        }
      }
      syncFromEditor();
    },
    [disabled, syncFromEditor],
  );

  const empty = value.text.trim() === '' && value.attachments.length === 0;
  const inlaid = chrome === 'inlaid';
  const showModeChip = !inlaid || mode !== unmarkedMode;
  const resolvedSend = sendLabel ?? (inlaid ? <SendIcon /> : 'Send');
  const resolvedCancel = cancelLabel ?? (inlaid ? <StopIcon /> : 'Stop');
  const [multiline, setMultiline] = useState(false);

  const measureLayout = useCallback(() => {
    if (!inlaid) {
      setMultiline(false);
      return;
    }
    if (value.text.trim() === '') {
      setMultiline(false);
      return;
    }
    const root = editorRef.current;
    if (root === null) return;
    const styles = getComputedStyle(root);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const fontSize = Number.parseFloat(styles.fontSize);
    const oneLine = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : fontSize * 1.4;
    const padding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    let chipHeight = 0;
    for (const node of root.querySelectorAll('[data-harness="chip"]')) {
      if (node instanceof HTMLElement) {
        chipHeight = Math.max(chipHeight, node.offsetHeight);
      }
    }
    setMultiline(
      isComposerMultiline({
        text: value.text,
        tokens: [...value.refs, ...value.attachments].map((entry) => entry.token),
        scrollHeight: root.scrollHeight,
        padding,
        oneLine,
        chipHeight,
      }),
    );
  }, [inlaid, value.attachments, value.refs, value.text]);

  useLayoutEffect(() => {
    measureLayout();
  }, [measureLayout]);

  useEffect(() => {
    const root = editorRef.current;
    if (root === null || !inlaid || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      measureLayout();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [inlaid, measureLayout]);

  const editor = (
    // Contenteditable is required so chips can sit inline; a textarea cannot.
    // biome-ignore lint/a11y/useSemanticElements: chips need a contenteditable surface
    <div
      ref={editorRef}
      data-harness="composer-input"
      data-placeholder={placeholder}
      data-empty={empty ? 'true' : undefined}
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      contentEditable={!disabled}
      suppressContentEditableWarning
      onKeyDown={onKeyDown}
      // Contenteditable caret is selection-based; re-serialize on every mutation
      // and selection change so trigger detection stays caret-relative.
      onInput={syncFromEditor}
      onMouseDown={onEditorMouseDown}
      onClick={onEditorClick}
      onKeyUp={syncFromEditor}
      onBlur={syncFromEditor}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDrop={onDrop}
    />
  );

  const leading = (
    <div data-harness="composer-leading">
      {inlaid ? (
        <div ref={addMenuRef} data-harness="composer-add">
          <button
            type="button"
            data-harness="composer-add-trigger"
            aria-label="Add"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            disabled={disabled}
            onClick={() => setAddOpen((current) => !current)}
          >
            {addLabel}
          </button>
          {addOpen && (
            <ComposerAddMenu
              menus={menus}
              fetchItems={fetchItems}
              debounceMs={menuDebounceMs ?? 120}
              modes={modes}
              attachmentsEnabled={attachmentsEnabled}
              attachLabel={attachLabel}
              onMode={onAddMode}
              onAttach={onAttachClick}
              onInsertTrigger={onAddInsertTrigger}
              onPickItem={onAddPickItem}
            />
          )}
        </div>
      ) : attachmentsEnabled ? (
        <button
          type="button"
          data-harness="composer-attach"
          onClick={onAttachClick}
          disabled={disabled}
          aria-label="Attach files"
        >
          {attachLabel}
        </button>
      ) : null}

      {showModeChip ? (
        inlaid ? (
          <span data-harness="mode-chip" data-mode={mode}>
            <button
              type="button"
              data-harness="mode-chip-label"
              disabled={disabled}
              onClick={cycleMarkedMode}
            >
              <ModeGlyph mode={mode} />
              {titleCaseMode(mode)}
            </button>
            <button
              type="button"
              data-harness="mode-chip-clear"
              aria-label={`Use ${unmarkedMode} mode`}
              disabled={disabled}
              onClick={clearMode}
            >
              ×
            </button>
          </span>
        ) : (
          <button type="button" data-harness="mode-chip" onClick={cycleMode} disabled={disabled}>
            <ModeGlyph mode={mode} />
            {titleCaseMode(mode)}
          </button>
        )
      ) : null}
    </div>
  );

  const trailing = (
    <div data-harness="composer-trailing">
      {trailingActions}
      {turnInProgress && onCancel !== undefined ? (
        <button type="button" data-harness="composer-cancel" aria-label="Stop" onClick={onCancel}>
          {resolvedCancel}
        </button>
      ) : (
        <button
          type="button"
          data-harness="composer-send"
          aria-label="Send"
          onClick={submit}
          disabled={disabled || empty}
        >
          {resolvedSend}
        </button>
      )}
    </div>
  );

  const fileInput = attachmentsEnabled ? (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      accept="image/png,image/jpeg,image/gif,image/webp,text/*,application/json,.md,.txt,.csv"
      data-harness="composer-attach-input"
      hidden
      onChange={onFilesChosen}
    />
  ) : null;

  return (
    <div
      className={className}
      data-harness="composer"
      data-chrome={chrome}
      {...(inlaid ? { 'data-layout': multiline ? 'multi' : 'single' } : {})}
    >
      <ContextMenuPopup state={menu} />
      {inlaid ? (
        <>
          {leading}
          {editor}
          {trailing}
        </>
      ) : (
        <>
          {editor}
          <div data-harness="composer-actions">
            {leading}
            {trailing}
          </div>
        </>
      )}
      {fileInput}
    </div>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M12 19V5M6 11l6-6 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}
