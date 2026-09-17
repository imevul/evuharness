import type {
  AttachmentRef,
  ChatModeId,
  ContextMenuDescriptor,
  ContextRef,
  HarnessFeaturesSnapshot,
  HarnessSettings,
  MemoryEntry,
  SessionSummary,
  StatusResponse,
  ToolCatalogEntry,
} from '@evu/harness-protocol';
import {
  AgentSettings,
  CompactionSettingsPanel,
  Composer,
  GateStack,
  HarnessClient,
  McpSettings,
  MemorySettings,
  PromptSettings,
  ProviderSettings,
  resolveActiveProviderSnapshot,
  SearchSettings,
  SessionSidebar,
  StatusBar,
  ToolCatalogView,
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
  const [settings, setSettings] = useState<HarnessSettings | null>(null);
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
    Promise.all([client.status(), client.getSettings(), client.contextMenus(), refreshSessions()])
      .then(([statusResponse, settingsResponse, catalog, list]) => {
        setStatus(statusResponse);
        setSettings(settingsResponse);
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

  const effectiveProvider = useMemo(
    () =>
      resolveActiveProviderSnapshot({
        base: status?.activeProvider ?? null,
        providers: settings?.providers ?? [],
        session: session.session?.provider,
      }),
    [status?.activeProvider, settings?.providers, session.session?.provider],
  );

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
    async (value: { text: string; refs: ContextRef[]; attachments: AttachmentRef[] }) => {
      // No per-send override here on purpose. `ChatRequest.provider` still exists for
      // hosts that want one, but the demo offers a single session-scoped choice: two
      // override scopes on one screen were more chrome than the distinction earned.
      await session.send({
        text: value.text,
        refs: value.refs,
        attachments: value.attachments,
      });
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

  // Settings takes the whole window rather than the main column: it has its own
  // sidebar of sections, and two sidebars side by side would compete. The session
  // hook above stays mounted across the switch, so a turn keeps streaming.
  if (screen === 'settings') {
    return (
      <SettingsScreen
        client={client}
        features={status?.features}
        onBack={() => {
          setScreen('chat');
          void Promise.all([client.status(), client.getSettings()]).then(
            ([statusResponse, settingsResponse]) => {
              setStatus(statusResponse);
              setSettings(settingsResponse);
            },
          );
        }}
      />
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

        <Transcript
          key={activeId ?? 'none'}
          className="chat-transcript"
          rows={session.transcript}
          turn={session.turn}
        />

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
          attachmentsEnabled={status?.features?.attachments === true}
          attachLabel={<PaperclipIcon />}
          placeholder={activeId === null ? 'Create a chat to begin' : 'Send a message…'}
        />

        <StatusBar
          className="chat-status"
          provider={effectiveProvider}
          providers={settings?.providers ?? []}
          override={session.session?.provider ?? null}
          pickerDisabled={activeId === null || (settings?.providers.length ?? 0) === 0}
          onProviderChange={(next) => {
            void session.setSessionProvider(next);
          }}
          onListModels={async (providerId) => (await client.listModels({ providerId })).models}
          usage={
            session.session?.usage ?? {
              promptTokensTotal: 0,
              completionTokensTotal: 0,
              lastPromptTokens: 0,
            }
          }
        />
      </main>
    </div>
  );
}

/** Decorative: the attach button carries its own `aria-label`. */
function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M20 10.5 11.8 18.7a4.6 4.6 0 0 1-6.5-6.5l8.2-8.2a3 3 0 1 1 4.3 4.3l-8.2 8.2a1.4 1.4 0 0 1-2-2l7.5-7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type SettingsSection =
  | 'providers'
  | 'prompts'
  | 'tools'
  | 'agents'
  | 'memory'
  | 'search'
  | 'mcp'
  | 'compaction';

const CORE_SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
  hint: string;
  feature?: keyof HarnessFeaturesSnapshot;
}> = [
  { id: 'providers', label: 'Providers', hint: 'Endpoints, models, context' },
  { id: 'prompts', label: 'Prompts', hint: 'Global and per-mode text' },
  { id: 'tools', label: 'Tools', hint: 'Availability and approval' },
  { id: 'agents', label: 'Agents', hint: 'Souls composed into the prompt', feature: 'agents' },
  { id: 'memory', label: 'Memory', hint: 'USER.md and MEMORY rows', feature: 'memory' },
  { id: 'search', label: 'Search', hint: 'web_search providers', feature: 'webSearch' },
  { id: 'mcp', label: 'MCP', hint: 'Remote list and call', feature: 'mcp' },
  {
    id: 'compaction',
    label: 'Compaction',
    hint: 'Rolling summary of older turns',
    feature: 'compaction',
  },
];

function SettingsScreen({
  client,
  features,
  onBack,
}: {
  client: HarnessClient;
  features: HarnessFeaturesSnapshot | undefined;
  onBack: () => void;
}) {
  const [settings, setSettings] = useState<HarnessSettings | null>(null);
  const [tools, setTools] = useState<ToolCatalogEntry[] | null>(null);
  const [catalogMode, setCatalogMode] = useState<ChatModeId>('agent');
  const [section, setSection] = useState<SettingsSection>('providers');
  const [error, setError] = useState<string | null>(null);
  const [userText, setUserText] = useState('');
  const [memories, setMemories] = useState<MemoryEntry[]>([]);

  const sections = CORE_SETTINGS_SECTIONS.filter(
    (item) => item.feature === undefined || features?.[item.feature] === true,
  );

  const refreshCatalog = useCallback(
    async (mode: ChatModeId) => {
      const catalog = await client.tools(mode);
      setTools(catalog.tools);
    },
    [client],
  );

  useEffect(() => {
    void client
      .getSettings()
      .then(setSettings)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client]);

  useEffect(() => {
    void refreshCatalog(catalogMode).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [catalogMode, refreshCatalog]);

  const refreshMemory = useCallback(
    async (query?: string) => {
      if (features?.memory !== true) return;
      const [profile, listed] = await Promise.all([
        client.getUserProfile(),
        client.listMemories(query),
      ]);
      setUserText(profile.text);
      setMemories(listed.memories);
    },
    [client, features?.memory],
  );

  useEffect(() => {
    void refreshMemory().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [refreshMemory]);

  const loadPromptPreview = useCallback(
    (mode: ChatModeId) => client.previewPrompt({ mode }),
    [client],
  );

  return (
    <div className="settings-layout">
      <nav className="settings-sidebar" aria-label="Settings sections">
        <button type="button" className="settings-back" onClick={onBack}>
          ← Back to chat
        </button>

        <h1>Settings</h1>

        <ul>
          {sections.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                data-active={item.id === section}
                aria-current={item.id === section ? 'page' : undefined}
                onClick={() => setSection(item.id)}
              >
                <span className="settings-section-label">{item.label}</span>
                <span className="settings-section-hint">{item.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="settings-main">
        {error !== null && <p className="error">{error}</p>}

        {settings === null || tools === null ? (
          <p className="settings-loading">Loading settings…</p>
        ) : (
          <div className="settings-section">
            {section === 'providers' && (
              <ProviderSettings
                settings={settings}
                onChange={async (update) => {
                  setSettings(await client.updateSettings(update));
                }}
                onTest={async (providerId) => client.testConnection({ providerId })}
                onListModels={async (providerId) =>
                  (await client.listModels({ providerId })).models
                }
              />
            )}

            {section === 'prompts' && (
              <PromptSettings
                settings={settings}
                onChange={async (update) => {
                  setSettings(await client.updateSettings(update));
                }}
                loadPreview={loadPromptPreview}
              />
            )}

            {section === 'tools' && (
              <section data-harness="tool-catalog-settings">
                <header data-harness="tool-catalog-settings-header">
                  <h2>Tools</h2>
                  <label>
                    Mode
                    <select
                      value={catalogMode}
                      onChange={(event) => setCatalogMode(event.target.value as ChatModeId)}
                      aria-label="Catalog mode"
                    >
                      {(settings.modes.length > 0 ? settings.modes : ['ask', 'plan', 'agent']).map(
                        (mode) => (
                          <option key={mode} value={mode}>
                            {mode}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                </header>
                <p data-harness="tool-catalog-settings-hint">
                  Availability follows the selected mode. Approval policy applies to future tool
                  calls.
                </p>
                <ToolCatalogView
                  mode={catalogMode}
                  tools={tools}
                  onApprovalChange={async (toolName, rule) => {
                    setSettings(
                      await client.updateSettings({
                        policies: { toolApprovals: { [toolName]: rule } },
                      }),
                    );
                    await refreshCatalog(catalogMode);
                  }}
                />
              </section>
            )}

            {section === 'agents' && (
              <AgentSettings
                settings={settings}
                onChange={async (update) => {
                  setSettings(await client.updateSettings(update));
                }}
              />
            )}

            {section === 'memory' && (
              <MemorySettings
                userText={userText}
                memories={memories}
                onSaveUser={async (text) => {
                  const profile = await client.setUserProfile(text);
                  setUserText(profile.text);
                }}
                onSearch={async (query) => {
                  await refreshMemory(query);
                }}
                onSaveMemory={async (write) => {
                  await client.upsertMemory(write);
                }}
                onDelete={async (id) => {
                  await client.deleteMemory(id);
                  await refreshMemory();
                }}
              />
            )}

            {section === 'search' && (
              <SearchSettings
                settings={settings}
                onChange={async (update) => {
                  setSettings(await client.updateSettings(update));
                }}
              />
            )}

            {section === 'mcp' && (
              <McpSettings
                settings={settings}
                onChange={async (update) => {
                  setSettings(await client.updateSettings(update));
                }}
                onTest={async (serverId) => client.probeMcp(serverId)}
              />
            )}

            {section === 'compaction' && (
              <CompactionSettingsPanel
                value={settings.compaction}
                onChange={async (update) => {
                  setSettings(await client.updateSettings(update));
                }}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
