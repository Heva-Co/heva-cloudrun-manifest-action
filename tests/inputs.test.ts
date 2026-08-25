import { describe, expect, it } from 'vitest'
import {
  InputError,
  parseKeyValueBlock,
  parseTraffic,
  parseListBlock,
  parseMapBlock,
  parseProbe,
  parseSecretBlock,
} from '../src/inputs.js'

describe('parseKeyValueBlock', () => {
  it('parses plain pairs and trims', () => {
    expect(parseKeyValueBlock('  A=1 \n B=2 ', 'env-plain')).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
    ])
  })

  it('drops blank lines and # comments so long env blocks can be grouped', () => {
    const block = ['# ── Messaging ──', '', 'SMS_ACCOUNT_SID=AC123', '', '# ── Storage ──', 'S3_BUCKET=b'].join('\n')
    expect(parseKeyValueBlock(block, 'env-plain')).toEqual([
      { key: 'SMS_ACCOUNT_SID', value: 'AC123' },
      { key: 'S3_BUCKET', value: 'b' },
    ])
  })

  it('splits on the FIRST = only, so values keep theirs', () => {
    // ALLOWED_ORIGINS and base64 padding both contain '='. Splitting on every
    // '=' would silently truncate them.
    expect(parseKeyValueBlock('ALLOWED_ORIGINS=https://a.co?x=1&y=2', 'env-plain')).toEqual([
      { key: 'ALLOWED_ORIGINS', value: 'https://a.co?x=1&y=2' },
    ])
  })

  it('accepts an empty value', () => {
    expect(parseKeyValueBlock('EMPTY=', 'env-plain')).toEqual([{ key: 'EMPTY', value: '' }])
  })

  it('returns [] for undefined and for whitespace', () => {
    expect(parseKeyValueBlock(undefined, 'x')).toEqual([])
    expect(parseKeyValueBlock('\n  \n', 'x')).toEqual([])
  })

  it('names the offending line when = is missing', () => {
    expect(() => parseKeyValueBlock('JUST_A_NAME', 'env-plain')).toThrow(/env-plain.*"JUST_A_NAME"/)
    expect(() => parseKeyValueBlock('JUST_A_NAME', 'env-plain')).toThrow(InputError)
  })

  it('rejects an empty key', () => {
    expect(() => parseKeyValueBlock('=orphan', 'env-plain')).toThrow(/empty key/)
  })
})

describe('parseSecretBlock', () => {
  it('defaults the version to latest, which is what the whole fleet uses', () => {
    expect(parseSecretBlock('JWT_SECRET_KEY=core-api-jwt-secret-key-prd', 'env-secrets')).toEqual([
      { key: 'JWT_SECRET_KEY', secret: 'core-api-jwt-secret-key-prd', version: 'latest' },
    ])
  })

  it('accepts an explicit version', () => {
    expect(parseSecretBlock('DB_PASS=core-api-db-pass-prd:7', 'env-secrets')).toEqual([
      { key: 'DB_PASS', secret: 'core-api-db-pass-prd', version: '7' },
    ])
  })

  it('rejects an empty secret id and says why the deploy would fail', () => {
    // This is the NEXT-ACTIONS.txt item 7 check: an unset workflow variable
    // renders an empty secretKeyRef.name.
    expect(() => parseSecretBlock('DB_PASS=', 'env-secrets')).toThrow(/DB_PASS.*empty secret id/)
    expect(() => parseSecretBlock('DB_PASS=', 'env-secrets')).toThrow(/secretKeyRef\.name/)
  })

  it('rejects an empty version', () => {
    expect(() => parseSecretBlock('DB_PASS=some-secret:', 'env-secrets')).toThrow(/empty secret version/)
  })
})

describe('parseMapBlock', () => {
  it('builds an object', () => {
    expect(parseMapBlock('team=platform\ntier=backend', 'labels')).toEqual({
      team: 'platform',
      tier: 'backend',
    })
  })

  it('keeps a JSON annotation value intact', () => {
    const block = 'run.googleapis.com/custom-audiences=["https://api.example.com/ia/*"]'
    expect(parseMapBlock(block, 'annotations')).toEqual({
      'run.googleapis.com/custom-audiences': '["https://api.example.com/ia/*"]',
    })
  })

  it('rejects a duplicate key', () => {
    expect(() => parseMapBlock('a=1\na=2', 'labels')).toThrow(/duplicate key a/)
  })
})

describe('parseListBlock', () => {
  it('yields one item per line, preserving order', () => {
    // argv order is load-bearing: `jobs cold-lead-sweep` is not the same as the
    // reverse, so this must never be sorted.
    expect(parseListBlock('jobs\ncold-lead-sweep')).toEqual(['jobs', 'cold-lead-sweep'])
  })
})

describe('parseProbe', () => {
  it('parses the full core-api startup probe', () => {
    const spec = 'path=/health/liveness,port=8000,initial-delay=10,timeout=10,period=10,failure-threshold=240'
    expect(parseProbe(spec, 'startup-probe')).toEqual({
      path: '/health/liveness',
      port: 8000,
      initialDelaySeconds: 10,
      timeoutSeconds: 10,
      periodSeconds: 10,
      failureThreshold: 240,
    })
  })

  it('allows path only, matching web-app which omits port', () => {
    expect(parseProbe('path=/', 'startup-probe')).toEqual({ path: '/' })
  })

  it('returns undefined for empty input', () => {
    expect(parseProbe(undefined, 'p')).toBeUndefined()
    expect(parseProbe('   ', 'p')).toBeUndefined()
  })

  it('requires path', () => {
    expect(() => parseProbe('period=10', 'startup-probe')).toThrow(/missing required probe field "path"/)
  })

  it('lists the valid fields when one is misspelled', () => {
    expect(() => parseProbe('path=/,initialDelay=5', 'startup-probe')).toThrow(/unknown probe field "initialDelay"/)
    expect(() => parseProbe('path=/,initialDelay=5', 'startup-probe')).toThrow(/initial-delay/)
  })

  it('rejects a non-integer numeric field', () => {
    expect(() => parseProbe('path=/,period=abc', 'startup-probe')).toThrow(/period must be a non-negative integer/)
  })
})

describe('parseTraffic', () => {
  it('accepts latest', () => {
    expect(parseTraffic('latest', 'traffic')).toEqual({ mode: 'latest' })
  })

  it('accepts hold=<revision>', () => {
    expect(parseTraffic('hold=core-api-prd-00042-abc', 'traffic')).toEqual({
      mode: 'hold',
      revision: 'core-api-prd-00042-abc',
    })
  })

  it('is required, and the error explains why there is no default', () => {
    // An omitted traffic block means latestRevision 100% to the API, so a
    // defaulted input would let a forgotten line take production traffic.
    expect(() => parseTraffic('', 'traffic')).toThrow(/traffic is required for kind: service/)
    expect(() => parseTraffic(undefined, 'traffic')).toThrow(/silently take[\s\S]*production traffic/)
  })

  it('rejects hold= with no revision, and says what to do instead', () => {
    // This is what an unset ${{ steps.serving.outputs.revision }} renders as.
    expect(() => parseTraffic('hold=', 'traffic')).toThrow(/"hold=" has no revision/)
    expect(() => parseTraffic('hold=   ', 'traffic')).toThrow(/deploy with "latest" first/)
  })

  it('rejects "none", explaining that it cannot exist', () => {
    // The intuitive thing to reach for. A no-traffic deploy has to name the
    // revision that keeps serving, so a bare keyword cannot express it.
    expect(() => parseTraffic('none', 'traffic')).toThrow(/expected "latest" or "hold=<revision>"/)
  })

  it('points at overlay for percentage splits, which are not modelled yet', () => {
    expect(() => parseTraffic('latest=10,old=90', 'traffic')).toThrow(/overlay/)
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseTraffic('  hold=rev-1  ', 'traffic')).toEqual({ mode: 'hold', revision: 'rev-1' })
  })
})
