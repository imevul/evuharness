# Integration

How a host application consumes EvuHarness. This is the consumption guide;
behavior and invariants live in [`../SPEC.md`](../SPEC.md), UI conventions in
[`DESIGN.md`](./DESIGN.md).

EvuHarness is libraries, not a product. The host owns domain tools, identity,
page layout, and look. The harness owns sessions, the turn loop, gates, menus,
prompts, and the wire protocol.

There is no registry publish. Consume a local checkout (`workspace:` or `file:`)
or a GitHub Release asset. Every package stays private at `0.0.0`.

## Two modes

| | Parts, custom UI | Full demo surface |
| --- | --- | --- |
| **You want** | Chat in your own chrome | The demo's capabilities, already built |
| **You mount** | Transcript, composer, gates | Those plus sidebar, status bar, settings panels |
| **You write** | Layout, session list, theme, tools | Layout and theme; compose the kit the demo does |
| **Flags** | Only what that surface needs | Usually the same set the demo turns on |

Both modes share one runtime and one protocol. The difference is how much of
`@evu/harness-ui` you mount, not a different backend.

The kit is React components bound to protocol types, not W3C custom elements.
They ship structure and `data-harness` attributes. Styles stay in the host.

There is no exported chat-page assembly. A host that wants "the whole demo"
composes the same pieces `apps/web` does. Layout that is only useful as that
demo stays in the app.

## Shared foundation

### Runtime

A host describes the harness, then serves or embeds it:

```ts
import { createHarness } from '@evu/harness-core';
import { createHarnessRouter } from '@evu/harness-server';

const harness = createHarness({
  store: sessionStore,
  grants: grantStore,
  settings: settingsStore,
  providers: [{ id: 'default', baseUrl, model }],
  tools: [yourTool],
  contextMenus: [yourMenu],
  features: {
    /* each flag defaults off */
  },
});

app.route('/api', createHarnessRouter({ harness, auth }));
```

Every list is an extension point. Add tools, modes, menus, prompt slots, and
provider profiles without changing the turn loop.

`createHarnessRouter` returns a Hono app. Mount it under any base path inside an
existing process; it does not start a listener.

The React kit talks HTTP/SSE through `HarnessClient`. A TypeScript host usually
mounts the router in-process (or as a sibling service) and points the client at
that origin. A non-web surface imports `core` and skips the kit.

Optional builtins (`agents`, `memory`, `webSearch`, `httpRequest`, `compaction`,
`mcp`, `attachments`) are flag-gated. Off means no matching tools, no
compose-prompt section, no settings entry, and 404 on the matching routes.

### Stores

In-memory stores ship on `core` and are enough for tests. Durable SQLite
implementations live in `@evu/harness-sqlite` (`SqliteSessionStore`,
`SqliteGrantStore`, `SqliteSettingsStore`, `SqliteMemoryStore`). Share one
database connection across those stores.

### Identity

EvuHarness does not own accounts. Pass `AuthHooks` into the router:

- `getActor` — who is calling, or `null` for 401
- `requireCapability` — whether that actor may `harness:read`, `harness:chat`,
  `harness:decide`, or `harness:administer`

Omitting the hooks leaves the harness unauthenticated, which is acceptable only
for local development. Map the host's existing identity into these hooks; keep
login and tenancy in the host. See [`../SECURITY.md`](../SECURITY.md).

### Client

```ts
import { HarnessClient } from '@evu/harness-ui';

const client = new HarnessClient({
  baseUrl: '/api',
  headers: () => ({ authorization: `Bearer ${token}` }),
});
```

`useHarnessSession` takes that client plus the active `sessionId`. Mount the
hook above route changes: remounting aborts only the local SSE reader; the
server keeps the turn. On disconnect the hook reloads session detail and, when
`turnInProgress` is set, rebuilds the live bubble and polls until the turn
ends.

## Parts with custom UI

Use this when the host already has a shell and wants a conversation: transcript,
composer, and tool gates. Session list, settings, and chrome stay yours.

### What to mount

From `@evu/harness-ui`:

- `useHarnessSession` — transcript, live turn, pending gates, send, cancel
- `Transcript` — persisted rows plus the in-flight turn
- `Composer` — contenteditable input, mode chip, context menus, optional attach
- `GateStack` — tool approval, plan, ask-user, mode-switch

Host-owned: how sessions are listed and created, the page frame, and CSS.

A typical column:

```tsx
const session = useHarnessSession({ client, sessionId, initialMode });

<Transcript rows={session.transcript} turn={session.turn} />

{session.pending !== null && (
  <GateStack
    pending={session.pending}
    workspaceScoped={session.session?.workspaceId !== undefined}
    onToolDecision={(id, decision) => void session.decideToolApproval(id, decision)}
    onPlanDecision={(approve) => {
      void (approve ? client.approvePlan(sessionId) : client.discardPlan(sessionId));
    }}
    onModeSwitchDecision={(approve) => {
      void client.decideModeSwitch(sessionId, { approve });
    }}
    onAskUserAnswer={(askId, answers) => {
      void client.answerAskUser(sessionId, askId, { answers });
    }}
  />
)}

<Composer
  menus={menus}
  fetchItems={(menuId, request, signal) => client.contextMenuItems(menuId, request, signal)}
  modes={modes}
  mode={session.draftMode}
  onModeChange={session.setDraftMode}
  turnInProgress={session.turn !== null}
  attachmentsEnabled={status.features.attachments}
  onSend={(value) =>
    void session.send({
      text: value.text,
      refs: value.refs,
      attachments: value.attachments,
    })
  }
  onCancel={() => void session.cancel()}
/>
```

Forward `attachments` when the flag is on. The composer already builds the
array; dropping it leaves chips that never reach the turn.

Draft mode is local. `onModeChange` must not persist a session default mid-turn.
Send pins the mode; `useHarnessSession` does that from `draftMode`.

Load `menus` and `modes` from `client.contextMenus()` and `client.status()`.
Do not hardcode triggers: the catalog is the source of truth.

### Tools

Register host tools on `createHarness`. A tool is a spec plus a handler:

```ts
{
  name: 'lookup_order',
  description: 'Look up an order by id',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  mutates: false,
  approval: 'always_allow',
  handler: async (args, ctx) => {
    return JSON.stringify(await orders.get(String(args.id), ctx.scope));
  },
}
```

`ctx.scope` carries the session and optional workspace so the handler can scope
data without reaching into the runtime. `mutates` and `approval` decide whether
`GateStack` opens. Stock modes: `ask` and `plan` are read-only; `agent` may
mutate, still subject to approval.

The kit does not execute tools. The handler runs in `core`.

`ToolCatalogView` is optional in this mode. Use it if the host wants people to
edit approval policy; otherwise set policy in settings or leave the defaults.

### Theme

Target `data-harness` attributes (`transcript`, `composer`, `gate-stack`,
`work-trace`, `chip`, …). The demo stylesheet in `apps/web/src/styles.css` is a
worked example, not a required dependency. Copy selectors you want; do not
import the demo app.

## Full demo surface

Use this when the host wants the same capabilities as the demo: sessions,
provider and prompt settings, tool catalog, status-bar provider menu, and
whichever optional builtins are enabled.

Still a composition, not a page import. `apps/web/src/App.tsx` is the reference.
Copy the wiring; keep host-specific chrome (auth, branding, extra nav) in the
host.

### Extra pieces

In addition to the parts-mode column:

| Piece | Role |
| --- | --- |
| `SessionSidebar` | Session list, create, delete. The host owns the session array. |
| `StatusBar` | Default/active provider, usage, optional `ProviderMenu` (active profiles only) and agent picker. |
| `ProviderSettings` | Named profiles, connection test, model browse. |
| `PromptSettings` | Global and per-mode text, assembled preview. |
| `ToolCatalogView` | Per-mode availability and approval policy. |
| `AgentSettings` | Souls, when `features.agents` is on. |
| `MemorySettings` | USER.md and MEMORY rows, when `features.memory` is on. |
| `SearchSettings` | `web_search` providers, when `features.webSearch` is on. |
| `McpSettings` | Remote servers, when `features.mcp` is on. |
| `CompactionSettingsPanel` | Rolling summary, when `features.compaction` is on. |

Settings is a host screen. The kit exports the panels, not the section sidebar.
Build the nav from `status.features` so a flag that is off does not appear.
The demo swaps the whole window to settings and keeps `useHarnessSession`
mounted so a turn keeps streaming.

`StatusBar` becomes a control only when you pass `providers`, `override`, and
`onProviderChange`. Without those it is display-only. Only `active` provider
profiles appear in that picker. Picking a provider there sets a session
override; it never creates or edits a named profile.

The agent dropdown appears when `onAgentChange` is passed and at least one
settings-active soul exists. None uses no agent; a pick pins one agent on the
session.

Enable flags on `createHarness` to match the panels you mount. The demo turns
on attachments, agents, memory, web search, HTTP, compaction, and MCP. A host
that wants a smaller surface leaves flags off and omits those panels.

Pass the matching stores (`memory` for memory, and so on). A flag without its
store is a misconfiguration, not a graceful empty page.

### Theme and layout

Same `data-harness` contract as parts mode. The demo's two-column chat layout
and settings sidebar live in `apps/web` because they assume that page. Reuse
the tokens and attribute selectors; replace the grid if the host shell is
different.

## What the host always owns

- Domain tools and the systems they call
- Identity, login, and tenancy (`AuthHooks` only)
- Which feature flags are on
- Session list ownership (create / select / delete)
- Page layout and CSS
- Provider credentials and network policy for outbound model calls

If something is only useful inside this repository's demo, it stays in `apps/*`
until it is proven reusable.

## Further reading

- [`../SPEC.md`](../SPEC.md) — product boundary, modes, gates, streaming, flags
- [`DESIGN.md`](./DESIGN.md) — kit tiers, composer, transcript, settings chrome
- [`../SECURITY.md`](../SECURITY.md) — secrets, grants, untrusted content
- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — repo layout and the demo stack
