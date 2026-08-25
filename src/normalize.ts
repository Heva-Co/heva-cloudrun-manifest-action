/**
 * Canonical form for comparing two manifests.
 *
 * Golden tests and the self-test diff both compare PARSED and normalised YAML,
 * never bytes. Normalising the fleet's accumulated style drift is the point of
 * this action — key order, quoting, list indentation — so a byte-for-byte diff
 * against the hand-written manifests would fail by design.
 */
import { parse } from 'yaml'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/**
 * Arrays whose order carries no meaning, keyed by the field name that
 * identifies an element. `env`, `volumes` and `volumeMounts` are sets in
 * practice; `command`, `args` and `containers` are ordered and must NOT be
 * sorted — reordering argv changes what runs.
 */
const ORDER_INSENSITIVE: Record<string, string> = {
  env: 'name',
  volumes: 'name',
  volumeMounts: 'name',
  ports: 'name',
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const out: { [k: string]: Json } = {}
  for (const key of Object.keys(value).sort()) {
    const child = value[key] as Json
    const idField = ORDER_INSENSITIVE[key]
    if (idField && Array.isArray(child)) {
      const sorted = [...child].sort((a, b) => {
        const ak = keyOf(a, idField)
        const bk = keyOf(b, idField)
        return ak < bk ? -1 : ak > bk ? 1 : 0
      })
      out[key] = sorted.map(sortKeys)
      continue
    }
    out[key] = sortKeys(child)
  }
  return out
}

function keyOf(item: Json, field: string): string {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const v = item[field]
    if (typeof v === 'string') return v
  }
  return ''
}

/**
 * Scalars that Cloud Run accepts either quoted or bare, and that the existing
 * manifests write inconsistently: `timeoutSeconds: 900` vs `'3600'`,
 * `minScale: "1"` vs `1`. Comparing them as strings makes the golden tests
 * about semantics rather than about which repo happened to add quotes.
 */
function coerceScalars(value: Json): Json {
  if (Array.isArray(value)) return value.map(coerceScalars)
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
  }
  const out: { [k: string]: Json } = {}
  for (const [k, v] of Object.entries(value)) out[k] = coerceScalars(v as Json)
  return out
}

export function normalizeObject(doc: unknown): Json {
  return coerceScalars(sortKeys(doc as Json))
}

export function normalizeYaml(text: string): Json {
  return normalizeObject(parse(text))
}

/** Stable string form, for diffing and for test failure output. */
export function canonicalString(text: string): string {
  return JSON.stringify(normalizeYaml(text), null, 2)
}
