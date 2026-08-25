/**
 * Manifest object -> YAML text.
 *
 */
import type { YAMLMap, YAMLSeq} from 'yaml';
import { Document, Scalar, isMap, isSeq, stringify } from 'yaml'

/** Keys whose scalar values must always be double-quoted in the output. */
const FORCE_QUOTED_PARENTS = new Set(['annotations', 'labels'])

function forceQuoteScalar(node: unknown): void {
  if (!(node instanceof Scalar)) return
  if (typeof node.value !== 'string') node.value = String(node.value)
  const text = node.value as string
  // Single-quote anything containing a double quote. The network-interfaces
  // annotation is a JSON blob, and double-quoting it would escape every inner
  // quote into `\"` — valid YAML, unreadable in a review diff, and not what the
  // existing manifests look like. Falls back to double quotes when the value
  // itself contains a single quote, since YAML single-quoting escapes those by
  // doubling and that is worse than backslashes.
  node.type =
    text.includes('"') && !text.includes("'") ? Scalar.QUOTE_SINGLE : Scalar.QUOTE_DOUBLE
}

/**
 * Walks the document and applies the quoting rules.
 *
 * Done as a post-pass over the AST rather than by pre-stringifying values,
 * because the caller should hand us real numbers and booleans — losing the
 * types earlier would make `validate.ts` unable to range-check them.
 */
function applyQuoting(node: unknown, parentKey: string | null): void {
  if (isMap(node)) {
    for (const item of (node as YAMLMap).items) {
      const key = item.key instanceof Scalar ? String(item.key.value) : String(item.key)
      // Annotations and labels are string->string maps in the k8s API; an
      // unquoted `false` or `100` there is a type error server-side.
      if (FORCE_QUOTED_PARENTS.has(key) && isMap(item.value)) {
        for (const sub of (item.value as YAMLMap).items) forceQuoteScalar(sub.value)
        continue
      }
      // env[].value — the case Cloud Run is strict about.
      if (key === 'value' && parentKey === 'env') {
        forceQuoteScalar(item.value)
        continue
      }
      applyQuoting(item.value, key)
    }
    return
  }
  if (isSeq(node)) {
    for (const item of (node as YAMLSeq).items) applyQuoting(item, parentKey)
  }
}

export function emit(manifest: unknown): string {
  const doc = new Document(manifest)
  applyQuoting(doc.contents, null)
  return doc.toString({
    lineWidth: 0, // never wrap: a wrapped JSON annotation is unreadable in a diff
    // No `singleQuote` here on purpose: setting it forces a global preference
    // that overrides the per-scalar `type` chosen in forceQuoteScalar, which is
    // what keeps the JSON annotations single-quoted and escape-free.
    nullStr: '',
  })
}

/** Round-trips a manifest object to text and back, for tests. */
export function emitAndParse(manifest: unknown): unknown {
  return JSON.parse(JSON.stringify(manifest))
}

export { stringify }
