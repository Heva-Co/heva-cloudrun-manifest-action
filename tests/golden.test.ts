/**
 * Every fixture renders to its committed expected manifest.
 *
 * Comparison is on PARSED and NORMALISED YAML, never bytes: normalising the
 * fleet's style drift (key order, quoting, list indentation) is the whole point
 * of this action, so a byte diff against hand-written manifests would fail by
 * design.
 *
 * These goldens are a regression guard. The correctness check against a
 * hand-authored `envsubst` manifest lives in parity.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { build } from '../src/build.js'
import { emit } from '../src/emit.js'
import { normalizeObject, normalizeYaml } from '../src/normalize.js'
import { fixtureCases, fixtureGetter, readFixture } from './helpers.js'

const cases = fixtureCases()

describe('golden fixtures', () => {
  it('has the ten cases the plan calls for', () => {
    expect(cases.length).toBe(10)
  })

  it.each(cases)('%s renders to its expected manifest', (name) => {
    const { manifest } = build(fixtureGetter(name))
    expect(normalizeObject(manifest)).toEqual(normalizeYaml(readFixture(name, 'expected.yml')))
  })

  it.each(cases)('%s emits valid, re-parseable YAML', (name) => {
    const { manifest } = build(fixtureGetter(name))
    const text = emit(manifest)
    // Round-tripping proves the emitted text is well-formed YAML and that the
    // quoting pass did not corrupt any value.
    expect(normalizeYaml(text)).toEqual(normalizeObject(manifest))
  })

  it.each(cases)('%s never leaves an env value unquoted', (name) => {
    const { manifest } = build(fixtureGetter(name))
    for (const line of emit(manifest).split('\n')) {
      const m = /^\s*value:\s*(.*)$/.exec(line)
      if (!m) continue
      // Cloud Run rejects a bare bool or int here.
      expect(m[1], `unquoted env value in ${name}: ${line}`).toMatch(/^["']/)
    }
  })
})

describe('fixture coverage of the shapes a real deployment hits', () => {
  const byName = new Map(cases.map((c) => [c, build(fixtureGetter(c)).manifest as any]))

  it('covers both kinds', () => {
    const kinds = new Set([...byName.values()].map((m) => m.kind))
    expect(kinds).toEqual(new Set(['Service', 'Job']))
  })

  it('covers a service with all three probes', () => {
    const c = byName.get('admin-api').spec.template.spec.containers[0]
    expect(c.startupProbe).toBeDefined()
    expect(c.livenessProbe).toBeDefined()
    expect(c.readinessProbe).toBeDefined()
  })

  it('covers the 40-minute startup budget', () => {
    const p = byName.get('core-api').spec.template.spec.containers[0].startupProbe
    expect(p.failureThreshold * p.periodSeconds).toBe(2400)
  })

  it('covers a single-env-var service (Parameter Manager)', () => {
    expect(byName.get('admin-api').spec.template.spec.containers[0].env).toHaveLength(1)
  })

  it('covers an all-secretKeyRef service', () => {
    const env = byName.get('internal-portal').spec.template.spec.containers[0].env
    const refs = env.filter((e: any) => e.valueFrom)
    expect(refs.length).toBe(6)
  })

  it('covers custom-audiences', () => {
    expect(byName.get('inference-api').metadata.annotations['run.googleapis.com/custom-audiences']).toBeDefined()
  })

  it('covers cpu-throttling: false', () => {
    expect(
      byName.get('notifier').spec.template.metadata.annotations['run.googleapis.com/cpu-throttling'],
    ).toBe('false')
  })

  it('covers a service with no VPC and no Cloud SQL', () => {
    const ann = byName.get('marketing-site').spec.template.metadata?.annotations ?? {}
    expect(ann['run.googleapis.com/network-interfaces']).toBeUndefined()
    expect(ann['run.googleapis.com/cloudsql-instances']).toBeUndefined()
  })

  it('covers a job with maxRetries 0 and one with 1', () => {
    expect(byName.get('core-api-job-migrate').spec.template.spec.template.spec.maxRetries).toBe(0)
    expect(byName.get('core-api-job-sweep').spec.template.spec.template.spec.maxRetries).toBe(1)
  })

  it('covers multi-region by varying only the region input', () => {
    const east = build((n) => (n === 'region' ? 'us-east1' : fixtureGetter('core-api')(n)))
    expect((east.manifest as any).metadata.labels['cloud.googleapis.com/location']).toBe('us-east1')
  })
})
