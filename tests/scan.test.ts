/**
 * The two signals, tested separately so it is clear which one catches what.
 *
 * Signal (a) name heuristic runs in-process and always executes.
 * Signal (b) detect-secrets is skipped WITH A VISIBLE WARNING when the binary is
 * absent, rather than silently passing — a quiet skip here would be a false
 * green on the one check that exists to prevent leaked credentials.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build } from '../src/build.js'
import { emit } from '../src/emit.js'
import { buildSpec } from '../src/build.js'
import { detectSecretsAvailable, effectiveMode, mergeFindings, scanEntropy, scanNames } from '../src/scan.js'
import { inputs } from './helpers.js'

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'scan_manifest.py')

function spec(envPlain: string, envSecrets = '') {
  return buildSpec(
    inputs({
      kind: 'service',
      name: 'core-api-prd',
      region: 'us-central1',
      image: 'img',
      'service-account': 'sa@example-prd.iam.gserviceaccount.com',
      environment: 'prd',
      traffic: 'latest',
      'env-plain': envPlain,
      'env-secrets': envSecrets,
    }),
  )
}

describe('signal (a): name heuristic', () => {
  const cases = [
    ['JWT_SECRET_KEY', true],
    ['PAYMENTS_SECRET_KEY', true],
    ['SMS_AUTH_TOKEN', true],
    ['DB_PASSWORD', true],
    ['DB_PASS', true],
    ['GOOGLE_API_KEY', true],
    ['FIREBASE_CREDENTIALS_JSON', false],
    ['APP_ENV', false],
    ['REDIS_HOST', false],
    ['MIN_SCALE', false],
  ] as const

  it.each(cases)('%s -> flagged: %s', (name, flagged) => {
    const hits = scanNames(spec(`${name}=some-value-here`), new Set())
    expect(hits.length > 0).toBe(flagged)
  })

  it('exempts NEXT_PUBLIC_*, which is compiled into the browser bundle by design', () => {
    // A publishable Stripe key is not a secret. Flagging it would train people
    // to ignore this check.
    const hits = scanNames(spec('NEXT_PUBLIC_PAYMENTS_PUBLISHABLE_KEY=publishable-FAKE'), new Set())
    expect(hits).toEqual([])
  })

  it('catches a LOW-entropy secret, which the entropy detector cannot', () => {
    // This is why signal (a) exists alongside (b).
    const hits = scanNames(spec('JWT_SECRET_KEY=hunter2'), new Set())
    expect(hits.map((h) => h.name)).toEqual(['JWT_SECRET_KEY'])
    expect(hits[0]!.source).toBe('name')
  })

  it('ignores an empty value: an unset flag is not a leaked secret', () => {
    expect(scanNames(spec('JWT_SECRET_KEY='), new Set())).toEqual([])
  })

  it('never flags a secretKeyRef, which is the pattern we want people to use', () => {
    expect(scanNames(spec('APP_ENV=prd', 'JWT_SECRET_KEY=core-api-jwt-secret-key-prd'), new Set())).toEqual([])
  })

  it('honours the allow list', () => {
    expect(scanNames(spec('JWT_SECRET_KEY=abc123'), new Set(['JWT_SECRET_KEY']))).toEqual([])
  })
})

describe('effectiveMode', () => {
  it('auto errors on prd and warns elsewhere', () => {
    expect(effectiveMode('auto', 'prd')).toBe('error')
    expect(effectiveMode('auto', 'stg')).toBe('warn')
    expect(effectiveMode('auto', 'dev')).toBe('warn')
  })
  it('explicit modes are respected', () => {
    expect(effectiveMode('warn', 'prd')).toBe('warn')
    expect(effectiveMode('error', 'dev')).toBe('error')
    expect(effectiveMode('off', 'prd')).toBe('off')
  })
})

describe('mergeFindings', () => {
  it('keeps both signals for the same var, since they are different evidence', () => {
    const merged = mergeFindings(
      [{ name: 'K', detector: 'name-heuristic', source: 'name' }],
      [{ name: 'K', detector: 'Base64 High Entropy String', source: 'entropy' }],
    )
    expect(merged).toHaveLength(2)
  })
  it('de-duplicates within a signal', () => {
    const f = { name: 'K', detector: 'd', source: 'name' } as const
    expect(mergeFindings([f], [f])).toHaveLength(1)
  })
  it('sorts by name for a stable summary', () => {
    const merged = mergeFindings(
      [{ name: 'Z', detector: 'd', source: 'name' }, { name: 'A', detector: 'd', source: 'name' }],
      [],
    )
    expect(merged.map((f) => f.name)).toEqual(['A', 'Z'])
  })
})

const HAS_DS = detectSecretsAvailable()

/**
 * CI sets this so a missing binary is a FAILURE rather than a skip.
 *
 * A silently skipped scan suite is a false green on the one check that exists to
 * keep credentials out of manifests, so the two environments get different
 * treatment on purpose: skip on a laptop, hard-fail in CI.
 */
const REQUIRED = process.env.HEVA_REQUIRE_DETECT_SECRETS === '1'

describe('detect-secrets availability', () => {
  it('is installed when the environment demands it', () => {
    if (!REQUIRED) return
    expect(
      HAS_DS,
      'HEVA_REQUIRE_DETECT_SECRETS=1 but detect-secrets is not on PATH — the entropy tests would have skipped',
    ).toBe(true)
  })
})

if (!HAS_DS && !REQUIRED) {
  console.warn(
    '\n  ⚠ detect-secrets is not installed: the entropy-scan tests are SKIPPED.\n' +
      '    Install it with `pip install detect-secrets` to run them locally.\n' +
      '    CI sets HEVA_REQUIRE_DETECT_SECRETS=1, so these are enforced there.\n',
  )
}

describe.skipIf(!HAS_DS)('signal (b): detect-secrets over the rendered manifest', () => {
  function render(envPlain: string, envSecrets = ''): string {
    const g = inputs({
      kind: 'service',
      name: 'core-api-prd',
      region: 'us-central1',
      image: 'img',
      'service-account': 'sa@example-prd.iam.gserviceaccount.com',
      environment: 'prd',
      traffic: 'latest',
      'env-plain': envPlain,
      'env-secrets': envSecrets,
    })
    const dir = mkdtempSync(join(tmpdir(), 'heva-scan-'))
    const path = join(dir, 'manifest.yaml')
    writeFileSync(path, emit(build(g).manifest), 'utf8')
    return path
  }

  // Generated, not committed, so this file never carries a real-looking secret.
  const HIGH_ENTROPY = execFileSync('python3', [
    '-c',
    'import base64,os;print(base64.b64encode(os.urandom(33)).decode(),end="")',
  ], { encoding: 'utf8' })

  it('flags a high-entropy value behind an innocuous name', () => {
    // Signal (a) would miss BRANDING_BLOB entirely: this is why (b) exists.
    const path = render(`BRANDING_BLOB=${HIGH_ENTROPY}`)
    const res = scanEntropy(path, SCRIPT, undefined, new Set())
    expect(res.available).toBe(true)
    expect(res.note).toBeUndefined()
    expect(res.findings.map((f) => f.name)).toContain('BRANDING_BLOB')
  })

  it('maps the finding back to the right env var name', () => {
    const path = render(`APP_ENV=prd\nZZZ_LAST=plain\nMIDDLE_BLOB=${HIGH_ENTROPY}`)
    const res = scanEntropy(path, SCRIPT, undefined, new Set())
    expect(res.findings.map((f) => f.name)).toEqual(['MIDDLE_BLOB'])
  })

  it('does not flag a secretKeyRef', () => {
    const path = render('APP_ENV=prd', 'DB_PASS=core-api-db-pass-prd')
    expect(scanEntropy(path, SCRIPT, undefined, new Set()).findings).toEqual([])
  })

  it('finds nothing in a clean manifest', () => {
    const path = render('APP_ENV=prd\nREDIS_PORT=6379')
    expect(scanEntropy(path, SCRIPT, undefined, new Set()).findings).toEqual([])
  })

  it('honours the allow list', () => {
    const path = render(`BRANDING_BLOB=${HIGH_ENTROPY}`)
    expect(scanEntropy(path, SCRIPT, undefined, new Set(['BRANDING_BLOB'])).findings).toEqual([])
  })

  it('suppresses a finding already audited into a baseline', () => {
    const path = render(`BRANDING_BLOB=${HIGH_ENTROPY}`)
    const found = scanEntropy(path, SCRIPT, undefined, new Set())
    expect(found.findings.length).toBe(1)

    // Build a baseline containing exactly that hashed secret. detect-secrets
    // reports hashes, never plaintext, so this is what a real baseline holds.
    const dir = mkdtempSync(join(tmpdir(), 'heva-baseline-'))
    const baseline = join(dir, '.secrets.baseline')
    const raw = execFileSync('detect-secrets', ['scan', '--all-files', 'manifest.yaml'], {
      cwd: join(path, '..'),
      encoding: 'utf8',
    })
    writeFileSync(baseline, raw, 'utf8')

    expect(scanEntropy(path, SCRIPT, baseline, new Set()).findings).toEqual([])
  })

  it('reports a note instead of throwing when the script is missing', () => {
    const res = scanEntropy(render('A=b'), '/nonexistent/scan.py', undefined, new Set())
    expect(res.findings).toEqual([])
    expect(res.note).toBeTruthy()
  })
})
