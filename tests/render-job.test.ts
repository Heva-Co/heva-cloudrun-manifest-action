import { describe, expect, it } from 'vitest'
import { renderJob } from '../src/render/job.js'
import { jobSpec } from '../src/schema.js'

function job(over: Record<string, unknown> = {}) {
  return jobSpec.parse({
    kind: 'job',
    name: 'core-api-migrate-prd',
    region: 'us-central1',
    image: 'img:sha',
    serviceAccount: 'core-api@example-prd.iam.gserviceaccount.com',
    environment: 'prd',
    ...over,
  })
}

describe('renderJob', () => {
  it('uses the Cloud Run apiVersion, not the Knative serving one', () => {
    const m = renderJob(job())
    expect(m.apiVersion).toBe('run.googleapis.com/v1')
    expect(m.kind).toBe('Job')
  })

  it('emits no metadata-level annotations: a Job has no ingress or invoker-iam', () => {
    expect(renderJob(job()) as any).not.toHaveProperty('metadata.annotations')
  })

  it('nests the pod spec one level deeper than a Service', () => {
    const m = renderJob(job()) as any
    expect(m.spec.template.spec.template.spec.serviceAccountName).toBe(
      'core-api@example-prd.iam.gserviceaccount.com',
    )
  })

  it('names the container <job>-1, which Services never do', () => {
    const m = renderJob(job()) as any
    expect(m.spec.template.spec.template.spec.containers[0].name).toBe('core-api-migrate-prd-1')
  })

  it('keeps maxRetries: 0, which must not be pruned as falsy', () => {
    // job.migrate.yaml: a retry can collide with a still-running DDL statement.
    const m = renderJob(job({ maxRetries: 0 })) as any
    expect(m.spec.template.spec.template.spec.maxRetries).toBe(0)
  })

  it('stringifies timeoutSeconds, which the v1 Job API types as a string', () => {
    const m = renderJob(job({ timeoutSeconds: 1800 })) as any
    expect(m.spec.template.spec.template.spec.timeoutSeconds).toBe('1800')
  })

  it('preserves command and args order', () => {
    const m = renderJob(job({ command: ['./app'], args: ['jobs', 'cold-lead-sweep'] })) as any
    const c = m.spec.template.spec.template.spec.containers[0]
    expect(c.command).toEqual(['./app'])
    expect(c.args).toEqual(['jobs', 'cold-lead-sweep'])
  })

  it('carries parallelism and taskCount on the outer template spec', () => {
    const m = renderJob(job({ parallelism: 1, taskCount: 1 })) as any
    expect(m.spec.template.spec.parallelism).toBe(1)
    expect(m.spec.template.spec.taskCount).toBe(1)
  })

  it('still gets network and cloudsql annotations on the task template', () => {
    const m = renderJob(
      job({ vpcNetwork: 'default', vpcSubnetwork: 'default', vpcEgress: 'private-ranges-only', cloudsqlInstances: ['p:r:i'], executionEnvironment: 'gen2' }),
    ) as any
    const ann = m.spec.template.metadata.annotations
    expect(ann['run.googleapis.com/network-interfaces']).toBe('[{"network":"default","subnetwork":"default"}]')
    expect(ann['run.googleapis.com/cloudsql-instances']).toBe('p:r:i')
    expect(ann['run.googleapis.com/execution-environment']).toBe('gen2')
  })

  it('has no ports, no probes and no traffic block', () => {
    const m = renderJob(job()) as any
    const c = m.spec.template.spec.template.spec.containers[0]
    expect(c).not.toHaveProperty('ports')
    expect(c).not.toHaveProperty('startupProbe')
    expect(m.spec).not.toHaveProperty('traffic')
  })
})
