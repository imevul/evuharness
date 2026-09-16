import type {
  ChatModeId,
  ContextMenuDescriptor,
  HarnessSettings,
  SessionSummary,
  StatusResponse,
} from '@evu/harness-protocol';
import {
  Composer,
  GateStack,
  HarnessClient,
  ProviderSettings,
  SessionSidebar,
  StatusBar,
  Transcript,
  useHarnessSession,
} from '@evu/harness-ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * The demo shell.
 *
 * Deliberately thin. Everything reusable lives in `@evu/harness-ui`; what is here is
 * the wiring a host has to do anyway — pick a client, own the session list, decide
 * where the panels go. If a screen turns out to be useful beyond the demo it moves
 * into the kit, not the other way around.
 */
export function App() {
  const client = useMemo(
    () =>
      new HarnessClient({
        // A relative base URL because the dev server proxies `/api` to the API
        // process and the production image serves both behind one origin.
        baseUrl: '/api',
      }),
    [],
  );

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [menus, setMenus] = useState<ContextMenuDescriptor[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [screen, setScreen] = useState<'chat' | 'settings'>('chat');
  const [bootError, setBootError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    const response = await client.listSessions();
    setSessions(response.sessions);
    return response.sessions;
  }, [client]);

  useEffect(() => {
    // The catalog and the mode list come from the server rather than being hardcoded
    // here. That is the point of the descriptor: this app does not know which
    // triggers exist.
    Promise.all([client.status(), client.contextMenus(), refreshSessions()])
      .then(([statusResponse, catalog, list]) => {
        setStatus(statusResponse);
        setMenus(catalog.menus);
        setActiveId((current) => current ?? list[0]?.id ?? null);
        setBootError(null);
      })
      .catch((cause: unknown) => {
        setBootError(cause instanceof Error ? cause.message : 'Failed to reach the API');
      });
  }, [client, refreshSessions]);

  const modes = (status?.modes ?? ['agent']) as ChatModeId[];
  const initialMode = modes[0] ?? 'agent';

  const session = useHarnessSession({ client, sessionId: activeId, initialMode });

  const createSession = useCallback(async () => {
    const created = await client.createSession({ mode: session.draftMode });
    await refreshSessions();
    setActiveId(created.id);
  }, [client, session.draftMode, refreshSessions]);

  const deleteSession = useCallback(
    async (id: string) => {
      await client.deleteSession(id);
      const remaining = await refreshSessions();
      setActiveId((current) => (current === id ? (remaining[0]?.id ?? null) : current));
    },
    [client, refreshSessions],
  );

  const fetchItems = useCallback(
    async (menuId: string, request: { query: string; path: string[] }, signal: AbortSignal) =>
      client.contextMenuItems(menuId, request, signal),
    [client],
  );

  const send = useCallback(
    async (value: { text: string; refs: { menu: string; path: string[]; id: string }[] }) => {
      await session.send({ text: value.text, refs: value.refs });
      // Titles are derived from the first message, so the sidebar is stale until the
      // turn finishes.
      await refreshSessions();
    },
    [session, refreshSessions],
  );

  if (bootError !== null) {
    return (
      <main className="boot-error">
        <h1>Cannot reach the harness API</h1>
        <p>{bootError}</p>
        <p>
          Start the stack with <code>make dev</code>, then reload.
        </p>
      </main>
    );
  }

  return (
    <div className="layout">
      <SessionSidebar
        className="sidebar"
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id);
          setScreen('chat');
        }}
        onCreate={() => void createSession()}
        onDelete={(id) => void deleteSession(id)}
      />

      {screen === 'settings' ? (
        <SettingsScreen
          client={client}
          onBack={() => {
            setScreen('chat');
            void client.status().then(setStatus);
          }}
        />
      ) : (
        <main className="chat">
          <header className="chat-header">
            <span>{session.session?.title ?? 'No session'}</span>
            <span className="chat-header-actions">
              {status !== null && !status.providerConfigured && (
                <span className="warn">No provider configured</span>
              )}
              <button type="button" onClick={() => setScreen('settings')}>
                Settings
              </button>
            </span>
          </header>

          <Transcript className="chat-transcript" rows={session.transcript} turn={session.turn} />

          {session.error !== null && <div className="error">{session.error}</div>}

          {session.pending !== null && (
            <GateStack
              className="chat-gates"
              pending={session.pending}
              workspaceScoped={session.session?.workspaceId !== undefined}
              onToolDecision={(approvalId, decision) => {
                void session.decideToolApproval(approvalId, decision);
              }}
              onPlanDecision={(approve) => {
                if (activeId === null) return;
                void (approve ? client.approvePlan(activeId) : client.discardPlan(activeId));
              }}
              onModeSwitchDecision={(approve) => {
                if (activeId !== null) void client.decideModeSwitch(activeId, { approve });
              }}
              onAskUserAnswer={(askId, answers) => {
                if (activeId !== null) void client.answerAskUser(activeId, askId, { answers });
              }}
            />
          )}

          <Composer
            className="chat-composer"
            menus={menus}
            fetchItems={fetchItems}
            modes={modes}
            mode={session.draftMode}
            // Only the local draft changes here. Persisting the session default is a
            // separate, explicit call, which is what keeps a mid-turn mode change from
            // touching the turn.
            onModeChange={session.setDraftMode}
            onSend={(value) => void send(value)}
            onCancel={() => void session.cancel()}
            turnInProgress={session.turn !== null}
            disabled={activeId === null}
            placeholder={activeId === null ? 'Create a chat to begin' : 'Send a message…'}
          />

          <StatusBar
            className="chat-status"
            provider={status?.activeProvider ?? null}
            usage={
              session.session?.usage ?? {
                promptTokensTotal: 0,
                completionTokensTotal: 0,
                lastPromptTokens: 0,
              }
            }
          />
        </main>
      )}
    </div>
  );
}

function SettingsScreen({ client, onBack }: { client: HarnessClient; onBack: () => void }) {
  const [settings, setSettings] = useState<HarnessSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void client
      .getSettings()
      .then(setSettings)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client]);

  if (error !== null) {
    return (
      <main className="settings">
        <header className="chat-header">
          <button type="button" onClick={onBack}>
            Back
          </button>
        </header>
        <p className="error">{error}</p>
      </main>
    );
  }

  if (settings === null) {
    return (
      <main className="settings">
        <p>Loading settings…</p>
      </main>
    );
  }

  return (
    <main className="settings">
      <header className="chat-header">
        <span>Settings</span>
        <button type="button" onClick={onBack}>
          Back to chat
        </button>
      </header>
      <ProviderSettings
        settings={settings}
        onChange={async (update) => {
          setSettings(await client.updateSettings(update));
        }}
        onTest={async (providerId) => client.testConnection({ providerId })}
        onListModels={async (providerId) => (await client.listModels({ providerId })).models}
      />
    </main>
  );
}
