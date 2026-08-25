#!/usr/bin/env bash
# Is the committed bundle in dist/ what src/ currently builds to?
#
# dist/ is what GitHub Actions actually executes, so a merged src/ change with a
# stale dist/ means CI is green while every consumer runs the old code.
#
# Content-based, not `git diff -- dist/`: the index is not a reliable input here
# (a mid-staging index makes the check pass vacuously), and comparing bytes
# answers the real question directly.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp dist/index.cjs "$tmp/index.cjs.before"
cp dist/diff.cjs  "$tmp/diff.cjs.before"

pnpm run build >/dev/null

rc=0
for f in index.cjs diff.cjs; do
  if ! cmp -s "$tmp/$f.before" "dist/$f"; then
    echo "dist/$f is out of date: rebuilt output differs from the committed bundle." >&2
    rc=1
  fi
done

if [ "$rc" -ne 0 ]; then
  echo "Run 'pnpm build' and commit dist/." >&2
  exit 1
fi
echo "dist/ matches src/"
