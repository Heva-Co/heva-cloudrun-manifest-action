import { describe, expect, it } from 'vitest'
import { canonicalString, normalizeYaml } from '../src/normalize.js'

describe('normalize', () => {
  it('makes key order irrelevant', () => {
    // notifier writes `key:` before `name:` inside
    // secretKeyRef; every other repo does the reverse. Same manifest.
    const a = 'secretKeyRef:\n  name: s\n  key: latest\n'
    const b = 'secretKeyRef:\n  key: latest\n  name: s\n'
    expect(normalizeYaml(a)).toEqual(normalizeYaml(b))
  })

  it('makes env order irrelevant, since env is a set', () => {
    const a = 'env:\n  - name: B\n    value: "2"\n  - name: A\n    value: "1"\n'
    const b = 'env:\n  - name: A\n    value: "1"\n  - name: B\n    value: "2"\n'
    expect(normalizeYaml(a)).toEqual(normalizeYaml(b))
  })

  it('keeps args order significant, because argv is ordered', () => {
    const a = 'args:\n  - jobs\n  - cold-lead-sweep\n'
    const b = 'args:\n  - cold-lead-sweep\n  - jobs\n'
    expect(normalizeYaml(a)).not.toEqual(normalizeYaml(b))
  })

  it('keeps containers order significant', () => {
    const a = 'containers:\n  - name: a\n  - name: b\n'
    const b = 'containers:\n  - name: b\n  - name: a\n'
    expect(normalizeYaml(a)).not.toEqual(normalizeYaml(b))
  })

  it('treats quoted and bare scalars as equal', () => {
    // timeoutSeconds: 900 vs '3600' — the fleet writes both, Cloud Run takes both.
    expect(normalizeYaml('timeoutSeconds: 900\n')).toEqual(normalizeYaml("timeoutSeconds: '900'\n"))
    expect(normalizeYaml('x: true\n')).toEqual(normalizeYaml('x: "true"\n'))
  })

  it('does not conflate different values', () => {
    expect(normalizeYaml('a: 1\n')).not.toEqual(normalizeYaml('a: 2\n'))
  })

  it('canonicalString is stable and diffable', () => {
    expect(canonicalString('b: 2\na: 1\n')).toBe(canonicalString('a: 1\nb: 2\n'))
    expect(canonicalString('a: 1\n')).toContain('"a": "1"')
  })
})
