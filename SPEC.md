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
presentation layer rather than a fork. How a host chooses and wires those
surfaces is covered in [`docs/INTEGRATION.md`](./docs/INTEGRATION.md).

## Packages

| Package                  | Responsibility                                    |
| ------------------------ | ------------------------------------------------- |
| `@evu/harness-protocol`  | Wire contracts: sessions, events, gates, settings |
| `@evu/harness-core`      | Headless runtime; no HTTP, no DOM                 |
| `@evu/harness-sqlite`    | Durable session, grant, settings, and memory stores |
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
  compactContext,         // optional; defaults to naive truncating compaction
  features,               // optional builtins; each flag defaults off
});
```

Every list is an extension point. Hosts add tools, modes, menus, prompt slots,
and provider profiles without modifying the turn loop.

Optional builtins (`agents`, `memory`, `webSearch`, `httpRequest`, `compaction`,
`mcp`) are flag-gated. Off means no matching tools, no compose-prompt section,
no settings sidebar entry, and no routes beyond 404. The demo turns the flags
on; a host that leaves them off gets a smaller harness.

## Sessions

A session holds two parallel representations:

- **`messages`** — the thread sent to the model.
- **`transcript`** — the rows a UI renders.

They are deliberately distinct. Transcript rows carry presentation state such as
partial and cancelled markers that must never reach the model, and the message
thread carries system content a UI should not display verbatim. Assistant rows
also stamp `startedAt` (the turn pin time) and `createdAt` so a UI can show how
long a turn ran.

Completed transcript rows render as sanitized rich text: CommonMark plus GFM,
images, and mermaid fenced code blocks. Raw HTML is stripped. Image `src` values
are allowlisted (`https:` and `data:image/*`). A live stream stays plain text so
a half-closed fence does not flash a broken diagram on every token. A dedicated
mermaid tool is not part of the harness: models already emit fences. The
transcript stays pinned to the latest row while the person is at the bottom;
scrolling away reveals a jump control.

User turns may carry structured **attachments** (images and files) alongside
context-menu refs. Attachment chips serialize to stable tokens in the wire text
plus an `attachments[]` array on the request. Allowlisted images become
OpenAI-compatible multimodal `image_url` parts on the model thread; non-image
file text is wrapped as untrusted data. The feature is gated by
`features.attachments` (default off).

Sessions also carry pending gate state, cumulative token counts, and an optional
workspace scope.

The harness keeps an in-process LRU session cache in front of the configured
`SessionStore`, with a per-session mutex so concurrent read-modify-write paths on
one session serialize. Hosts configure `maxEntries` / optional TTL, or pass
`cache: false` to talk to the durable store directly. Cached records are cloned;
turn persistence still writes only turn-owned fields via `TurnPatch`, so a
mid-turn set-mode cannot be clobbered by a later save.

A session status bar is always-visible chrome for the active provider, the
active model, and context use. The provider readout may also be the control that
changes it: picking from it sets the session's override, choosing among profiles
that already exist. That does not make it a settings page — it never creates,
edits, or deletes a profile. The context fill is `lastPromptTokens /
maxContextTokens` for the active model. There is no donut when the max is
unknown — the harness does not invent a window.

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
| `plan_approval_required` | A proposed plan needs a decision     |
| `mode_switch_required`   | An agent mode-switch needs a decision|
| `usage`                  | Token accounting                     |
| `done`                   | Terminal success                     |
| `cancelled`              | Terminal cancellation                |
| `error`                  | Terminal failure                     |

`reasoning_delta` is optional: only providers that expose reasoning emit it.
The accumulated text lands on the transcript row's `reasoning` field and on the
terminal `done` / `cancelled` event, never inside the assistant `content` body.

`report_progress` is a runtime-owned tool in every stock mode. The model calls
it after thinking or after a tool result with one or two sentences of status.
The call is `always_allow` and has no host side effect: it persists as a tool
event whose `text` argument a UI shows as an inline note, folded into the same
work disclosure as thinking and other tools.

Cancellation is cooperative and always persists what was produced. A user who
sends another message during a live turn cancels it as a follow-up: the partial
result is saved and the queued messages are drained as a single next turn.

### Keep-alive and reconnect

While a `/chat` SSE body is open, the server emits periodic comment frames
(`: keepalive`) so proxies do not idle-timeout a quiet turn (long tool runs,
open gates). Comment frames are not events; clients ignore them.

Dropping the HTTP body does **not** cancel the turn. The server keeps draining
the turn loop so work finishes and persists. Explicit cancel remains
`POST /sessions/:id/cancel`.

Hosts that lose the stream should:

1. Keep stream ownership above route remounts when possible.
2. On unexpected disconnect, `GET /sessions/:id` and read `turnInProgress`.
3. If the flag is set, rebuild the live bubble from any trailing `partial`
   assistant transcript row and poll (or remount stream state) until it clears.

Full multi-tab fan-out of the live event stream is out of scope.

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
+ soul (active agent, when `features.agents` is on)
+ user (capped USER.md, when `features.memory` is on)
+ mcp snapshot (server labels and tool names, when `features.mcp` is on)
+ dynamic slots (host-provided, evaluated per session)
+ skills catalog
```

Empty optional sections are omitted. Composition is exposed as a preview so that
a person can see exactly what the model will receive, including dynamic content.

## Optional builtins

When a host opts in:

- **Agents** are named souls (`id`, `label`, `soul`). The active soul is composed
  after per-mode text.
- **Memory** is a store outside settings: singleton USER.md (standing facts and
  preferences about the person) and searchable MEMORY rows (everything else that
  should persist across chats). Tools: `read_user` / `write_user` /
  `search_memory` / `remember` / `forget`. USER.md is also injected, capped, so
  the model does not have to call `read_user` every turn. There is no line-range
  `patch_user` in v1.
- **Search** is `web_search` over named providers (`duckduckgo` or `searxng`).
  DuckDuckGo is seeded as the default when the feature is first enabled.
- **HTTP** is `http_request`. GET/HEAD run without approval; other methods
  require approval. Core applies an SSRF policy (loopback, link-local, RFC1918,
  and metadata addresses are blocked unless the host allowlists them).
- **MCP** is two proxy tools, `mcp_list` and `mcp_call`, over Streamable HTTP /
  SSE. Remote tools never join the harness catalog. Each server profile stores a
  reserved `permissions` object (`default` plus an empty `tools` map) so a later
  per-tool policy does not break the schema. Approval for `mcp_call` is resolved
  through `resolveMcpCallApproval`; the grant digest covers `{ serverId, tool,
  arguments }`. Stdio is out of scope.

## Context compaction

Before each provider `complete` call the turn loop runs a host-overridable
compaction hook over the outbound model thread (system prompt plus stored
messages, after leading-system merges such as skills and prompt extras). The
stock default is a naive truncator: keep the leading system message and the
newest messages within a configurable message and/or approximate token budget.
When `features.compaction` is on, the default is a rolling or drop compactor
that persists `{ summary, throughIndex, updatedAt }` on the session and injects
`## Earlier in this conversation` into the leading system message. The hook
runs every tool round and must stay idempotent. Stored messages stay verbatim.
On summarize failure the current summary is kept and the truncator still
applies. Hosts replace the hook, or pass an identity function to disable it.

## Providers

Providers are named profiles: a base URL, credentials, a model list, and effort
capabilities. A session or a single turn may override provider, model, and
effort. Settings can list available models and test a connection.

Max context tokens are per model id, not one number on the provider. The catalog
from `GET /v1/models` supplies each listed model's window when the host publishes
one. A person may override the window for a single model. Override inputs accept
k-notation (`K`/`M`/`G` ×1000, `Ki`/`Mi`/`Gi` ×1024) and expand to an integer
on blur and on save. The status snapshot reports the resolved max for the
active model.

## Security

See [SECURITY.md](./SECURITY.md) for the security model: secret handling,
approval integrity, grant scope isolation, and untrusted content boundaries.

## Authentication and identity

EvuHarness does not own accounts, roles, or sessions of identity. The host does.

The HTTP adapter accepts host-supplied `AuthHooks`:

- `getActor` resolves the caller for a request, or returns `null` to reject it as
  unauthenticated (`401`).
- `requireCapability` authorizes a named capability for that actor, or returns
  false to reject it as forbidden (`403`).

Capabilities the route surface asks about are `harness:read`, `harness:chat`,
`harness:decide`, and `harness:administer`. Omitting the hooks leaves the
harness unauthenticated, which is acceptable only for local development. A host
that already has an identity model maps it into these hooks and keeps account
storage, login, and tenancy in its own codebase.

## Non-goals

- Being an end-user chat application
- Managing infrastructure, services, or hardware
- Owning identity, tenancy, or billing
- Locking hosts to one storage engine, provider, or UI framework
