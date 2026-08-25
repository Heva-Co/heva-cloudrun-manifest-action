/**
 * Drops keys that would emit as empty noise: `undefined`, `{}`, `[]`.
 *
 * A Cloud Run manifest with `resources: {}` or `env: []` is accepted but reads
 * as if the field were configured, and it shows up as a diff against what
 * `describe` returns. Absent is clearer than empty.
 *
 * Note this checks `undefined`, not falsiness: `maxRetries: 0` and
 * `minScale: 0` are meaningful values that must survive.
 */
export function pruneEmpty<T extends Record<string, unknown>>(obj: T): T {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) delete obj[k]
    else if (Array.isArray(v)) {
      if (v.length === 0) delete obj[k]
    } else if (v !== null && typeof v === 'object' && Object.keys(v).length === 0) {
      delete obj[k]
    }
  }
  return obj
}
