# Security

EvuHarness runs a model that calls tools on a host's behalf. The security model
is therefore about two things: keeping credentials out of reach, and making sure
that an action a person did not authorize cannot execute.

## Reporting

This project has no public issue tracker yet. Report suspected vulnerabilities
privately to the maintainer. Do not open a public issue for an unfixed finding.

## Secrets

- Provider credentials are configuration, never source. They arrive via
  environment variables or a host-supplied settings store.
- Never log a secret value, including at debug level, and including inside
  request or response dumps.
- Never return a secret after creation. Settings responses expose whether a
  credential is configured, not the credential.
- Attachments, prompts, and transcripts may contain user secrets. Treat session
  storage as sensitive at rest.

## Approval integrity

Approvals are the boundary between a model's intent and a real side effect.

- A gated tool must not execute before a decision arrives. The turn suspends;
  it does not optimistically proceed.
- An approval request carries a digest computed over the normalized tool
  arguments. A decision authorizes that digest. If the arguments change, the
  prior approval does not apply.
- `allow_once` is consumed. Re-running the same call requires a new decision.
- Broader grants (`allow_session`, `allow_workspace`, `allow_always`) are
  tool-scoped by design. Granting one is a deliberate widening of trust and must
  be presented as such in any UI.
- A denied call returns a refusal to the model. It must not be retried
  automatically under a different name.

## Grant scope isolation

- A grant is keyed by scope, scope id, and tool. The scope id is part of the
  lookup key, so a grant recorded for one workspace must never resolve in
  another.
- Resolution widens from session to workspace to global. It never narrows, and a
  global grant is never inferred from a narrower one: only an explicit
  `allow_always` decision writes global scope.
- When no workspace is set, `allow_workspace` writes global scope. That is
  intentional and equivalent, because without workspaces there is exactly one
  scope.

## Mode enforcement

- A turn's tool allowlist is pinned at send time. A tool outside the pinned
  mode's allowlist must be rejected by the runtime even if the model requests it
  and even if a grant exists.
- Read-only modes must not reach a mutating handler. Mode checks belong in the
  runtime, not only in the tool implementation.
- A model may request a mode switch, but only a person may approve one.

## Untrusted content

Tool results, attachments, and fetched documents are untrusted input that the
model will read.

- Wrap untrusted tool output so the model can distinguish data from
  instructions. Content that arrives from a tool must not be able to impersonate
  a system message.
- Prompt-injection resistance is a defense-in-depth goal, not a guarantee. The
  approval gate is the real control: assume a sufficiently adversarial document
  can make the model *attempt* an action, and rely on approvals to stop it.
- Sanitize markdown before rendering it in a UI. Mermaid diagrams render with a
  strict, no-click config so labels in a fence cannot become script.

## Filesystem and path handling

Any host source that exposes files — a context menu source, an attachment
handler, a skill loader — must:

- resolve and normalize paths before use, and reject anything that escapes the
  configured root
- refuse symlinks that leave the root
- enforce a size limit before reading

## Authentication

EvuHarness does not implement identity. The server adapter exposes hooks so a
host supplies its own actor resolution and capability checks.

- A host that skips those hooks has an unauthenticated harness. That is
  acceptable only for local development.
- Capability checks belong on the server boundary, before a turn starts.
- The demo application's shared-token mode is a development convenience and must
  not be used as a production auth scheme.
