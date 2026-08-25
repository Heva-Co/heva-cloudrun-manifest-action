/**
 * Parsers for the multi-line block inputs.
 *
 * GitHub Actions inputs are always strings, so every list-shaped or map-shaped
 * input arrives as one blob of text. core-api alone has 158 env vars, so
 * these blocks are the only shape that scales; individual inputs would not.
 */

export type KeyValue = { key: string; value: string }

/** Thrown for malformed input. Carries the offending line so the error names it. */
export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

/**
 * Splits a block into significant lines. Blank lines and `#` comments are
 * dropped so callers can group a long env list with comments the way the
 * current hand-written manifests do.
 */
export function lines(block: string | undefined): string[] {
  if (!block) return []
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

/**
 * Parses `KEY=VALUE` lines.
 *
 * Only the FIRST `=` splits, because values legitimately contain `=` —
 * `ALLOWED_ORIGINS=https://a.co?x=1`, base64 padding, JSON. Splitting on every
 * `=` would silently truncate those.
 */
export function parseKeyValueBlock(block: string | undefined, label: string): KeyValue[] {
  const out: KeyValue[] = []
  for (const line of lines(block)) {
    const eq = line.indexOf('=')
    if (eq < 0) {
      throw new InputError(`${label}: expected KEY=VALUE, got ${JSON.stringify(line)}`)
    }
    const key = line.slice(0, eq).trim()
    if (key.length === 0) {
      throw new InputError(`${label}: empty key in ${JSON.stringify(line)}`)
    }
    out.push({ key, value: line.slice(eq + 1).trim() })
  }
  return out
}

export type SecretRef = { key: string; secret: string; version: string }

/**
 * Parses `ENV_VAR=secret-id[:version]`.
 *
 * This one input replaces the three suffix conventions in use today
 * (`*_SECRET_NAME`, `*_SECRET`, `*_SECRET_ID`) plus the indirection through an
 * intermediate `$X_SECRET_NAME` placeholder. The GCP secret id is written
 * directly.
 *
 * Version defaults to `latest`, which is what 100% of the fleet uses.
 */
export function parseSecretBlock(block: string | undefined, label: string): SecretRef[] {
  return parseKeyValueBlock(block, label).map(({ key, value }) => {
    // rsplit on ':' — a version is always the trailing segment, and secret ids
    // cannot contain ':' (GCP allows only [A-Za-z0-9_-]).
    const colon = value.lastIndexOf(':')
    const hasVersion = colon > 0
    const secret = hasVersion ? value.slice(0, colon).trim() : value
    const version = hasVersion ? value.slice(colon + 1).trim() : 'latest'
    if (secret.length === 0) {
      // Deliberately explicit: an empty secretKeyRef.name is the exact failure
      // NEXT-ACTIONS.txt item 7 asks to be caught by name.
      throw new InputError(
        `${label}: ${key} has an empty secret id. ` +
          `An unset workflow variable renders an empty secretKeyRef.name and the deploy fails.`,
      )
    }
    if (version.length === 0) {
      throw new InputError(`${label}: ${key} has an empty secret version (use "${secret}" or "${secret}:latest")`)
    }
    return { key, secret, version }
  })
}

/** Parses a block of `k=v` into a plain object, for labels and annotations. */
export function parseMapBlock(block: string | undefined, label: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key, value } of parseKeyValueBlock(block, label)) {
    if (key in out) throw new InputError(`${label}: duplicate key ${key}`)
    out[key] = value
  }
  return out
}

/** Parses a list block (one item per line), e.g. `args`, `secret-scan-allow`. */
export function parseListBlock(block: string | undefined): string[] {
  return lines(block)
}

/**
 * Parses a compact probe spec: `path=/health,port=8080,initial-delay=10,...`.
 *
 * Compact rather than nested YAML because it has to survive as a single
 * Actions input string, and a probe has at most six fields.
 */
export type ProbeSpec = {
  path: string
  port?: number
  initialDelaySeconds?: number
  timeoutSeconds?: number
  periodSeconds?: number
  failureThreshold?: number
}

const PROBE_FIELDS: Record<string, keyof ProbeSpec> = {
  path: 'path',
  port: 'port',
  'initial-delay': 'initialDelaySeconds',
  timeout: 'timeoutSeconds',
  period: 'periodSeconds',
  'failure-threshold': 'failureThreshold',
}

export function parseProbe(spec: string | undefined, label: string): ProbeSpec | undefined {
  if (!spec || spec.trim().length === 0) return undefined
  const out: Partial<ProbeSpec> = {}
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq < 0) throw new InputError(`${label}: expected key=value, got ${JSON.stringify(part)}`)
    const rawKey = part.slice(0, eq).trim()
    const rawValue = part.slice(eq + 1).trim()
    const field = PROBE_FIELDS[rawKey]
    if (!field) {
      throw new InputError(
        `${label}: unknown probe field ${JSON.stringify(rawKey)}. ` +
          `Valid: ${Object.keys(PROBE_FIELDS).join(', ')}`,
      )
    }
    if (field === 'path') {
      out.path = rawValue
      continue
    }
    const n = Number(rawValue)
    if (!Number.isInteger(n) || n < 0) {
      throw new InputError(`${label}: ${rawKey} must be a non-negative integer, got ${JSON.stringify(rawValue)}`)
    }
    out[field] = n
  }
  if (!out.path) throw new InputError(`${label}: missing required probe field "path"`)
  return out as ProbeSpec
}

export type Traffic =
  | { mode: 'latest' }
  | { mode: 'hold'; revision: string }

/**
 * Parses the `traffic` input.
 *
 *   latest            -> this revision serves 100%
 *   hold=<revision>   -> <revision> keeps 100%, the new one is tagged at 0%
 *
 * Required rather than defaulted, deliberately. A Cloud Run `replace` is
 * declarative: an omitted `traffic` block gets the API default of
 * `latestRevision: 100`, so "I forgot to set it" and "serve this revision" would
 * be the same thing. Making it explicit means nobody takes production traffic
 * without having typed it.
 *
 * There is no bare `none`, and there cannot be. A no-traffic deploy has to NAME
 * the revision that keeps the 100% — this is what `gcloud run deploy
 * --no-traffic` resolves client-side before it writes the spec. The manifest
 * cannot say "leave traffic as it is".
 */
export function parseTraffic(value: string | undefined, label: string): Traffic {
  const raw = (value ?? '').trim()
  if (raw.length === 0) {
    throw new InputError(
      `${label} is required for kind: service. Use "latest" to serve this revision, ` +
        `or "hold=<revision>" to deploy without taking traffic. ` +
        `It has no default on purpose: to the Cloud Run API an omitted traffic block means ` +
        `all traffic to the latest revision, so a forgotten input would silently take ` +
        `production traffic.`,
    )
  }
  if (raw === 'latest') return { mode: 'latest' }

  const held = /^hold=(.*)$/.exec(raw)
  if (held) {
    const revision = (held[1] ?? '').trim()
    if (revision.length === 0) {
      // Not a judgement about whether a previous revision exists — that is Cloud
      // Run's state and the caller's `describe` to read. This only says the
      // instruction cannot be written: without a revision to hold, there is no
      // traffic block that keeps the new revision out of the request path.
      throw new InputError(
        `${label}: "hold=" has no revision, so there is nothing to hold traffic on. ` +
          `A no-traffic deploy has to name the revision that keeps serving. ` +
          `If the service has no revision yet, deploy with "latest" first.`,
      )
    }
    return { mode: 'hold', revision }
  }

  throw new InputError(
    `${label}: expected "latest" or "hold=<revision>", got ${JSON.stringify(raw)}. ` +
      `Percentage splits are not modelled yet — use the \`overlay\` input for a custom traffic block.`,
  )
}
