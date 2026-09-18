# EvuHarness

A reusable AI chat harness. EvuHarness supplies the parts an application needs to
host a streaming, tool-calling assistant — sessions, modes, approvals, rich
input, prompts, and settings — as configurable libraries rather than a finished
product.

Bring your own tools and data sources; the harness handles the chat.

> Status: the harness, protocol, HTTP/SSE adapter, and React kit are usable.
> Packages are not published to a registry; consume a checkout or a GitHub
> Release. See [`docs/INTEGRATION.md`](./docs/INTEGRATION.md).

## What you get

- **Sessions** with a model thread and a separate UI transcript
- **Streaming turns** over server-sent events, with cooperative cancel and
  follow-up queueing
- **Chat modes** (`ask`, `plan`, `agent`) as policies that gate tool access
- **Approvals** with a five-step decision ladder and digest-bound one-shot grants
- **Ask-user** as a first-class gate, not a tool-result convention
- **Context menus** — one engine for `@`, `/`, and any trigger you register
- **Prompt composition** with dynamic slots and a preview
- **Provider, model, and effort** selection per session or per turn

## Packages

| Package                 | Responsibility                                    |
| ----------------------- | ------------------------------------------------- |
| `@evu/harness-protocol` | Wire contracts: sessions, events, gates, settings |
| `@evu/harness-core`     | Headless runtime; no HTTP, no DOM                 |
| `@evu/harness-sqlite`   | Durable session, grant, settings, and memory stores |
| `@evu/harness-postgres` | The same four stores over PostgreSQL                |
| `@evu/harness-server`   | HTTP/SSE routes over the runtime                  |
| `@evu/harness-ui`       | React components bound to protocol types          |

The runtime is presentation-free, so it can run in-process in a TypeScript app or
behind the HTTP/SSE server for hosts in other languages and other surfaces.

## Quick start

```bash
make install     # install workspace dependencies
make verify      # lint + typecheck + test + build
make up          # run the demo stack (API + web)
```

The demo API listens on `4301` and the demo web app on `4300`.

Run `make help` for the full target list.

## Composition sketch

```ts
import { createHarness, agentMode, askMode, planMode } from '@evu/harness-core';

const harness = createHarness({
  store: sessionStore,
  grants: grantStore,
  modes: [askMode, planMode, agentMode],
  providers: [{ id: 'default', baseUrl, model: 'your-model' }],
  tools: [yourTool],
  contextMenus: [mentionsMenu({ sources: [yourSource] })],
});
```

Every list is an extension point: add tools, modes, menus, prompt slots, and
providers without modifying the turn loop.

## Documentation

- [`docs/INTEGRATION.md`](./docs/INTEGRATION.md) — consuming the harness in a host
- [`SPEC.md`](./SPEC.md) — product boundary, behavior, and invariants
- [`SECURITY.md`](./SECURITY.md) — security model
- [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) — layout, toolchain, workflow
- [`docs/DESIGN.md`](./docs/DESIGN.md) — UI kit conventions
- [`AGENTS.md`](./AGENTS.md) — contributor and agent guardrails

## Releases

EvuHarness releases through GitHub Releases only. Packages are not published to a
registry. A `v*` tag (or a manual Release workflow run) uploads `file:`-ready
tarballs: extract `evuharness-packages.tgz` and depend on
`file:vendor/evuharness/packages/<name>`, or `file:` a single `evu-harness-*.tgz`
and let sibling `@evu/*` specs resolve to the other assets on that release.
See [`docs/INTEGRATION.md`](./docs/INTEGRATION.md).

## License

MIT — see [`LICENSE`](./LICENSE).
