/**
 * One test per invariant, each asserting the MESSAGE and not just that it threw.
 * An error that fails to name the offending variable is the problem we already
 * have with envsubst; a test that only checks `.toThrow()` would let that back in.
 */
import { describe, expect, it } from 'vitest'
import { render } from '../src/render/index.js'
import { jobSpec, serviceSpec } from '../src/schema.js'
import type { ValidationError } from '../src/validate.js'
import { validate } from '../src/validate.js'

const base = {
  kind: 'service' as const,
  name: 'core-api-prd',
  region: 'us-central1',
  image: 'us-central1-docker.pkg.dev/example-prd/r/i:sha',
  serviceAccount: 'core-api@example-prd.iam.gserviceaccount.com',
  environment: 'prd' as const,
  traffic: { mode: 'latest' as const },
}

function checkService(over: Record<string, unknown> = {}, supplied: string[] = [], allow: string[] = []) {
  const spec = serviceSpec.parse({ ...base, ...over })
  validate(spec, render(spec), new Set(supplied), new Set(allow))
}
function checkJob(over: Record<string, unknown> = {}, supplied: string[] = []) {
  const spec = jobSpec.parse({ ...base, kind: 'job', name: 'core-api-migrate-prd', ...over })
  validate(spec, render(spec), new Set(supplied))
}

describe('the happy path', () => {
  it('accepts a well-formed service', () => {
    expect(() => checkService({ port: 8000, minInstances: 1, ingress: 'all' })).not.toThrow()
  })
  it('accepts a well-formed job', () => {
    expect(() => checkJob({ command: ['./app'], args: ['migrate'], maxRetries: 0 })).not.toThrow()
  })
})

describe('(1) unresolved placeholders', () => {
  it('rejects a literal $VAR pasted into a structural field', () => {
    expect(() => checkService({ image: '$IMAGE' })).toThrow(/unresolved placeholder \$IMAGE/)
  })

  it('rejects ${VAR} brace form too, as internal-portal uses it', () => {
    expect(() => checkService({ cloudsqlInstances: ['${DB_INSTANCE_CONNECTION_NAME}'] })).toThrow(
      /unresolved placeholder \$\{DB_INSTANCE_CONNECTION_NAME\}/,
    )
  })

  it('rejects an env value that is nothing but a placeholder', () => {
    expect(() => checkService({ envPlain: [{ key: 'JWT_SECRET_KEY', value: '$JWT_SECRET_KEY' }] })).toThrow(
      /unresolved placeholder \$JWT_SECRET_KEY/,
    )
  })

  it('names the path so the offending field is findable', () => {
    try {
      checkService({ envPlain: [{ key: 'A', value: '$A' }] })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as ValidationError).problems[0]).toMatch(/env\[0\]\.value/)
    }
  })

  it('does NOT reject a real credential that merely contains a $', () => {
    // A false positive here blocks a correct deploy, which is worse than a miss.
    expect(() =>
      checkService({ envPlain: [{ key: 'PASSWORD', value: 'aB$XYZ9!k-pw' }, { key: 'H', value: '$2b$10$abcdef' }] }),
    ).not.toThrow()
  })

  it('does not flag lowercase $path, which is far more likely to be data', () => {
    expect(() => checkService({ envPlain: [{ key: 'TPL', value: 'hello $name' }] })).not.toThrow()
  })
})

describe('(2) load-bearing fields', () => {
  it('rejects an empty image', () => {
    expect(() => checkService({ image: '   ' })).toThrow(/image is empty/)
  })
  it('rejects an empty service account', () => {
    expect(() => checkService({ serviceAccount: '' })).toThrow(/service-account is empty/)
  })
})

describe('no environment set', () => {
  it('accepts a service with no environment and no env suffix in name', () => {
    const spec = serviceSpec.parse({
      ...base,
      name: 'heva-intranet',
      environment: undefined,
    })
    expect(() => validate(spec, render(spec))).not.toThrow()
  })

  it('accepts an empty-string environment (raw action input default)', () => {
    const spec = serviceSpec.parse({
      ...base,
      name: 'heva-intranet',
      environment: '',
    })
    expect(() => validate(spec, render(spec))).not.toThrow()
  })
})

describe('(3) environment coherence', () => {
  it('rejects a name whose suffix disagrees with the environment', () => {
    expect(() => checkService({ name: 'core-api-stg' })).toThrow(
      /name "core-api-stg" does not end in "-prd"/,
    )
  })

  it('rejects a stg deploy pointing at a prd secret', () => {
    const spec = serviceSpec.parse({
      ...base,
      name: 'core-api-stg',
      environment: 'stg',
      envSecrets: [{ key: 'DB_PASS', secret: 'core-api-db-pass-prd', version: 'latest' }],
    })
    expect(() => validate(spec, render(spec))).toThrow(/DB_PASS points at "core-api-db-pass-prd".*belongs to "prd"/s)
  })

  it('accepts a shared secret with no env suffix', () => {
    // mailer-api-key and metrics-api-key are shared and carry no suffix.
    expect(() => checkService({ envSecrets: [{ key: 'MAILER_API_KEY', secret: 'mailer-api-key', version: 'latest' }] })).not.toThrow()
  })

  it('honours the allow list for a deliberate cross-env reference', () => {
    const spec = serviceSpec.parse({
      ...base,
      name: 'core-api-stg',
      environment: 'stg',
      envSecrets: [{ key: 'DB_PASS', secret: 'core-api-db-pass-prd', version: 'latest' }],
    })
    expect(() => validate(spec, render(spec), new Set(), new Set(['DB_PASS']))).not.toThrow()
  })
})

describe('(4) cross-kind inputs', () => {
  it('rejects a Service-only input on a Job', () => {
    expect(() => checkJob({}, ['ingress'])).toThrow(/"ingress" does not apply to kind: job/)
  })
  it('explains that Cloud Run would ignore it silently', () => {
    expect(() => checkJob({}, ['min-instances'])).toThrow(/ignores it silently/)
  })
  it('rejects a Job-only input on a Service', () => {
    expect(() => checkService({}, ['max-retries'])).toThrow(/"max-retries" does not apply to kind: service/)
  })
  it('allows a shared input on either kind', () => {
    expect(() => checkJob({}, ['cpu', 'memory', 'timeout'])).not.toThrow()
  })
})

describe('(5) duplicate env keys', () => {
  it('rejects the same key twice in env-plain', () => {
    expect(() => checkService({ envPlain: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] })).toThrow(
      /env var A is declared twice in env-plain/,
    )
  })

  it('rejects a key present in both blocks, which is the plain-vs-secret mistake', () => {
    expect(() =>
      checkService({
        envPlain: [{ key: 'DB_PASS', value: 'oops' }],
        envSecrets: [{ key: 'DB_PASS', secret: 'core-api-db-pass-prd', version: 'latest' }],
      }),
    ).toThrow(/DB_PASS is declared in both env-plain and env-secrets/)
  })
})

describe('error aggregation', () => {
  it('reports every problem at once, not just the first', () => {
    try {
      checkService({ image: '', serviceAccount: '', name: 'wrong-suffix' })
      expect.unreachable('should have thrown')
    } catch (e) {
      const err = e as ValidationError
      expect(err.problems.length).toBeGreaterThanOrEqual(3)
      expect(err.message).toMatch(/3 problems|4 problems/)
    }
  })
})
