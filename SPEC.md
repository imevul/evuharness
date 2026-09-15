# EvuHarness Specification

EvuHarness is a reusable AI chat harness. It provides the parts an application
needs to host a streaming, tool-calling assistant — sessions, modes, approvals,
rich input, prompts, settings — as configurable libraries rather than as a
finished product.

A host application chooses which parts it wants, supplies its own tools and data
sources, and gets a working chat surface. EvuHarness owns the harness; the host
owns its domain.

## Product boundary

EvuHarness owns:

- chat sessions and their transcripts
- the streaming turn loop, including tool rounds, cancellation, and follow-ups
- chat modes and the tool allowlists they imply
- permissions, approvals, and ask-user gates
- context menus for rich composer input
- prompt composition and preview
- provider, model, and effort selection
- the tool catalog and its registry
- the wire protocol shared by every surface

EvuHarness does not own:

- domain tools, or the systems they operate on
- host inventory, service maps, or infrastructure state
- user accounts, roles, or authentication
- any single presentation layer as a requirement

Host-specific glue belongs in the consuming project. EvuHarness exposes generic
package, protocol, and extension-point contracts so that glue stays thin.

## Surfaces

The runtime is presentation-free. Two consumption paths share one core:

- **In-process.** A TypeScript host imports the runtime, configures it, and
  mounts React components from the UI kit.
- **Over the protocol.** The same runtime runs behind an HTTP/SSE server, so a
  host in any language — or a terminal client — can drive it.

Web is the primary target. The protocol exists so that additional surfaces are a
presentation layer rather than a fork.

## Packages

| Package                  | Responsibility                                    |
| ------------------------ | ------------------------------------------------- |
| `@evu/harness-protocol`  | Wire contracts: sessions, events, gates, settings |
| `@evu/harness-core`      | Headless runtime; no HTTP, no DOM                 |
| `@evu/harness-sqlite`    | Durable session and grant stores                  |
| `@evu/harness-server`    | HTTP/SSE routes over the runtime                  |
| `@evu/harness-ui`        | React components bound to protocol types          |

Boundaries are enforced by review and by dependency direction:

- `protocol` depends on nothing but its schema library.
- `core` depends only on `protocol`. It must not import a web framework or touch
  the DOM.
- `server` composes routes over `core` and must not contain domain tools.
- `ui` speaks protocol types and must not execute tools or open a database.
- Apps are process shells. Reusable logic belongs in a package.

## Composition

A host builds a harness by describing what it wants:

```ts
const harness = createHarness({
  store: sessionStore,
  grants: grantStore,
  providers: [...],       // named provider profiles
  modes: [...],           // stock or custom mode policies
  tools: [...],           // host tools with schemas and handlers
  contextMenus: [...],    // composer menus, keyed by trigger character
  prompts: { global, perMode, dynamic },
  policies: { approvals, askUser },
});
```

Every list is an extension point. Hosts add tools, modes, menus, prompt slots,
and provider profiles without modifying the turn loop.

## Sessions

A session holds two parallel representations:

- **`messages`** — the thread sent to the model.
- **`transcript`** — the rows a UI renders.

They are deliberately distinct. Transcript rows carry presentation state such as
partial and cancelled markers that must never reach the model, and the message
thread carries system content a UI should not display verbatim.

Sessions also carry pending gate state, cumulative token counts, and an optional
workspace scope.

## Chat modes and the send-time pin

A mode is a policy: an identifier, the set of tools it permits, and a short
system blurb. Three stock modes ship:

| Mode    | Intent                                                  |
| ------- | ------------------------------------------------------- |
| `ask`   | Read-only. Answer questions, inspect, do not mutate.    |
| `plan`  | Read-only discovery that produces a plan for approval.  |
| `agent` | Mutating work, subject to the approval policy.          |

Mode ownership is split across three pieces of state that must never be
conflated:

| State                | Owner                | Changes when                              |
| -------------------- | -------------------- | ----------------------------------------- |
| Draft mode           | Client only          | The user toggles the control              |
| Session default mode | Session record       | A message is sent, or mode is set directly |
| Turn mode            | Per-turn snapshot    | Never — pinned at send                    |

The invariants:

- Toggling the draft mode has no server effect. It stages the next send and
  nothing more, so changing modes during a live turn is safe.
- A turn pins its mode, tool allowlist, and prompt at send time and holds them
  for the turn's whole lifetime, including across tool rounds and approval
  waits. A turn that resumes after an approval resumes under its original mode.
- Send-time mode wins over the stored session default and quietly updates it.
- Turn persistence never writes the mode field. Only send-time pinning, an
  explicit set-mode, and plan approval may write it. Without this rule, a turn
  that finishes after a set-mode would silently revert the user's choice.

## Approvals and grants

Each tool is either always allowed or requires approval. When a gated tool is
called, the turn pauses, emits an approval request carrying a digest of the exact
arguments, and waits for a decision:

| Decision          | Effect                                        |
| ----------------- | --------------------------------------------- |
| `allow_once`      | This exact call only, matched by digest       |
| `allow_session`   | This tool for the rest of the session         |
| `allow_workspace` | This tool across the session's workspace      |
| `allow_always`    | This tool everywhere                          |
| `deny`            | Refuse and report back to the model           |

Grants live outside the session record so that broader scopes are expressible.
A grant is keyed by scope, scope id, and tool name. Resolution widens from
session to workspace to global, and any hit allows.

When no workspace is set, `allow_workspace` records a global grant, so it
collapses into `allow_always` with no special-casing.

## Workspace scope

Sessions may carry an optional workspace id, fixed at creation. It filters
session listing and is threaded to every extension point — context menu sources,
dynamic prompt providers, and tool handlers — so that a host can scope data
without re-plumbing the runtime later.

A grant recorded for one workspace must never resolve in another.

## Human-in-the-loop gates

Three gates suspend a turn and wait for a person:

- **Tool approval** — a gated tool needs a decision.
- **Plan approval** — a proposed plan is accepted or discarded.
- **Ask-user** — the model asks a direct question and waits for an answer.

Ask-user is a first-class channel rather than a tool result convention, so every
surface can render it natively.

A fourth gate is agent-initiated: a mode switch request, which a person allows or
denies.

## Streaming

A turn is a stream of events:

| Event                    | Meaning                              |
| ------------------------ | ------------------------------------ |
| `status`                 | Turn lifecycle and session binding   |
| `system`                 | A system notice for the transcript   |
| `delta`                  | Assistant text increment             |
| `reasoning_delta`        | Reasoning text increment, if emitted |
| `tool`                   | A completed tool call                |
| `tool_approval_required` | A gate opened                        |
| `ask_user_required`      | A question needs an answer           |
| `usage`                  | Token accounting                     |
| `done`                   | Terminal success                     |
| `cancelled`              | Terminal cancellation                |
| `error`                  | Terminal failure                     |

Cancellation is cooperative and always persists what was produced. A user who
sends another message during a live turn cancels it as a follow-up: the partial
result is saved and the queued messages are drained as a single next turn.

## Context menus

Rich composer input is a catalog of context menus. There is no mention concept
and no command concept in the runtime; `@` and `/` are presets over one engine,
and a host registers its own menu by adding a catalog entry with a trigger
character and a source.

A source returns a recursive tree of groups and items, so a menu can be flat,
grouped, or nested to any depth, with children fetched lazily on drill-in.

Picking an item inserts a chip and records a structured reference. At send time
the menu's resolver decides what that reference does: leave the token inline,
attach a context block, merge text into the leading system message, or run a
command before the turn starts.

Icons are serializable string tokens, not components, so the same source data
drives any surface.

## Prompts

The system prompt is composed, not stored:

```
global prompt
+ mode blurb
+ per-mode prompt
+ dynamic slots (host-provided, evaluated per session)
+ skills catalog
```

Composition is exposed as a preview so that a person can see exactly what the
model will receive, including dynamic content.

## Providers

Providers are named profiles: a base URL, credentials, a model list, and effort
capabilities. A session or a single turn may override provider, model, and
effort. Settings can list available models and test a connection.

The first adapter targets OpenAI-compatible streaming APIs. The adapter
interface exists so other protocols can be added without touching the runtime.

## Security

See [SECURITY.md](./SECURITY.md) for the security model: secret handling,
approval integrity, grant scope isolation, and untrusted content boundaries.

## Non-goals

- Being an end-user chat application
- Managing infrastructure, services, or hardware
- Owning identity, tenancy, or billing
- Locking hosts to one storage engine, provider, or UI framework
