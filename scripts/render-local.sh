#!/usr/bin/env bash
# Render a fixture locally without `act`, by setting INPUT_* exactly as the
# runner does for a JS action and invoking the built bundle. This is the same
# code path `action.yml`'s generate step takes.
#
# It does NOT cover the wiring between composite steps — self-test.yml's
# env-inheritance job is what guards that.
#
#   ./scripts/render-local.sh tests/fixtures/backend-prd.inputs.yml [output.yaml]
set -euo pipefail
cd "$(dirname "$0")/.."

FIXTURE="${1:?usage: render-local.sh <fixture.inputs.yml> [output]}"
OUT="${2:-/tmp/cloudrun-local.yaml}"

[ -f dist/index.cjs ] || pnpm run build

env -i \
  PATH="$PATH" HOME="$HOME" \
  GITHUB_ACTION_PATH="$PWD" \
  RUNNER_TEMP="${TMPDIR:-/tmp}" \
  INPUT_FIXTURE="$FIXTURE" \
  INPUT_OUTPUT="$OUT" \
  node dist/index.cjs

echo
echo "==> wrote $OUT"
