#!/usr/bin/env bash
# Fail when a deny-listed identifier appears anywhere in the publishable tree.
#
# The publishable tree is "files git would ship": tracked files plus untracked
# files that are not ignored. That definition means docs/internal/ and
# node_modules/ are excluded for free, because both are gitignored.
#
# Rationale: SPEC.md and the rest of the tracked docs must read as if this
# project were written from scratch. Prose drifts; a lint gate does not.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DENY_LIST="scripts/deny-list.txt"
if [[ ! -f "$DENY_LIST" ]]; then
  echo "public-tree-scan: missing $DENY_LIST" >&2
  exit 1
fi

# The scanner and its pattern list necessarily contain the patterns themselves.
SELF_EXCLUDED=(
  "scripts/deny-list.txt"
  "scripts/public-tree-scan.sh"
)

is_self_excluded() {
  local candidate="$1"
  for excluded in "${SELF_EXCLUDED[@]}"; do
    [[ "$candidate" == "$excluded" ]] && return 0
  done
  return 1
}

mapfile -t files < <(git ls-files --cached --others --exclude-standard)
if [[ "${#files[@]}" -eq 0 ]]; then
  echo "public-tree-scan: no files to scan"
  exit 0
fi

scan_files=()
for file in "${files[@]}"; do
  [[ -f "$file" ]] || continue
  is_self_excluded "$file" && continue
  scan_files+=("$file")
done

mapfile -t patterns < <(grep -Ev '^[[:space:]]*(#|$)' "$DENY_LIST")

found=0
for pattern in "${patterns[@]}"; do
  # Case-insensitive: identifiers get written in mixed case far more often than
  # in the canonical lowercase form, and a case-sensitive scan silently misses
  # exactly the prose a human would naturally type.
  # grep exits 1 when nothing matches, which is the success case here.
  if matches="$(grep -REin -- "$pattern" "${scan_files[@]}" 2>/dev/null)"; then
    echo "public-tree-scan: forbidden pattern /$pattern/:" >&2
    echo "$matches" >&2
    found=1
  fi
done

if [[ "$found" -ne 0 ]]; then
  echo "public-tree-scan: FAILED — scrub the identifier or move the note under docs/internal/" >&2
  exit 1
fi

echo "public-tree-scan: OK (${#scan_files[@]} files)"
