import {
  applyTurnPatch,
  createSessionRecord,
  digestToolCall,
  emptyStoredSettings,
  grantForDecision,
  resolveGrant,
  setSessionMode,
  storedFromInput,
} from '@evu/harness-core';
import {
  openDatabase,
  SqliteGrantStore,
  SqliteSessionStore,
  SqliteSettingsStore,
} from '@evu/harness-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TOOL = 'restart_service';
const SESSION = 'session-1';
const WORKSPACE = 'workspace-a';

let sessions: SqliteSessionStore;
let grants: SqliteGrantStore;
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  // One in-memory database shared by both stores, mirroring a single-file deployment.
  db = openDatabase({ path: ':memory:' });
  sessions = new SqliteSessionStore({ db });
  grants = new SqliteGrantStore({ db });
});

afterEach(() => {
  db.close();
});

function record(id = SESSION, mode = 'ask', workspaceId?: string) {
  return createSessionRecord({
    id,
    mode,
    workspaceId,
    now: '2026-01-01T00:00:00.000Z',
  });
}

describe('session persistence', () => {
  it('round-trips a session', async () => {
    const original = record();
    original.messages = [{ role: 'user', content: 'hello' }];
    original.transcript = [{ kind: 'user', text: 'hello' }];
    original.usage = { promptTokensTotal: 12, completionTokensTotal: 5, lastPromptTokens: 12 };

    await sessions.upsert(original);
    const loaded = await sessions.get(SESSION);

    expect(loaded).toEqual(original);
  });

  it('returns null for a missing session', async () => {
    expect(await sessions.get('nope')).toBeNull();
  });

  it('updates an existing session rather than duplicating it', async () => {
    await sessions.upsert(record());
    await sessions.upsert({ ...record(), title: 'Renamed' });

    expect((await sessions.get(SESSION))?.title).toBe('Renamed');
    expect(await sessions.listSummaries()).toHaveLength(1);
  });

  it('preserves createdAt across updates', async () => {
    await sessions.upsert(record());
    const updated = { ...record(), updatedAt: '2026-02-02T00:00:00.000Z' };
    await sessions.upsert(updated);

    expect((await sessions.get(SESSION))?.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('round-trips pending gate state', async () => {
    const original = record();
    original.pending = {
      toolApprovals: [
        {
          approvalId: 'a1',
          tool: TOOL,
          arguments: { name: 'api' },
          digest: 'abc',
          requestedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      plan: null,
      modeSwitch: null,
      askUser: {
        askId: 'q1',
        questions: [
          { id: 'q', prompt: 'Which?', choices: [], allowMultiple: false, allowFreeForm: true },
        ],
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
    };

    await sessions.upsert(original);

    expect((await sessions.get(SESSION))?.pending).toEqual(original.pending);
  });

  it('omits workspaceId when the column is null', async () => {
    await sessions.upsert(record());
    const loaded = await sessions.get(SESSION);

    expect('workspaceId' in loaded!).toBe(false);
  });

  it('deletes a session and reports whether it existed', async () => {
    await sessions.upsert(record());

    expect(await sessions.delete(SESSION)).toBe(true);
    expect(await sessions.delete(SESSION)).toBe(false);
    expect(await sessions.get(SESSION)).toBeNull();
  });

  it('does not hand out a live reference to stored state', async () => {
    await sessions.upsert(record());
    const first = await sessions.get(SESSION);
    first!.mode = 'agent';

    expect((await sessions.get(SESSION))?.mode).toBe('ask');
  });
});

describe('session listing', () => {
  it('orders newest first', async () => {
    await sessions.upsert({ ...record('old'), updatedAt: '2026-01-01T00:00:00.000Z' });
    await sessions.upsert({ ...record('new'), updatedAt: '2026-03-01T00:00:00.000Z' });

    expect((await sessions.listSummaries()).map((entry) => entry.id)).toEqual(['new', 'old']);
  });

  it('filters by workspace', async () => {
    await sessions.upsert(record('a', 'ask', WORKSPACE));
    await sessions.upsert(record('b', 'ask', 'workspace-b'));
    await sessions.upsert(record('c'));

    expect(
      (await sessions.listSummaries({ workspaceId: WORKSPACE })).map((entry) => entry.id),
    ).toEqual(['a']);
    expect(await sessions.listSummaries()).toHaveLength(3);
  });

  it('honors a limit', async () => {
    for (let index = 0; index < 5; index += 1) {
      await sessions.upsert(record(`s${index}`));
    }

    expect(await sessions.listSummaries({ limit: 2 })).toHaveLength(2);
  });

  it('reads usage from denormalized columns, not the payload', async () => {
    const original = record();
    original.usage = { promptTokensTotal: 100, completionTokensTotal: 50, lastPromptTokens: 30 };
    await sessions.upsert(original);

    const [summary] = await sessions.listSummaries();

    expect(summary?.usage).toEqual(original.usage);
  });

  it('does not include the transcript in a summary', async () => {
    const original = record();
    original.transcript = [{ kind: 'user', text: 'a long transcript row' }];
    await sessions.upsert(original);

    const [summary] = await sessions.listSummaries();

    expect('transcript' in summary!).toBe(false);
  });
});

/**
 * The mode-clobbering scenario, against real durable storage.
 *
 * The in-memory store can mask this bug when it aliases its state. Running the
 * same sequence through SQLite is the check that matters.
 */
describe('mode survives a turn that finishes late', () => {
  it('keeps a set-mode issued mid-turn', async () => {
    await sessions.upsert(record(SESSION, 'ask'));

    // A turn starts and loads the session as it was.
    const atSendTime = await sessions.get(SESSION);
    expect(atSendTime?.mode).toBe('ask');

    // The user switches to agent while the turn is still streaming.
    const midTurn = await sessions.get(SESSION);
    await sessions.upsert(setSessionMode(midTurn!, 'agent', 'explicit-set-mode'));

    // The turn finishes. It must re-read the record rather than writing back the
    // copy it loaded at send time.
    const latest = await sessions.get(SESSION);
    await sessions.upsert(
      applyTurnPatch(latest!, {
        transcript: [{ kind: 'assistant', text: 'answer' }],
        messages: [{ role: 'assistant', content: 'answer' }],
      }),
    );

    const final = await sessions.get(SESSION);

    expect(final?.mode).toBe('agent');
    expect(final?.transcript).toHaveLength(1);
  });

  it('would have lost the mode with a naive whole-record write', async () => {
    await sessions.upsert(record(SESSION, 'ask'));

    // Demonstrating the wrong implementation, so the guard above has a reference
    // point: hold the loaded record and write it back verbatim at the end.
    const heldFromSendTime = await sessions.get(SESSION);

    const midTurn = await sessions.get(SESSION);
    await sessions.upsert(setSessionMode(midTurn!, 'agent', 'explicit-set-mode'));

    await sessions.upsert({
      ...heldFromSendTime!,
      transcript: [{ kind: 'assistant', text: 'answer' }],
    });

    expect((await sessions.get(SESSION))?.mode).toBe('ask');
  });
});

/**
 * The durable store must satisfy the same grant semantics as the in-memory one.
 * These mirror the core suite deliberately: a store that diverges here is a
 * security bug, not a performance difference.
 */
describe('grant semantics parity', () => {
  async function addGrant(decision: Parameters<typeof grantForDecision>[0], workspaceId?: string) {
    const digest = digestToolCall(TOOL, { name: 'api' });
    const grant = grantForDecision(decision, {
      sessionId: SESSION,
      workspaceId,
      tool: TOOL,
      digest,
    });
    if (grant !== null) {
      await grants.add(grant);
    }
    return digest;
  }

  it('refuses an ungranted call', async () => {
    const digest = digestToolCall(TOOL, { name: 'api' });

    await expect(resolveGrant(grants, { sessionId: SESSION, tool: TOOL, digest })).resolves.toEqual(
      {
        allowed: false,
      },
    );
  });

  it('allows via session scope', async () => {
    const digest = await addGrant('allow_session');

    await expect(
      resolveGrant(grants, { sessionId: SESSION, tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true, via: 'session' });
  });

  it('allows via workspace scope', async () => {
    const digest = await addGrant('allow_workspace', WORKSPACE);

    await expect(
      resolveGrant(grants, {
        sessionId: 'another-session',
        workspaceId: WORKSPACE,
        tool: TOOL,
        digest,
      }),
    ).resolves.toMatchObject({ allowed: true, via: 'workspace' });
  });

  it('allows via global scope', async () => {
    const digest = await addGrant('allow_always');

    await expect(
      resolveGrant(grants, { sessionId: 'unrelated', tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true, via: 'global' });
  });

  it('isolates a workspace grant from another workspace', async () => {
    const digest = await addGrant('allow_workspace', WORKSPACE);

    await expect(
      resolveGrant(grants, {
        sessionId: SESSION,
        workspaceId: 'workspace-b',
        tool: TOOL,
        digest,
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it('isolates a session grant from another session', async () => {
    const digest = await addGrant('allow_session');

    await expect(resolveGrant(grants, { sessionId: 'other', tool: TOOL, digest })).resolves.toEqual(
      { allowed: false },
    );
  });

  it('does not apply a workspace grant when no workspace is in play', async () => {
    const digest = await addGrant('allow_workspace', WORKSPACE);

    await expect(resolveGrant(grants, { sessionId: SESSION, tool: TOOL, digest })).resolves.toEqual(
      { allowed: false },
    );
  });

  it('consumes a one-shot receipt exactly once', async () => {
    const digest = await addGrant('allow_once');

    await expect(
      resolveGrant(grants, { sessionId: SESSION, tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true, consumedReceipt: true });
    await expect(resolveGrant(grants, { sessionId: SESSION, tool: TOOL, digest })).resolves.toEqual(
      {
        allowed: false,
      },
    );
  });

  it('consumes only one of two identical receipts per resolution', async () => {
    const digest = await addGrant('allow_once');
    await addGrant('allow_once');

    await expect(
      resolveGrant(grants, { sessionId: SESSION, tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      resolveGrant(grants, { sessionId: SESSION, tool: TOOL, digest }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(resolveGrant(grants, { sessionId: SESSION, tool: TOOL, digest })).resolves.toEqual(
      {
        allowed: false,
      },
    );
  });

  it('does not treat a receipt as a standing grant', async () => {
    await addGrant('allow_once');
    const otherDigest = digestToolCall(TOOL, { name: 'web' });

    await expect(
      resolveGrant(grants, { sessionId: SESSION, tool: TOOL, digest: otherDigest }),
    ).resolves.toEqual({ allowed: false });
  });

  it('deduplicates a repeated standing grant', async () => {
    await addGrant('allow_session');
    await addGrant('allow_session');

    expect(await grants.list({ sessionId: SESSION, tool: TOOL })).toHaveLength(1);
  });

  it('keeps repeated receipts', async () => {
    await addGrant('allow_once');
    await addGrant('allow_once');

    expect(await grants.list({ sessionId: SESSION, tool: TOOL })).toHaveLength(2);
  });

  it('clears session grants without touching global ones', async () => {
    await addGrant('allow_session');
    await addGrant('allow_always');

    await grants.clearSession(SESSION);
    const remaining = await grants.list({ sessionId: SESSION, tool: TOOL });

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.scope).toBe('global');
  });

  it('does not authorize a different tool', async () => {
    await addGrant('allow_always');
    const otherDigest = digestToolCall('delete_everything', {});

    await expect(
      resolveGrant(grants, { sessionId: SESSION, tool: 'delete_everything', digest: otherDigest }),
    ).resolves.toEqual({ allowed: false });
  });
});

describe('settings persistence', () => {
  it('round-trips a provider including the secret, and survives a reopen', async () => {
    const settings = new SqliteSettingsStore({ db });
    const stored = emptyStoredSettings();
    stored.providers = [
      storedFromInput({
        id: 'local',
        baseUrl: 'https://example.test/v1',
        model: 'm',
        apiKey: 'keep-me',
      }),
    ];
    stored.activeProviderId = 'local';

    await settings.put(stored);
    const loaded = await settings.get();
    expect(loaded.providers[0]?.apiKey).toBe('keep-me');

    const again = new SqliteSettingsStore({ db });
    expect((await again.get()).providers[0]?.apiKey).toBe('keep-me');
  });

  it('returns empty settings when nothing has been written', async () => {
    const settings = new SqliteSettingsStore({ db });
    expect(await settings.get()).toEqual(emptyStoredSettings());
  });
});
