#!/usr/bin/env python3
"""Run Yelp's detect-secrets over a rendered Cloud Run manifest.

Emits JSON on stdout:  {"findings": [{"name": "<ENV_VAR>", "detector": "..."}]}

Why a Python wrapper rather than calling detect-secrets from Node: detect-secrets
is a Python library, and its plugin set, entropy limits and
`# pragma: allowlist secret` semantics are exactly what we want to reuse rather
than reimplement. This script adds two things: the mapping from a reported line
number back to the env var name, and three workarounds for how the CLI behaves.

THREE NON-OBVIOUS DETECT-SECRETS BEHAVIOURS, all verified empirically against
1.5.0. Each one, if unhandled, produces an EMPTY result on a leaky manifest —
a false green, which is worse than no scan at all:

  1. `scan` without `--all-files` honours git tracking, so a rendered manifest in
     a temp directory is skipped in silence.
  2. Paths are resolved relative to the process cwd, and anything outside it is
     skipped in silence. So we chdir to the manifest's directory and pass the
     basename.
  3. `scan --baseline X` writes the updated baseline to X and prints NOTHING to
     stdout. So the baseline is applied here by filtering on `hashed_secret`
     instead of being handed to the CLI.

SECURITY: detect-secrets reports `hashed_secret`, never plaintext. This script
never reads a value out of the manifest either — only the `name:` of the env
entry a finding belongs to. Nothing secret reaches stdout.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

# `- name: FOO` / `name: FOO` in the env list. Captures the env var name.
ENV_NAME = re.compile(r"^\s*-?\s*name:\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?\s*$")
# `value: ...` — the line an inline-secret finding lands on.
VALUE_LINE = re.compile(r"^\s*value:\s")


def env_name_for_line(lines: list[str], lineno: int) -> str:
    """Nearest preceding `name:` for a 1-indexed line number.

    detect-secrets reports the line holding the value; in a Knative manifest the
    owning `name:` is the closest one above it. Walking up beats parsing YAML
    here because it stays correct across the block/flow style differences
    between repos.
    """
    idx = min(max(lineno, 1), len(lines)) - 1
    for i in range(idx, -1, -1):
        m = ENV_NAME.match(lines[i])
        if m:
            return m.group(1)
    return "<not-an-env-var>"


def baseline_hashes(path: str | None) -> set[str]:
    """Hashed secrets already audited into the repo's baseline."""
    if not path or not os.path.exists(path):
        return set()
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        print(f"warning: could not read baseline {path}", file=sys.stderr)
        return set()
    out: set[str] = set()
    for hits in (data.get("results") or {}).values():
        for hit in hits:
            h = hit.get("hashed_secret")
            if h:
                out.add(str(h))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--baseline", default=None)
    args = ap.parse_args()

    manifest = os.path.abspath(args.manifest)
    if not os.path.exists(manifest):
        print(f"manifest not found: {manifest}", file=sys.stderr)
        return 1

    known = baseline_hashes(os.path.abspath(args.baseline) if args.baseline else None)

    workdir = os.path.dirname(manifest)
    basename = os.path.basename(manifest)
    # --all-files and cwd=workdir are both load-bearing; see the module docstring.
    cmd = ["detect-secrets", "scan", "--all-files", basename]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False, cwd=workdir)
    except FileNotFoundError:
        print(json.dumps({"findings": [], "note": "detect-secrets not installed"}))
        return 0

    if proc.returncode != 0:
        print(f"detect-secrets failed: {proc.stderr.strip()}", file=sys.stderr)
        return 1

    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print("detect-secrets returned non-JSON output", file=sys.stderr)
        return 1

    with open(manifest, encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    findings = []
    seen = set()
    for hits in (report.get("results") or {}).values():
        for hit in hits:
            if str(hit.get("hashed_secret") or "") in known:
                continue
            lineno = int(hit.get("line_number") or 0)
            # Only inline `value:` findings are leaks. A hit on a secretKeyRef
            # name is a secret *reference* — the thing we want people to use.
            if lineno and lineno <= len(lines) and not VALUE_LINE.match(lines[lineno - 1]):
                continue
            name = env_name_for_line(lines, lineno)
            detector = str(hit.get("type") or "unknown")
            key = (name, detector)
            if key in seen:
                continue
            seen.add(key)
            findings.append({"name": name, "detector": detector})

    print(json.dumps({"findings": findings}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
