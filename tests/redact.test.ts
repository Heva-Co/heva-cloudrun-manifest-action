/**
 * Security tests, not formatting tests.
 *
 * Printing a rendered manifest is the normal way people debug a deploy, and any
 * value interpolated as a plain `env[].value` is right there in the output. These
 * assertions are what keep the redaction from silently regressing.
 */
import { describe, expect, it } from 'vitest'
import { build } from '../src/build.js'
import { emit } from '../src/emit.js'
import { leaks, redactManifest } from '../src/redact.js'
import { findingsTable, summaryMarkdown } from '../src/summary.js'
import { inputs } from './helpers.js'

// A GENERATED FAKE. Not a real credential, and never was — it exists only so
// the assertions below have a distinctive string to trace through redaction.
//
// Also deliberately NOT shaped like a real key: a `sk_live_`-style prefix in a
// public repo trips GitHub's secret scanning and its provider integrations,
// which generates alerts for a value that can never be valid.
const SECRET = 'FAKE-TEST-VALUE-DO-NOT-USE-0000000000'

const get = inputs({
  kind: 'service',
  name: 'core-api-prd',
  region: 'us-central1',
  image: 'img:sha',
  'service-account': 'sa@example-prd.iam.gserviceaccount.com',
  environment: 'prd',
  traffic: 'latest',
  'env-plain': `APP_ENV=prd\nPAYMENTS_SECRET_KEY=${SECRET}`,
})

describe('redactManifest', () => {
  it('removes every inline value', () => {
    const text = emit(build(get).manifest)
    expect(text).toContain(SECRET) // present in the file we write to disk
    const redacted = redactManifest(text)
    expect(leaks(redacted, [SECRET])).toEqual([])
    expect(redacted).toContain('value: "<redacted>"')
  })

  it('keeps the structure readable, which is the point of printing it', () => {
    const redacted = redactManifest(emit(build(get).manifest))
    expect(redacted).toContain('apiVersion: serving.knative.dev/v1')
    expect(redacted).toContain('name: PAYMENTS_SECRET_KEY')
    expect(redacted).toContain('serviceAccountName: sa@example-prd.iam.gserviceaccount.com')
  })

  it('leaves secretKeyRef names visible: they are references, not secrets', () => {
    const g = inputs({
      kind: 'service',
      name: 'core-api-prd',
      region: 'us-central1',
      image: 'i',
      'service-account': 'sa@p.iam.gserviceaccount.com',
      environment: 'prd',
      traffic: 'latest',
      'env-secrets': 'DB_PASS=core-api-db-pass-prd',
    })
    const redacted = redactManifest(emit(build(g).manifest))
    expect(redacted).toContain('core-api-db-pass-prd')
  })

  it('redacts a multi-value manifest completely, not just the first', () => {
    const g = inputs({
      kind: 'service',
      name: 'x-dev',
      region: 'us-central1',
      image: 'i',
      'service-account': 'sa@p.iam.gserviceaccount.com',
      environment: 'dev',
      traffic: 'latest',
      'env-plain': 'A=secret-one-aaaaaaaa\nB=secret-two-bbbbbbbb\nC=secret-three-cccccc',
    })
    const redacted = redactManifest(emit(build(g).manifest))
    expect(leaks(redacted, ['secret-one-aaaaaaaa', 'secret-two-bbbbbbbb', 'secret-three-cccccc'])).toEqual([])
  })
})

describe('the summary never carries a value', () => {
  it('findingsTable prints names and detectors only', () => {
    const table = findingsTable([{ name: 'PAYMENTS_SECRET_KEY', detector: 'Base64 High Entropy String', source: 'entropy' }])
    expect(table).toContain('PAYMENTS_SECRET_KEY')
    expect(table).toContain('Base64 High Entropy String')
    expect(leaks(table, [SECRET])).toEqual([])
  })

  it('summaryMarkdown carries no value even when findings exist', () => {
    const md = summaryMarkdown({
      kind: 'service',
      name: 'core-api-prd',
      region: 'us-central1',
      environment: 'prd',
      manifestPath: '/tmp/x.yaml',
      findings: [{ name: 'PAYMENTS_SECRET_KEY', detector: 'name-heuristic', source: 'name' }],
      mode: 'error',
    })
    expect(leaks(md, [SECRET])).toEqual([])
    expect(md).toContain('PAYMENTS_SECRET_KEY')
  })

  it('says so plainly when there is nothing to report', () => {
    expect(findingsTable([])).toContain('No plaintext secrets detected')
  })
})

describe('leaks helper', () => {
  it('ignores short strings, which would match by coincidence', () => {
    expect(leaks('the value is abc', ['abc'])).toEqual([])
  })
  it('reports a genuine leak', () => {
    expect(leaks('x LEAKED-VALUE-abcdefghij y', ['LEAKED-VALUE-abcdefghij'])).toEqual([
      'LEAKED-VALUE-abcdefghij',
    ])
  })
})
