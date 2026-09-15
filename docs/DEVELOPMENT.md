# Development

## Toolchain

| Tool       | Version                          |
| ---------- | -------------------------------- |
| Node       | >= 22.5 (for the built-in SQLite module) |
| pnpm       | 11.26.0 (pinned via `packageManager`) |
| TypeScript | 6.x, project references          |
| Biome      | lint and format                  |
| Vitest     | tests                            |

`make install` runs `pnpm install`. Everything else is a Make target; run
`make help` to list them.

## Layout

```
packages/
  protocol/   @evu/harness-protocol   schema-only wire contracts
  core/       @evu/harness-core       headless runtime
  sqlite/     @evu/harness-sqlite     durable stores
  server/     @evu/harness-server     HTTP/SSE routes
  ui/         @evu/harness-ui         React kit
apps/
  api/        demo server process
  web/        demo web app
deploy/       compose files
docs/         tracked documentation
scripts/      guard rails and dev helpers
```

Dependency direction is one-way: `protocol` <- `core` <- {`sqlite`, `server`},
and `ui` depends only on `protocol`. Apps may depend on anything. See the package
boundary rules in [`../AGENTS.md`](../AGENTS.md).

## Quality gates

```bash
make lint        # Biome + public-tree-scan + docs-check + release-guard
make typecheck
make test
make build
make verify      # all four, in order — this is what CI runs
make verify-dev  # verify + validate the dev compose config
```

`make build` drives TypeScript project references, so it also proves the package
dependency graph is acyclic and correctly declared.

## Guard rails

Three checks run inside `make lint` and are not optional:

- **`public-tree-scan`** fails when a deny-listed identifier appears anywhere in
  the publishable tree. The publishable tree is defined as the files git would
  ship: tracked plus untracked-not-ignored. Patterns live in
  `scripts/deny-list.txt`.
- **`docs-check`** validates relative markdown links in tracked docs and rejects
  any hyperlink into `docs/internal/`, since those links are dead in clones.
- **`release-guard`** asserts every manifest is private at `0.0.0` with no
  `publishConfig`, and that no Makefile target or workflow can reach a registry
  publish or references a registry credential.

If a scan fails because you wrote something genuinely private, move the prose
into `docs/internal/` rather than rewording it.

## Maintainer notes

`docs/internal/` is gitignored here and is its own git repository, so maintainer
notes keep history without ever entering the publishable tree. It holds the
roadmap, dev learnings, porting notes, local provider details, performance
numbers, unfixed security findings, and release scratch.

Because the parent repository cannot see it, `git status` at the root will never
remind you about pending notes. Run `make internal-status` before handoff.

A fresh clone will not have the directory at all. Anything required to build,
test, or understand the project must therefore live in tracked docs.

## Dev stack

```bash
make up      # detached
make dev     # foreground, with build output
make down
```

The compose stack builds two images from the repo root context and bind-mounts
the workspace, so ordinary source edits do not require a rebuild. Rebuild when a
`Dockerfile` or a dependency manifest changes.

| Service | Host port | Notes                          |
| ------- | --------- | ------------------------------ |
| api     | 4301      | `/health` for liveness         |
| web     | 4300      | proxies `/api` to the api service |

Ports are in the 43xx range to avoid colliding with sibling projects on 42xx.

State is a SQLite file under a named volume, so the first stack is two services
with no external database.

## Tests

Vitest runs from the repo root with workspace aliases resolved to package
sources, so tests do not need a build step first.

- Node environment by default; `packages/ui/test/**` runs in jsdom.
- Place tests in `<package>/test/**/*.test.ts`.

Some suites are intentionally `skip`ped: they encode behavior that is specified
but not yet implemented, and act as the checklist for the turn loop work. Do not
delete a skipped test to make a run green — implement it, or leave it skipped
with its reason intact.

## Docker

Follow the repository Dockerfile conventions: multi-stage builds, a dependency
layer before source, non-root runtime users, healthchecks, and a debug toolkit in
the production stage. Run `make docker-lint` after touching a `Dockerfile` and
fix findings or record an intentional skip in `droast.toml`.
