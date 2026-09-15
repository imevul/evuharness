#!/usr/bin/env bash
#
# Negative coverage for scripts/release-guard.sh.
#
# The guard passing on a clean tree proves nothing: a script with a typo in its
# pattern also passes. This copies the repo to a scratch directory, breaks one rule at
# a time, and asserts the guard fails each time.
#
# A scratch copy rather than edit-and-revert, so an interrupted run cannot leave the
# real manifests modified.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# Only the files the guard reads. It enumerates via `git ls-files`, so the copy needs
# to be a git repo with those files tracked.
build_fixture() {
  local dir="$1"
  rm -rf "${dir}"
  mkdir -p "${dir}/scripts" "${dir}/packages/protocol" "${dir}/.github/workflows"

  cp "${ROOT}/scripts/release-guard.sh" "${dir}/scripts/"
  cp "${ROOT}/scripts/refuse-publish.mjs" "${dir}/scripts/"
  cp "${ROOT}/package.json" "${dir}/"
  cp "${ROOT}/packages/protocol/package.json" "${dir}/packages/protocol/"
  cp "${ROOT}/Makefile" "${dir}/"
  cp "${ROOT}/.github/workflows/release.yml" "${dir}/.github/workflows/"

  git -C "${dir}" init -q
  git -C "${dir}" add -A
}

# expect_guard <expected: pass|fail> <case name> <mutation function>
expect_guard() {
  local expected="$1" name="$2" mutate="$3"
  local dir="${WORK}/case"

  build_fixture "${dir}"
  "${mutate}" "${dir}"
  git -C "${dir}" add -A 2>/dev/null || true

  local status=0
  ( cd "${dir}" && bash scripts/release-guard.sh >/tmp/guard-out 2>&1 ) || status=$?

  local actual
  if [[ "${status}" -eq 0 ]]; then actual=pass; else actual=fail; fi

  if [[ "${actual}" == "${expected}" ]]; then
    printf '  ok    %-46s %s\n' "${name}" "${actual}"
  else
    printf '  FAIL  %-46s got %s, want %s\n' "${name}" "${actual}" "${expected}"
    sed 's/^/        /' /tmp/guard-out
    FAILED=1
  fi
}

set_field() {
  node -e '
    const fs = require("node:fs");
    const [file, key, raw] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw === "__delete__") delete pkg[key];
    else pkg[key] = JSON.parse(raw);
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  ' "$@"
}

unchanged() { :; }
drop_private() { set_field "$1/packages/protocol/package.json" private '__delete__'; }
bump_version() { set_field "$1/packages/protocol/package.json" version '"1.0.0"'; }
add_publish_config() {
  set_field "$1/packages/protocol/package.json" publishConfig '{"access":"public"}'
}
drop_prepublish_hook() {
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    delete pkg.scripts.prepublishOnly;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  ' "$1/packages/protocol/package.json"
}
add_publish_script() {
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.scripts.release = "pnpm publish -r --access public";
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  ' "$1/package.json"
}
add_makefile_publish() {
  printf '\npublish:\n\tnpm publish\n' >> "$1/Makefile"
}
add_workflow_token() {
  printf '\n      # NODE_AUTH_TOKEN: placeholder\n' >> "$1/.github/workflows/release.yml"
}
add_registry_host() {
  printf '\n      # registry: https://registry.npmjs.org\n' >> "$1/.github/workflows/release.yml"
}

echo 'release-guard negative coverage'

# The baseline must pass, or every failure below is meaningless.
expect_guard pass 'clean tree'                       unchanged

expect_guard fail 'package.json without private'     drop_private
expect_guard fail 'package.json above 0.0.0'         bump_version
expect_guard fail 'package.json with publishConfig'  add_publish_config
expect_guard fail 'package.json without refuse hook' drop_prepublish_hook
expect_guard fail 'npm script that publishes'        add_publish_script
expect_guard fail 'Makefile target that publishes'   add_makefile_publish
expect_guard fail 'workflow with a registry token'   add_workflow_token
expect_guard fail 'workflow naming the registry'     add_registry_host

if [[ "${FAILED}" -ne 0 ]]; then
  echo 'release-guard tests: FAILED' >&2
  exit 1
fi

echo 'release-guard tests: ok'
