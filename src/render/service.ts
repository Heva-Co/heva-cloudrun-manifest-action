/** ServiceSpec -> Knative Service manifest object. */
import type { ServiceSpec } from '../schema.js'
import { labels, serviceAnnotations, templateAnnotations } from './annotations.js'
import { renderEnv, renderVolumes } from './env.js'
import { renderProbe } from './probes.js'
import { pruneEmpty } from './prune.js'

export function renderService(spec: ServiceSpec): Record<string, unknown> {
  const { volumes, mounts } = renderVolumes(spec)

  const container = pruneEmpty({
    image: spec.image,
    ports: spec.port === undefined ? [] : [{ name: 'http1', containerPort: spec.port }],
    resources: pruneEmpty({
      limits: pruneEmpty({ cpu: spec.cpu, memory: spec.memory }),
    }),
    command: spec.command,
    args: spec.args,
    env: renderEnv(spec),
    volumeMounts: mounts,
    startupProbe: renderProbe(spec.startupProbe, spec.port),
    livenessProbe: renderProbe(spec.livenessProbe, spec.port),
    readinessProbe: renderProbe(spec.readinessProbe, spec.port),
  })

  const templateSpec = pruneEmpty({
    containerConcurrency: spec.concurrency,
    timeoutSeconds: spec.timeoutSeconds,
    serviceAccountName: spec.serviceAccount,
    // Knative expects `sessionAffinity` on the revision spec, not as an
    // annotation. Only emitted when set, so the Cloud Run default stands.
    sessionAffinity: spec.sessionAffinity,
    containers: [container],
    volumes,
  })

  // `traffic` is what decides whether a `replace` takes traffic. It is always
  // emitted: an omitted block means latestRevision 100% to the API, so leaving it
  // out would make a no-traffic deploy impossible to express.
  //
  // In hold mode the new revision is tagged, so it still gets a stable URL to
  // smoke-test while 100% keeps flowing to the named revision. The next deploy
  // with `latest` restores normal routing on its own — a declarative replace
  // overwrites the whole block, so no `update-traffic --to-latest` is needed.
  const traffic =
    spec.traffic.mode === 'hold'
      ? [
          { revisionName: spec.traffic.revision, percent: 100 },
          { latestRevision: true, percent: 0, tag: 'candidate' },
        ]
      : [{ latestRevision: true, percent: 100 }]

  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: pruneEmpty({
      name: spec.name,
      labels: labels(spec),
      annotations: serviceAnnotations(spec),
    }),
    spec: {
      template: pruneEmpty({
        metadata: pruneEmpty({ annotations: templateAnnotations(spec) }),
        spec: templateSpec,
      }),
      traffic,
    },
  }
}
