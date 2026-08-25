import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { emit } from '../src/emit.js'

describe('emit quoting', () => {
  // Cloud Run rejects a bool or int in env[].value. This is the contract the
  // whole action exists to enforce, so it is asserted on the raw text.
  it('quotes every env value, including booleans and numbers', () => {
    const text = emit({
      env: [
        { name: 'ENABLE_SMS_CHANNEL', value: true },
        { name: 'SMS_OUTBOUND_DAILY_CAP', value: 0 },
        { name: 'APP_ENV', value: 'prd' },
      ],
    })
    expect(text).toContain('value: "true"')
    expect(text).toContain('value: "0"')
    expect(text).toContain('value: "prd"')
    expect(text).not.toMatch(/value: true\s*$/m)
    expect(text).not.toMatch(/value: 0\s*$/m)
  })

  it('quotes annotation values, which are string->string in the k8s API', () => {
    const text = emit({
      metadata: {
        annotations: {
          'run.googleapis.com/invoker-iam-disabled': true,
          'autoscaling.knative.dev/minScale': 1,
        },
      },
    })
    expect(text).toContain('run.googleapis.com/invoker-iam-disabled: "true"')
    expect(text).toContain('autoscaling.knative.dev/minScale: "1"')
  })

  it('quotes label values too', () => {
    const text = emit({ metadata: { labels: { 'cloud.googleapis.com/location': 'us-central1' } } })
    expect(text).toContain('cloud.googleapis.com/location: "us-central1"')
  })

  it('leaves non-env scalars typed, so validate.ts can range-check them', () => {
    const text = emit({ spec: { containerConcurrency: 80, timeoutSeconds: 900 } })
    expect(text).toContain('containerConcurrency: 80')
    expect(text).toContain('timeoutSeconds: 900')
  })

  it('single-quotes a JSON annotation so its inner quotes are not escaped', () => {
    // Double-quoting would render every inner quote as \\" — valid YAML, but
    // unreadable in a review diff and unlike every existing manifest.
    const long =
      '[{"network":"projects/example-shared/global/networks/shared-vpc","subnetwork":"projects/example-shared/regions/us-central1/subnetworks/dev"}]'
    const text = emit({ metadata: { annotations: { 'run.googleapis.com/network-interfaces': long } } })
    const line = text.split('\n').find((l) => l.includes('network-interfaces'))
    // Verbatim on one line, single-quoted, no backslash escapes.
    expect(line).toBe(`    run.googleapis.com/network-interfaces: '${long}'`)
    expect(line).not.toContain('\\\\')
  })

  it('falls back to double quotes when the value contains a single quote', () => {
    const text = emit({ env: [{ name: 'MSG', value: "it's fine" }] })
    expect(text).toContain('value: "it\'s fine"')
  })

  it('round-trips: the emitted text parses back to the same values as strings', () => {
    const text = emit({ env: [{ name: 'A', value: true }] })
    expect(parse(text)).toEqual({ env: [{ name: 'A', value: 'true' }] })
  })
})
