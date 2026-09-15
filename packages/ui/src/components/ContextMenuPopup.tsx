import { isGroup } from '@evu/harness-protocol';
import type { ContextMenuState } from '../hooks/use-context-menu.js';

export interface ContextMenuPopupProps {
  state: ContextMenuState;
  /** Class name hook; this kit ships structure and leaves styling to the host. */
  className?: string;
}

/**
 * One popup for every registered trigger.
 *
 * There is no mention popup and no command popup — the descriptor supplies the
 * trigger, the icon, and the label, so a host that registers a third trigger gets
 * this rendering for free. Groups render with an affordance to drill in; items
 * commit.
 *
 * Rendering only; all state transitions live in `useContextMenu`. Keyboard handling
 * belongs to the composer, since the events arrive on the textarea, not here.
 */
export function ContextMenuPopup({ state, className }: ContextMenuPopupProps) {
  if (state.match === null || state.menu === null) {
    return null;
  }

  const showEmpty = !state.loading && state.error === null && state.nodes.length === 0;

  return (
    <div className={className} data-harness="context-menu" role="listbox">
      {state.path.length > 0 && (
        <button type="button" data-harness="context-menu-back" onClick={state.back}>
          ← {state.path[state.path.length - 1]}
        </button>
      )}

      {state.loading && <div data-harness="context-menu-loading">Searching…</div>}
      {state.error !== null && <div data-harness="context-menu-error">{state.error}</div>}
      {showEmpty && <div data-harness="context-menu-empty">No matches</div>}

      {state.nodes.map((node, index) => (
        <button
          key={node.id}
          type="button"
          role="option"
          aria-selected={index === state.highlighted}
          data-harness={isGroup(node) ? 'context-menu-group' : 'context-menu-item'}
          data-highlighted={index === state.highlighted ? 'true' : undefined}
          // Pointer enter rather than focus: moving the mouse should preview a row
          // without stealing focus from the textarea the user is typing in.
          onMouseEnter={() => state.setHighlighted(index)}
          onClick={() => state.select(node)}
        >
          <span data-harness="context-menu-icon">{node.icon ?? state.menu?.icon}</span>
          <span data-harness="context-menu-label">{node.label}</span>
          {node.hint !== undefined && <span data-harness="context-menu-hint">{node.hint}</span>}
          {isGroup(node) && <span data-harness="context-menu-chevron">›</span>}
        </button>
      ))}
    </div>
  );
}
