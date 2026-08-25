import { describe, expect, it } from 'vitest'
import { renderEnv, renderVolumes } from '../src/render/env.js'
import { serviceSpec } from '../src/schema.js'

function svc(over: Record<string, unknown>) {
  return serviceSpec.parse({
    kind: 'service',
    name: 'x-dev',
    region: 'us-central1',
    image: 'i',
    serviceAccount: 'sa@p.iam.gserviceaccount.com',
    environment: 'dev',
    traffic: { mode: 'latest' as const },
    ...over,
  })
}

describe('renderEnv', () => {
  it('merges plain and secret entries, sorted by name', () => {
    // Sorting keeps a deploy-to-deploy diff about what changed, not about where
    // someone inserted a var in a 158-entry hand-maintained block.
    const env = renderEnv(
      svc({
        envPlain: [{ key: 'ZED', value: '1' }, { key: 'ALPHA', value: '2' }],
        envSecrets: [{ key: 'MID', secret: 's', version: 'latest' }],
      }),
    )
    expect(env.map((e) => e.name)).toEqual(['ALPHA', 'MID', 'ZED'])
  })

  it('builds secretKeyRef with the secret id directly, no intermediate placeholder', () => {
    const env = renderEnv(svc({ envSecrets: [{ key: 'DB_PASS', secret: 'core-api-db-pass-prd', version: 'latest' }] }))
    expect(env[0]).toEqual({
      name: 'DB_PASS',
      valueFrom: { secretKeyRef: { name: 'core-api-db-pass-prd', key: 'latest' } },
    })
  })

  it('honours a pinned secret version', () => {
    const env = renderEnv(svc({ envSecrets: [{ key: 'K', secret: 's', version: '3' }] }))
    expect((env[0] as any).valueFrom.secretKeyRef.key).toBe('3')
  })

  it('keeps an empty plain value, which is a legitimate feature-flag off state', () => {
    expect(renderEnv(svc({ envPlain: [{ key: 'K', value: '' }] }))).toEqual([{ name: 'K', value: '' }])
  })
})

describe('renderVolumes', () => {
  it('splits a mount path into a directory mount plus a file item', () => {
    const { volumes, mounts } = renderVolumes(
      svc({ secretVolumes: [{ name: 'jwt', mountPath: '/etc/app/jwt.pub', secret: 'jwt-pub-prd', version: 'latest' }] }),
    )
    expect(mounts).toEqual([{ name: 'jwt', mountPath: '/etc/app' }])
    expect(volumes).toEqual([
      { name: 'jwt', secret: { secretName: 'jwt-pub-prd', items: [{ key: 'latest', path: 'jwt.pub' }] } },
    ])
  })

  it('returns empty for the common case, so nothing is emitted', () => {
    expect(renderVolumes(svc({}))).toEqual({ volumes: [], mounts: [] })
  })
})
