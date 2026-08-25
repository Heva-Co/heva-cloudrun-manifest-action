/**
 * Every fixture under tests/fixtures/negative/ must be rejected.
 *
 * self-test.yml runs the same set through the real action; this file is the fast
 * feedback loop. Both exist because a validate.ts that silently stopped throwing
 * would keep every positive test green.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { build, getterFrom } from '../src/build.js'

const DIR = join(import.meta.dirname, 'fixtures', 'negative')

/** The substring each case's error must contain, so a wrong-reason pass fails. */
const EXPECTED: Record<string, RegExp> = {
  'unresolved-placeholder': /unresolved placeholder \$IMAGE/,
  'empty-secret-id': /DB_PASS.*empty secret id/,
  'empty-image': /image is empty/,
  'service-input-on-job': /"(ingress|min-instances)" does not apply to kind: job/,
  'job-input-on-service': /"max-retries" does not apply to kind: service/,
  'env-suffix-mismatch': /does not end in "-prd"/,
  'cross-env-secret': /DB_PASS points at "core-api-db-pass-prd"/,
  'duplicate-across-blocks': /DB_PASS is declared in both/,
  'duplicate-in-block': /APP_ENV is declared twice/,
  'bad-probe-field': /unknown probe field "initialDelay"/,
  'traffic-missing': /traffic is required for kind: service/,
  'traffic-hold-empty': /"hold=" has no revision/,
  // `none` is the intuitive thing to reach for, so the error has to explain why
  // it cannot exist rather than just rejecting it.
  'traffic-bad-value': /expected "latest" or "hold=<revision>"/,
}

function getterFor(file: string) {
  const doc = (parseYaml(readFileSync(join(DIR, file), 'utf8')) ?? {}) as Record<string, unknown>
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(doc)) values[k] = String(v)
  return getterFrom(values)
}

const cases = readdirSync(DIR)
  .filter((f) => f.endsWith('.inputs.yml'))
  .sort()

describe('negative fixtures', () => {
  it('every negative fixture has a declared expected message', () => {
    for (const f of cases) {
      expect(EXPECTED[f.replace('.inputs.yml', '')], `no expectation declared for ${f}`).toBeDefined()
    }
    expect(cases.length).toBe(Object.keys(EXPECTED).length)
  })

  it.each(cases)('%s is rejected, for the right reason', (file) => {
    const pattern = EXPECTED[file.replace('.inputs.yml', '')]!
    expect(() => build(getterFor(file))).toThrow(pattern)
  })
})
