import { describe, expect, it } from 'vitest'
import { renderService } from '../src/render/service.js'
import { serviceSpec } from '../src/schema.js'

function svc(over: Record<string, unknown> = {}) {
  return serviceSpec.parse({
    kind: 'service',
    name: 'core-api-prd',
    region: 'us-central1',
    image: 'us-central1-docker.pkg.dev/example-prd/repo/img:sha',
    serviceAccount: 'core-api@example-prd.iam.gserviceaccount.com',
    environment: 'prd',
    traffic: { mode: 'latest' as const },
    ...over,
  })
}

describe('renderService', () => {
  it('emits the Knative apiVersion and kind', () => {
    const m = renderService(svc())
    expect(m.apiVersion).toBe('serving.knative.dev/v1')
    expect(m.kind).toBe('Service')
  })

  it('always carries the location label, as every manifest in the fleet does', () => {
    const m = renderService(svc()) as any
    expect(m.metadata.labels['cloud.googleapis.com/location']).toBe('us-central1')
  })

  it('derives the network-interfaces JSON instead of taking it hand-escaped', () => {
    const m = renderService(svc({ vpcNetwork: 'default', vpcSubnetwork: 'default' })) as any
    expect(m.spec.template.metadata.annotations['run.googleapis.com/network-interfaces']).toBe(
      '[{"network":"default","subnetwork":"default"}]',
    )
  })

  it('supports the fully-qualified shared-VPC form used by dev and stg', () => {
    const m = renderService(
      svc({
        vpcNetwork: 'projects/example-shared/global/networks/shared-vpc',
        vpcSubnetwork: 'projects/example-shared/regions/us-central1/subnetworks/dev',
      }),
    ) as any
    expect(JSON.parse(m.spec.template.metadata.annotations['run.googleapis.com/network-interfaces'])).toEqual([
      {
        network: 'projects/example-shared/global/networks/shared-vpc',
        subnetwork: 'projects/example-shared/regions/us-central1/subnetworks/dev',
      },
    ])
  })

  it('never emits a legacy vpc-access-connector: the fleet is 100% direct egress', () => {
    const m = renderService(svc({ vpcNetwork: 'default', vpcEgress: 'private-ranges-only' })) as any
    const ann = JSON.stringify(m.spec.template.metadata.annotations)
    expect(ann).not.toContain('vpc-access-connector')
    expect(m.spec.template.metadata.annotations['run.googleapis.com/vpc-access-egress']).toBe('private-ranges-only')
  })

  it('sets ingress and ingress-status together', () => {
    const m = renderService(svc({ ingress: 'internal-and-cloud-load-balancing' })) as any
    expect(m.metadata.annotations['run.googleapis.com/ingress']).toBe('internal-and-cloud-load-balancing')
    expect(m.metadata.annotations['run.googleapis.com/ingress-status']).toBe('internal-and-cloud-load-balancing')
  })

  it('omits cpu-throttling unless set, since absent != false', () => {
    // With nothing to annotate, template.metadata is pruned away entirely.
    expect((renderService(svc()) as any).spec.template.metadata).toBeUndefined()
    const m = renderService(svc({ cpuThrottling: false })) as any
    expect(m.spec.template.metadata.annotations['run.googleapis.com/cpu-throttling']).toBe('false')
  })

  it('keeps minScale 0 rather than pruning it as falsy', () => {
    const m = renderService(svc({ minInstances: 0, maxInstances: 2 })) as any
    expect(m.spec.template.metadata.annotations['autoscaling.knative.dev/minScale']).toBe('0')
  })

  it('serialises customAudiences as a JSON array', () => {
    const m = renderService(svc({ customAudiences: ['https://api.example.com/ia/*'] })) as any
    expect(m.metadata.annotations['run.googleapis.com/custom-audiences']).toBe('["https://api.example.com/ia/*"]')
  })

  it('joins multiple cloudsql instances with a comma', () => {
    const m = renderService(svc({ cloudsqlInstances: ['p:r:a', 'p:r:b'] })) as any
    expect(m.spec.template.metadata.annotations['run.googleapis.com/cloudsql-instances']).toBe('p:r:a,p:r:b')
  })

  it('names the port http1 and defaults the probe port to it', () => {
    const m = renderService(svc({ port: 8000, startupProbe: { path: '/health/liveness' } })) as any
    expect(m.spec.template.spec.containers[0].ports).toEqual([{ name: 'http1', containerPort: 8000 }])
    expect(m.spec.template.spec.containers[0].startupProbe.httpGet).toEqual({ path: '/health/liveness', port: 8000 })
  })

  it('omits the probe port when there is no container port, like web-app', () => {
    const m = renderService(svc({ startupProbe: { path: '/' } })) as any
    expect(m.spec.template.spec.containers[0].startupProbe.httpGet).toEqual({ path: '/' })
  })

  it('sends 100% to latestRevision by default', () => {
    expect((renderService(svc()) as any).spec.traffic).toEqual([{ latestRevision: true, percent: 100 }])
  })

  it('pins traffic and tags the new revision as candidate at 0%', () => {
    // The no-traffic deploy: the named revision keeps 100%, the new one is
    // reachable under a tag for smoke-testing but serves nobody.
    const m = renderService(svc({ traffic: { mode: 'hold', revision: 'core-api-prd-00042-abc' } })) as any
    expect(m.spec.traffic).toEqual([
      { revisionName: 'core-api-prd-00042-abc', percent: 100 },
      { latestRevision: true, percent: 0, tag: 'candidate' },
    ])
  })

  it('prunes empty structures rather than emitting resources: {} and env: []', () => {
    const m = renderService(svc()) as any
    expect(m.spec.template.spec.containers[0]).not.toHaveProperty('resources')
    expect(m.spec.template.spec.containers[0]).not.toHaveProperty('env')
    expect(m.spec.template.spec.containers[0]).not.toHaveProperty('volumeMounts')
  })

  it('lets a template-annotation override a derived one', () => {
    const m = renderService(
      svc({ vpcEgress: 'private-ranges-only', templateAnnotations: { 'run.googleapis.com/vpc-access-egress': 'all-traffic' } }),
    ) as any
    expect(m.spec.template.metadata.annotations['run.googleapis.com/vpc-access-egress']).toBe('all-traffic')
  })
})
