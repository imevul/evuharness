# Agent Instructions

These instructions apply to the EvuHarness repository.

## Read Order

1. Read [`SPEC.md`](./SPEC.md) before making product or architecture changes.
2. Check the maintainer roadmap at `docs/internal/ROADMAP.md` before starting
   feature work or changing product scope. It is maintainer-only and absent from
   fresh clones; if the directory does not exist, skip this step.
3. For repository layout, toolchain, and dev workflow, read
   [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).
4. Read the package `package.json` and `tsconfig.json` before editing a
   workspace.
5. For UI work, read [`docs/DESIGN.md`](./docs/DESIGN.md).
6. For host consumption, read [`docs/INTEGRATION.md`](./docs/INTEGRATION.md).
7. For security-sensitive work, read [`SECURITY.md`](./SECURITY.md).

## Product Boundary

EvuHarness owns the reusable chat harness: sessions, streaming turn loop, modes,
approvals and ask-user gates, context menus, prompt composition, provider
selection, tool registry, and the wire protocol.

It does not own domain tools, infrastructure state, user accounts, or any single
presentation layer. Host-specific glue belongs in the consuming project. If
something belongs elsewhere, expose a generic contract here and keep the glue in
the consumer.

## Package Boundaries

- `packages/protocol` is schema-only. No runtime behavior, no HTTP, no React.
- `packages/core` must stay free of HTTP frameworks, DOM access, and host domain
  types. It is the package a non-web surface imports.
- `packages/sqlite` owns durable store implementations, not routes or UI.
- `packages/server` composes routes over `core`. It must not own reusable domain
  logic and must not ship host tools.
- `packages/ui` may expose reusable React primitives bound to protocol types. It
  must not execute tools, read the filesystem, or open a database.
- `apps/*` are process shells and demo surfaces. A screen that is only useful in
  the demo stays in the app until it is proven reusable.

## Documentation Split

Tracked docs are the publishable set: `README.md`, `SPEC.md`, `SECURITY.md`,
`AGENTS.md`, and `docs/*.md`.

Maintainer-only notes live in `docs/internal/`, which is gitignored by this
repository and carries its own git history. It holds the roadmap, dev learnings,
porting notes, local provider details, performance numbers, unfixed security
findings, and release scratch.

Two rules follow from that split:

- **`SPEC.md` and every other tracked file must read as if this project were
  written from scratch.** No names of other private projects, no personal or
  homelab identifiers, no local filesystem paths. Design provenance belongs in
  `docs/internal/PORTING-NOTES.md`. `make public-tree-scan` enforces this.
- **Tracked docs may name an internal file but must not hyperlink to it.** Those
  links are dead in every clone. `make docs-check` enforces this.

## Keeping The Roadmap Honest

Update `docs/internal/ROADMAP.md` in the same working session as the shipped
work. Because the roadmap lives in a nested repository, one logical change means
two commits: one here, one in `docs/internal/`. Run `make internal-status` before
handoff so pending notes are not left uncommitted.

Only flip a task to `[X]` after the quality gates below pass. If a change ships,
splits, or reschedules a roadmap line, record that in the same session.

## Publishing

Registry publishing is off. The only valid release channel is a GitHub Release.

Every manifest stays `"private": true` at version `0.0.0`, no manifest declares
`publishConfig`, and no workflow references a registry credential.
`make release-guard` enforces all of this.

Enabling a registry publish requires a dedicated human approval gate — a separate
workflow job bound to a protected environment with required reviewers. Do not
introduce that job unprompted.

## Quality Gates

Run these before claiming implementation work is complete:

```bash
make lint       # Biome + public-tree-scan + docs-check + release-guard
make typecheck
make test
make build
```

`make verify` runs all four in order, and is what CI runs. Use `make verify-dev`
before handoff to additionally validate the dev compose config.

When touching a `Dockerfile`, run `make docker-lint` and fix findings or record
an intentional skip in `droast.toml`.
