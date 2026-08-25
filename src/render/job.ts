/**
 * JobSpec -> Cloud Run Job manifest object.
 *
 * Structurally different from a Service in ways that are easy to get wrong by
 * hand, which is most of why this file exists:
 *   - apiVersion is run.googleapis.com/v1, not serving.knative.dev/v1
 *   - no metadata-level annotations at all (no ingress, no invoker-iam)
 *   - the spec nests one level deeper: spec.template.spec.template.spec
 *   - serviceAccountName and maxRetries sit on the INNER template spec
 *   - the container carries a `name`, which Services never set
 *   - no ports, no probes, no traffic block
 */
import type { JobSpec } from '../schema.js'
import { labels, templateAnnotations } from './annotations.js'
import { renderEnv, renderVolumes } from './env.js'
import { pruneEmpty } from './prune.js'

export function renderJob(spec: JobSpec): Record<string, unknown> {
  const { volumes, mounts } = renderVolumes(spec)

  const container = pruneEmpty({
    // Cloud Run names job containers `<job>-1`. Following the existing
    // convention keeps `gcloud run jobs describe` output familiar.
    name: `${spec.name}-1`,
    image: spec.image,
    command: spec.command,
    args: spec.args,
    env: renderEnv(spec),
    volumeMounts: mounts,
    resources: pruneEmpty({ limits: pruneEmpty({ cpu: spec.cpu, memory: spec.memory }) }),
  })

  const innerSpec = pruneEmpty({
    containers: [container],
    volumes,
    // maxRetries: 0 is meaningful and must survive pruning, so it is compared
    // against undefined rather than truthiness. A retry on a half-applied
    // migration is exactly what job.migrate.yaml warns against.
    maxRetries: spec.maxRetries,
    // The Cloud Run v1 Job API types this as a string.
    timeoutSeconds: spec.timeoutSeconds === undefined ? undefined : String(spec.timeoutSeconds),
    serviceAccountName: spec.serviceAccount,
  })

  return {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Job',
    metadata: pruneEmpty({
      name: spec.name,
      labels: labels(spec),
    }),
    spec: {
      template: pruneEmpty({
        metadata: pruneEmpty({ annotations: templateAnnotations(spec) }),
        spec: pruneEmpty({
          parallelism: spec.parallelism,
          taskCount: spec.taskCount,
          template: { spec: innerSpec },
        }),
      }),
    },
  }
}
