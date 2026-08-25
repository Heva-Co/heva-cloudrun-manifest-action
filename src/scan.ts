/**
 * Two independent signals for a plaintext secret in the manifest.
 *
 * (a) Name heuristic, in-process: an env key that looks like a credential.
 *     Deterministic, and catches short/low-entropy values that an entropy
 *     detector never would.
 * (b) Yelp's detect-secrets, out of process: entropy over the real value.
 *     Catches a high-entropy value behind an innocuous name.
 *
 * They overlap only partially, which is the point of running both.
 *
 * Nothing here ever emits a secret VALUE. detect-secrets reports
 * `hashed_secret`, never plaintext, and the line-number mapping turns a hit into
 * an env var NAME.
 */
import { spawnSync } from 'node:child_process'
import type { ScanMode, Spec } from './schema.js'

export type Finding = {
  name: string
  detector: string
  /** 'name' = signal (a), 'entropy' = signal (b). */
  source: 'name' | 'entropy'
}

/**
 * Suffixes that mark a credential. `NEXT_PUBLIC_*` is excluded because those are
 * compiled into the browser bundle by design — a publishable Stripe key is not a
 * secret, and flagging it would train people to ignore this check.
 */
const SECRET_NAME = /(_SECRET|_TOKEN|_PASSWORD|_PASS|_API_KEY|_PRIVATE_KEY|_CREDENTIALS|_AUTH|_KEY)$/

export function scanNames(spec: Spec, allow: ReadonlySet<string>): Finding[] {
  const out: Finding[] = []
  for (const { key, value } of spec.envPlain) {
    if (allow.has(key)) continue
    if (key.startsWith('NEXT_PUBLIC_')) continue
    if (value.trim().length === 0) continue // an empty flag is not a leaked secret
    if (SECRET_NAME.test(key)) {
      out.push({ name: key, detector: 'name-heuristic', source: 'name' })
    }
  }
  return out
}

export type DetectSecretsResult = {
  available: boolean
  findings: Finding[]
  /** Populated when detect-secrets could not run, for an honest summary line. */
  note?: string
}

export function detectSecretsAvailable(): boolean {
  const probe = spawnSync('detect-secrets', ['--version'], { encoding: 'utf8' })
  return probe.status === 0
}

/**
 * Runs scripts/scan_manifest.py over the rendered file.
 *
 * The Python side owns the detect-secrets call and the line-number -> env-var
 * mapping, so the entropy plugins and the baseline semantics stay exactly Yelp's
 * rather than reimplemented here.
 */
export function scanEntropy(
  manifestPath: string,
  scriptPath: string,
  baseline: string | undefined,
  allow: ReadonlySet<string>,
): DetectSecretsResult {
  if (!detectSecretsAvailable()) {
    return {
      available: false,
      findings: [],
      note:
        'detect-secrets is not installed, so the entropy scan was skipped. ' +
        'Install it with `pip install detect-secrets` (CI does this automatically).',
    }
  }
  const args = [scriptPath, '--manifest', manifestPath]
  if (baseline) args.push('--baseline', baseline)
  const proc = spawnSync('python3', args, { encoding: 'utf8' })
  if (proc.status !== 0) {
    return {
      available: true,
      findings: [],
      note: `scan_manifest.py failed (exit ${proc.status}): ${(proc.stderr || '').trim().slice(0, 500)}`,
    }
  }
  let parsed: { findings?: { name?: string; detector?: string }[] }
  try {
    parsed = JSON.parse(proc.stdout) as typeof parsed
  } catch {
    return { available: true, findings: [], note: 'scan_manifest.py returned malformed JSON' }
  }
  const findings = (parsed.findings ?? [])
    .map((f) => ({
      name: String(f.name ?? '<unknown>'),
      detector: String(f.detector ?? 'unknown'),
      source: 'entropy' as const,
    }))
    .filter((f) => !allow.has(f.name))
  return { available: true, findings }
}

/** Resolves `auto` against the target environment. */
export function effectiveMode(mode: ScanMode, environment: Spec['environment']): Exclude<ScanMode, 'auto'> {
  if (mode !== 'auto') return mode
  // Production is where a leaked credential is a real incident; dev and stg get
  // a warning so this never becomes the reason a deploy is blocked mid-sprint.
  return environment === 'prd' ? 'error' : 'warn'
}

/** Merges both signals, de-duplicating a name found by both. */
export function mergeFindings(a: Finding[], b: Finding[]): Finding[] {
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const f of [...a, ...b]) {
    const key = `${f.name}:${f.source}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
}
