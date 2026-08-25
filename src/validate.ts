/**
 * Post-render invariants.
 *
 * This is the half of the action that does not exist anywhere today. `envsubst`
 * substitutes every `$VAR` with no allowlist, so an unexported variable becomes
 * an empty string and the deploy silently ships misconfigured. Every check here
 * names the offending field, because an error that does not is the problem we
 * already have.
 */
import type { Spec } from './schema.js'
import { JOB_ONLY_INPUTS, SERVICE_ONLY_INPUTS } from './schema.js'

export class ValidationError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(
      problems.length === 1
        ? problems[0]
        : `${problems.length} problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    )
    this.name = 'ValidationError'
    this.problems = problems
  }
}

/**
 * An envsubst placeholder that nobody substituted.
 *
 * Two patterns, on purpose. A false positive here BLOCKS A DEPLOY, so precision
 * matters more than recall:
 *   - WHOLE: the value is nothing but a placeholder. Unambiguous.
 *   - ANY: a placeholder somewhere inside a longer string. Only applied to
 *     structural fields (name, image, annotations), never to env values — a real
 *     credential can legitimately contain `$SOMETHING`, and rejecting it would
 *     block a correct deploy.
 * Uppercase-only, because that is the shape envsubst templates actually use;
 * `$path` inside a value is far more likely to be real data.
 */
const UNRESOLVED_WHOLE = /^\$\{?[A-Z_][A-Z0-9_]*\}?$/
const UNRESOLVED_ANY = /\$\{?[A-Z_][A-Z0-9_]{1,}\}?/

/** Fields that must never be empty, because Cloud Run accepts them and then breaks. */
const REQUIRED_PATHS: [string, (s: Spec) => string][] = [
  ['name', (s) => s.name],
  ['image', (s) => s.image],
  ['service-account', (s) => s.serviceAccount],
  ['region', (s) => s.region],
]

function walkStrings(node: unknown, path: string, visit: (value: string, path: string) => void): void {
  if (typeof node === 'string') {
    visit(node, path)
    return
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkStrings(item, `${path}[${i}]`, visit))
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      walkStrings(v, path ? `${path}.${k}` : k, visit)
    }
  }
}

/**
 * Names of inputs the caller actually supplied. Needed for the cross-kind
 * check: the schema defaults make "absent" and "explicitly empty"
 * indistinguishable after parsing, so main.ts passes the raw set through.
 */
export type SuppliedInputs = ReadonlySet<string>

export function validate(
  spec: Spec,
  manifest: unknown,
  supplied: SuppliedInputs = new Set(),
  allowCrossEnv: ReadonlySet<string> = new Set(),
): void {
  const problems: string[] = []

  // (1) No envsubst placeholder survives. This is the unexported-variable bug.
  walkStrings(manifest, '', (value, path) => {
    // `env[].value` holds arbitrary user data, so only an exact-match
    // placeholder counts there. Everywhere else a placeholder anywhere is wrong.
    const isEnvValue = /^spec\..*\.env\[\d+\]\.value$/.test(path)
    const hit = isEnvValue
      ? UNRESOLVED_WHOLE.exec(value)
      : UNRESOLVED_WHOLE.exec(value) ?? UNRESOLVED_ANY.exec(value)
    if (hit) {
      problems.push(
        `${path}: unresolved placeholder ${hit[0]} — the workflow variable behind it is unset. ` +
          `Value was ${JSON.stringify(value)}.`,
      )
    }
  })

  // (2) Load-bearing fields are non-empty.
  for (const [label, get] of REQUIRED_PATHS) {
    if (get(spec).trim().length === 0) problems.push(`${label} is empty`)
  }
  for (const s of spec.envSecrets) {
    if (s.secret.trim().length === 0) {
      problems.push(`env-secrets: ${s.key} would render an empty secretKeyRef.name`)
    }
  }

  // (3) Environment / naming coherence. Catches pointing stg at a prd secret.
  const suffix = `-${spec.environment}`
  if (!spec.name.endsWith(suffix)) {
    problems.push(
      `name "${spec.name}" does not end in "${suffix}" for environment "${spec.environment}". ` +
        `Cloud Run workloads are expected to be named <service>-<env>. Rename, or correct the environment input.`,
    )
  }
  const otherEnvs = (['dev', 'stg', 'prd'] as const).filter((e) => e !== spec.environment)
  for (const s of spec.envSecrets) {
    if (allowCrossEnv.has(s.key)) continue
    const wrong = otherEnvs.find((e) => s.secret.endsWith(`-${e}`))
    if (wrong) {
      problems.push(
        `env-secrets: ${s.key} points at "${s.secret}", which belongs to "${wrong}", ` +
          `but this deploy is "${spec.environment}". Add ${s.key} to secret-scan-allow if this is deliberate.`,
      )
    }
  }

  // (4) Cross-kind inputs. Today nothing stops an ingress annotation on a Job,
  // where Cloud Run ignores it in silence.
  const forbidden = spec.kind === 'service' ? JOB_ONLY_INPUTS : SERVICE_ONLY_INPUTS
  for (const input of forbidden) {
    if (supplied.has(input)) {
      problems.push(
        `"${input}" does not apply to kind: ${spec.kind}. ` +
          `Cloud Run ignores it silently, so it is rejected here instead.`,
      )
    }
  }

  // (5) Duplicate env keys, within a block or across the two.
  const seen = new Map<string, string>()
  for (const [block, keys] of [
    ['env-plain', spec.envPlain.map((e) => e.key)],
    ['env-secrets', spec.envSecrets.map((e) => e.key)],
  ] as const) {
    for (const key of keys) {
      const prior = seen.get(key)
      if (prior) {
        problems.push(
          prior === block
            ? `env var ${key} is declared twice in ${block}`
            : `env var ${key} is declared in both ${prior} and ${block} — pick one`,
        )
      } else {
        seen.set(key, block)
      }
    }
  }

  if (problems.length > 0) throw new ValidationError(problems)
}
