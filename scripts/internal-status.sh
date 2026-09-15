#!/usr/bin/env bash
# Warn when the nested docs/internal repository has uncommitted work.
#
# docs/internal/ is gitignored by the parent and carries its own git history, so
# `git status` at the repo root can never surface pending notes. Without a
# nudge, maintainer notes sit dirty for weeks.
#
# Advisory only: exits 0 so it never blocks a build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERNAL="$ROOT/docs/internal"

if [[ ! -d "$INTERNAL" ]]; then
  echo "internal-status: docs/internal/ not present (maintainer-only; absent in fresh clones)"
  exit 0
fi

if [[ ! -d "$INTERNAL/.git" ]]; then
  echo "internal-status: docs/internal/ exists but is not a git repository." >&2
  echo "  Run: git -C docs/internal init -b main && git -C docs/internal add -A" >&2
  exit 0
fi

status="$(git -C "$INTERNAL" status --porcelain)"
if [[ -n "$status" ]]; then
  echo "internal-status: docs/internal/ has uncommitted changes:"
  echo "$status" | sed 's/^/  /'
  echo "  Commit them: git -C docs/internal add -A && git -C docs/internal commit"
else
  echo "internal-status: docs/internal/ is clean"
fi

if ! git -C "$INTERNAL" remote | grep -q .; then
  echo "internal-status: no remote configured — history survives file deletion, not disk loss."
fi
