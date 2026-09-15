import type { ChatModeId, ContextMenuDescriptor } from '@evu/harness-protocol';
import { type KeyboardEvent, useCallback, useRef, useState } from 'react';
import {
  type ComposerValue,
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
  onSend: (value: ComposerValue) => void;
  onCancel?: () => void;
  turnInProgress?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

const EMPTY: ComposerValue = { text: '', caret: 0, refs: [] };

/**
 * The message composer: text, chips, mode chip, and the catalog popup.
 *
 * Keyboard handling lives here rather than in the popup because the events arrive
 * on the textarea. When a trigger is active the arrow keys, Enter, and Escape drive
 * the menu; otherwise they do their ordinary thing. That split is why the popup is
 * pure rendering.
 *
 * The mode chip writes only local draft state. It is the caller's decision whether
 * a change also persists as the session default; this component never assumes it
 * does, so cycling modes during a turn stays harmless.
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
  const textarea = useRef<HTMLTextAreaElement>(null);

  const menu = useContextMenu({ menus, fetchItems, value, onChange: setValue });

  const submit = useCallback(() => {
    if (disabled || value.text.trim() === '') return;
    onSend(value);
    setValue(EMPTY);
  }, [disabled, value, onSend]);

  const cycleMode = useCallback(() => {
    const index = modes.indexOf(mode);
    const next = modes[(index + 1) % modes.length];
    if (next !== undefined) onModeChange(next);
  }, [modes, mode, onModeChange]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Shift+Tab cycles modes whether or not a menu is open, and must not move
      // focus out of the composer.
      if (event.key === 'Tab' && event.shiftKey) {
        event.preventDefault();
        cycleMode();
        return;
      }

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
    [menu, value.caret, cycleMode, submit, turnInProgress, onCancel],
  );

  return (
    <div className={className} data-harness="composer">
      <ContextMenuPopup state={menu} />

      {value.refs.length > 0 && (
        <div data-harness="composer-chips">
          {value.refs.map((ref) => (
            <span key={`${ref.menu}:${ref.path.join('/')}:${ref.id}`} data-harness="chip">
              {ref.token}
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={textarea}
        data-harness="composer-input"
        value={value.text}
        placeholder={placeholder}
        disabled={disabled}
        onKeyDown={onKeyDown}
        // Caret position is read from the element on every change and click, since
        // trigger detection is caret-relative: the same text means different things
        // depending on where the cursor sits.
        onChange={(event) => {
          // Read before setState: React nulls `currentTarget` after the listener
          // returns, and a functional updater runs later.
          const text = event.currentTarget.value;
          const caret = event.currentTarget.selectionStart;
          setValue((current) => ({ ...current, text, caret }));
        }}
        onClick={(event) => {
          const caret = event.currentTarget.selectionStart;
          setValue((current) => ({ ...current, caret }));
        }}
        onKeyUp={(event) => {
          const caret = event.currentTarget.selectionStart;
          setValue((current) => ({ ...current, caret }));
        }}
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
            disabled={disabled || value.text.trim() === ''}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
