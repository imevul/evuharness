import type { SessionSummary } from '@evu/harness-protocol';

export interface SessionSidebarProps {
  sessions: readonly SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete?: (id: string) => void;
  className?: string;
}

/** The session list. Renders summaries only, which is why listing stays cheap. */
export function SessionSidebar(props: SessionSidebarProps) {
  const { sessions, activeId, onSelect, onCreate, onDelete, className } = props;

  return (
    <nav className={className} data-harness="session-sidebar">
      <button type="button" data-harness="session-new" onClick={onCreate}>
        New chat
      </button>

      <ul>
        {sessions.map((session) => (
          <li key={session.id} data-harness="session-row" data-active={session.id === activeId}>
            <button type="button" onClick={() => onSelect(session.id)}>
              <span data-harness="session-title">{session.title}</span>
              <span data-harness="session-mode">{session.mode}</span>
              {session.turnInProgress && <span data-harness="session-live">●</span>}
            </button>

            {onDelete !== undefined && (
              <button
                type="button"
                data-harness="session-delete"
                aria-label={`Delete ${session.title}`}
                onClick={() => onDelete(session.id)}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
