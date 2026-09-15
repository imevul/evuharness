#!/usr/bin/env bash
# Fetch the maintainer-only companion repository into docs/internal/.
#
# docs/internal/ is gitignored by this repository and is its own git repository:
# the "-internal" sibling of this project. It holds the roadmap, porting notes,
# and other maintainer material that AGENTS.md points to. Cloud Agent
# environments grant read access to it (the sibling repo is attached to the
# environment / declared via repositoryDependencies), so this script clones or
# updates it as part of environment setup.
#
# The sibling URL is derived from this repository's own `origin` remote so no
# organization or host name is baked into the publishable tree. Authentication is
# likewise not handled here: git's `url.*.insteadOf` rewrites configured by the
# environment turn the plain https URL into an authenticated one, so no token is
# ever read, logged, or written by this script. Set EVU_INTERNAL_REPO_URL to
# override the derived URL.
#
# The script is idempotent (safe to re-run) and non-fatal: when the repository is
# unreachable — for example a clone without access, as in a fresh public clone —
# it degrades to a warning and exits 0 so `install` still succeeds.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERNAL_DIR="$ROOT/docs/internal"
BRANCH="${EVU_INTERNAL_BRANCH:-main}"

export GIT_TERMINAL_PROMPT=0

log() { printf 'fetch-internal: %s\n' "$*"; }

derive_internal_url() {
  local origin
  origin="$(git -C "$ROOT" config --get remote.origin.url 2>/dev/null || true)"
  [[ -z "$origin" ]] && return 0
  origin="${origin%/}"
  origin="${origin%.git}"
  printf '%s-internal' "$origin"
}

REPO_URL="${EVU_INTERNAL_REPO_URL:-$(derive_internal_url)}"

if [[ -z "$REPO_URL" ]]; then
  log "no origin remote to derive the internal repository URL from; skipping."
  exit 0
fi

if ! git ls-remote "$REPO_URL" "$BRANCH" >/dev/null 2>&1; then
  log "cannot reach the internal repository; skipping."
  log "(docs/internal/ is maintainer-only and absent in fresh clones — this is not fatal.)"
  exit 0
fi

if [[ -e "$INTERNAL_DIR" && ! -d "$INTERNAL_DIR/.git" ]]; then
  log "docs/internal/ exists but is not a git checkout; leaving it untouched." >&2
  exit 0
fi

if [[ -d "$INTERNAL_DIR/.git" ]]; then
  log "updating existing docs/internal/ checkout"
  git -C "$INTERNAL_DIR" remote set-url origin "$REPO_URL"
  git -C "$INTERNAL_DIR" fetch --quiet --prune origin
  if git -C "$INTERNAL_DIR" checkout --quiet "$BRANCH" 2>/dev/null &&
    git -C "$INTERNAL_DIR" merge --ff-only --quiet "origin/$BRANCH" 2>/dev/null; then
    :
  else
    log "docs/internal/ has local or diverged changes; leaving them as-is." >&2
  fi
else
  log "cloning the internal repository into docs/internal/"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INTERNAL_DIR"
fi

log "docs/internal/ is at $(git -C "$INTERNAL_DIR" rev-parse --short HEAD) on $BRANCH"
