#!/usr/bin/env bash
# Everything ci.yml runs, in one command, so a PR never fails on something that
# was reproducible locally.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "typecheck"; pnpm exec tsc --noEmit
step "lint";      pnpm exec eslint src tests
step "shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck scripts/*.sh
else
  echo "SKIPPED: shellcheck not installed (brew install shellcheck)" >&2
fi

step "actionlint"
if command -v actionlint >/dev/null 2>&1; then
  actionlint .github/workflows/*.yml
  # examples/ too: actionlint infers the schema from the path, so they are staged
  # under a .github/workflows tree first. A renamed input breaks here rather than
  # breaking the deploy of whoever copies the example.
  lint_dir="$(mktemp -d)/.github/workflows"
  mkdir -p "$lint_dir" && cp examples/*.yml "$lint_dir/"
  (cd "$lint_dir/../.." && actionlint .github/workflows/*.yml)
else
  echo "SKIPPED: actionlint not installed (brew install actionlint)" >&2
fi

step "unit tests";pnpm exec vitest run
step "build + dist drift"; ./scripts/check-dist.sh

step "detect-secrets"
if command -v detect-secrets >/dev/null 2>&1; then
  ./scripts/scan-repo.sh
else
  echo "SKIPPED: detect-secrets not installed (brew install detect-secrets)" >&2
fi

printf '\n\033[32mAll checks passed.\033[0m\n'
