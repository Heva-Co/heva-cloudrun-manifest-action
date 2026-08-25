/**
 * Semantic diff between two manifests. Used by self-test.yml.
 *
 *   node dist/diff.cjs <got.yaml> <want.yaml>
 *
 * Built from the same normalize.ts the unit tests use, on purpose: a separate
 * `yq`-based comparison in the workflow could disagree with the tests, and then
 * one of the two would be lying. It also means the workflows need no `yq`, which
 * is not installed on every dev machine.
 */
import { readFileSync } from 'node:fs'
import { canonicalString } from './normalize.js'

const [got, want] = process.argv.slice(2)
if (!got || !want) {
  console.error('usage: diff.cjs <got.yaml> <want.yaml>')
  process.exit(2)
}

const a = canonicalString(readFileSync(got, 'utf8'))
const b = canonicalString(readFileSync(want, 'utf8'))

if (a === b) {
  console.log(`✓ ${got} matches ${want} (semantically)`)
  process.exit(0)
}

console.error(`✗ ${got} differs from ${want}\n`)
const al = a.split('\n')
const bl = b.split('\n')
for (let i = 0; i < Math.max(al.length, bl.length); i++) {
  if (al[i] !== bl[i]) {
    console.error(`line ${i + 1}:`)
    console.error(`  want: ${bl[i] ?? '<absent>'}`)
    console.error(`  got:  ${al[i] ?? '<absent>'}`)
  }
}
process.exit(1)
