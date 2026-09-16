import type { ChatModeId, ContextMenuDescriptor, ContextRef } from '@evu/harness-protocol';
import {
  type KeyboardEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  deleteChipAfterCaret,
  deleteChipBeforeCaret,
  mergeComposerRefs,
  paintComposer,
  readSelectionCaret,
  serializeComposer,
  setComposerCaret,
  toWireRefs,
  type ComposerValue,
} from '../composer/serialize.js';
import {
  type ContextMenuFetcher,
  useContextMenu,
} from '../hooks/use-context-menu.js';
import { ContextMenuPopup } from './ContextMenuPopup.js';

export interface ComposerProps {
  menus: readonly ContextMenuDescriptor[];
  fetchItems: ContextMenuFetcher;
  /** Modes offered by the mode chip, in cycle order. */
  modes: readonly ChatModeId[];
  mode: ChatModeId;
  onModeChange: (mode: ChatModeId) => void;
  /**
   * Called with wire text plus structured refs. Presentation fields on chips are
   * stripped — the payload matches `UserTurnInput`.
   */
  onSend: (value: { text: string; refs: ContextRef[]; caret: number }) => void;
  onCancel?: () => void;
  turnInProgress?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

const EMPTY: ComposerValue = { text: '', caret: 0, refs: [] };

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
 * text (chip tokens, not labels) plus `refs[]` at send time.
 */
export function Composer(props: ComposerProps) {
  const {
    menus,
    fetchItems,
    modes,
    mode,
    onModeChange,
    onSend,
    onCancel,
    turnInProgress = false,
    disabled = false,
    placeholder = 'Send a message…',
    className,
  } = props;

  const [value, setValue] = useState<ComposerValue>(EMPTY);
  const editorRef = useRef<HTMLDivElement>(null);
  // Menu picks rewrite the DOM from the wire value; keystrokes must not, or the
  // caret jumps on every character.
  const needsPaint = useRef(false);

  const applyValue = useCallback((next: ComposerValue, paint: boolean) => {
    if (paint) needsPaint.current = true;
    setValue(next);
  }, []);

  const menu = useContextMenu({
    menus,
    fetchItems,
    value,
    onChange: (next) => applyValue(next, true),
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
    };
  }, [value]);

  const syncFromEditor = useCallback(() => {
    applyValue(readEditor(), false);
  }, [applyValue, readEditor]);

  const submit = useCallback(() => {
    if (disabled) return;
    const current = readEditor();
    if (current.text.trim() === '') return;
    onSend({
      text: current.text,
      caret: current.caret,
      refs: toWireRefs(current.refs),
    });
    needsPaint.current = true;
    setValue(EMPTY);
  }, [disabled, readEditor, onSend]);

  const cycleMode = useCallback(() => {
    const index = modes.indexOf(mode);
    const next = modes[(index + 1) % modes.length];
    if (next !== undefined) onModeChange(next);
  }, [modes, mode, onModeChange]);

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
    [menu, value.caret, cycleMode, submit, turnInProgress, onCancel, syncFromEditor],
  );

  const empty = value.text.trim() === '';

  return (
    <div className={className} data-harness="composer">
      <ContextMenuPopup state={menu} />

      <div
        ref={editorRef}
        data-harness="composer-input"
        data-placeholder={placeholder}
        data-empty={empty ? 'true' : undefined}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        aria-disabled={disabled || undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onKeyDown={onKeyDown}
        // Contenteditable caret is selection-based; re-serialize on every mutation
        // and selection change so trigger detection stays caret-relative.
        onInput={syncFromEditor}
        onClick={syncFromEditor}
        onKeyUp={syncFromEditor}
        onBlur={syncFromEditor}
      />

      <div data-harness="composer-actions">
        <button type="button" data-harness="mode-chip" onClick={cycleMode} disabled={disabled}>
          {mode}
        </button>

        {turnInProgress && onCancel !== undefined ? (
          <button type="button" data-harness="composer-cancel" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            data-harness="composer-send"
            onClick={submit}
            disabled={disabled || empty}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
