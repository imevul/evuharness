#!/usr/bin/env bash
# Validate relative markdown links across tracked docs, and enforce that no
# tracked doc hyperlinks into docs/internal/.
#
# Tracked docs may *name* an internal file (AGENTS.md has to explain where the
# roadmap lives) but must not link to it: docs/internal/ is gitignored, so such
# a link is dead in every clone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0

mapfile -t doc_files < <(git ls-files --cached --others --exclude-standard '*.md')

for file in "${doc_files[@]}"; do
  [[ -f "$file" ]] || continue
  dir="$(dirname "$file")"

  while IFS= read -r target; do
    [[ -z "$target" ]] && continue
    # Strip any markdown title: [text](path "Title")
    target="${target%% *}"
    path_part="${target%%#*}"
    [[ -z "$path_part" ]] && continue

    case "$path_part" in
      http://* | https://* | mailto:* | data:* | /*) continue ;;
    esac

    if [[ "$path_part" == docs/internal/* || "$path_part" == */docs/internal/* ]]; then
      echo "docs-check: $file hyperlinks into docs/internal/ -> $target" >&2
      echo "  (name the file in prose instead; the link is dead in every clone)" >&2
      fail=1
      continue
    fi

    if [[ "$dir" == "." ]]; then
      candidate="$ROOT/$path_part"
    else
      candidate="$ROOT/$dir/$path_part"
    fi

    if [[ ! -e "$candidate" ]]; then
      echo "docs-check: broken link in $file -> $target" >&2
      fail=1
    fi
  done < <(grep -oE '\]\([^)]+\)' "$file" 2>/dev/null | sed -E 's/^\]\(//; s/\)$//')
done

if [[ "$fail" -ne 0 ]]; then
  echo "docs-check: FAILED" >&2
  exit 1
fi

echo "docs-check: OK (${#doc_files[@]} docs)"
