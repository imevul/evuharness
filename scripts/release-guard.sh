#!/usr/bin/env bash
# Keep registry publishing switched off.
#
# The only valid release channel for this project is a GitHub Release. Enabling
# a registry publish is a deliberate decision that requires a human approval
# gate (a workflow job bound to a protected environment with required
# reviewers), never an incidental edit. This script is the mechanical half of
# that policy so it survives future editing sessions.
#
# Checks:
#   1. Every package.json declares "private": true.
#   2. Every package.json stays at version 0.0.0.
#   3. No manifest declares publishConfig.
#   4. Every package.json has a prepublishOnly hook that refuses.
#   5. No Makefile target or workflow invokes a registry publish.
#   6. No workflow references a registry auth token.
#
# Check 4 is per-manifest because the publish lifecycle runs the hook belonging to
# the directory being published. A root-only hook does nothing for
# `pnpm --filter <pkg> publish`, which is the realistic way this happens by accident.
#
# Negative coverage lives in scripts/test-release-guard.sh: a guard that has never
# been seen to fail is not known to work.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0

mapfile -t manifests < <(git ls-files --cached --others --exclude-standard '*package.json' |
  grep -v '/node_modules/' || true)

for manifest in "${manifests[@]}"; do
  [[ -f "$manifest" ]] || continue

  if ! node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    const problems = [];
    if (pkg.private !== true) problems.push("missing \"private\": true");
    if (pkg.version !== "0.0.0") problems.push(`version must stay 0.0.0 (found ${pkg.version})`);
    if (pkg.publishConfig !== undefined) problems.push("publishConfig is not allowed");
    const hook = pkg.scripts?.prepublishOnly;
    if (typeof hook !== "string" || !hook.includes("refuse-publish")) {
      problems.push("missing a prepublishOnly hook calling scripts/refuse-publish.mjs");
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`release-guard: ${file}: ${problem}`);
      process.exit(1);
    }
  ' "$manifest"; then
    fail=1
  fi
done

# A registry publish must not be reachable from the build interface.
publish_targets=()
[[ -f Makefile ]] && publish_targets+=(Makefile)
while IFS= read -r workflow; do
  publish_targets+=("$workflow")
done < <(git ls-files --cached --others --exclude-standard '.github/workflows/*' 2>/dev/null || true)
for manifest in "${manifests[@]}"; do
  [[ -f "$manifest" ]] && publish_targets+=("$manifest")
done

if [[ "${#publish_targets[@]}" -gt 0 ]]; then
  if matches="$(grep -REn -- '\bp?npm\b.*\bpublish\b' "${publish_targets[@]}" 2>/dev/null)"; then
    echo "release-guard: registry publish command found:" >&2
    echo "$matches" >&2
    fail=1
  fi

  if matches="$(grep -REn -- 'NPM_TOKEN|NODE_AUTH_TOKEN|registry\.npmjs\.org' \
    "${publish_targets[@]}" 2>/dev/null)"; then
    echo "release-guard: registry credential or registry host referenced:" >&2
    echo "$matches" >&2
    fail=1
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo "release-guard: FAILED — publishing stays off until a human approval gate is added" >&2
  exit 1
fi

echo "release-guard: OK (${#manifests[@]} manifests)"
