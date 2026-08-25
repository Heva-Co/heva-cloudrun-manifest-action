/** Probe spec -> Knative probe object. Services only; Jobs have no probes. */
import type { Probe } from '../schema.js'

export type RenderedProbe = {
  httpGet: { path: string; port?: number }
  initialDelaySeconds?: number
  timeoutSeconds?: number
  periodSeconds?: number
  failureThreshold?: number
}

export function renderProbe(probe: Probe | undefined, defaultPort: number | undefined): RenderedProbe | undefined {
  if (!probe) return undefined
  // Falls back to the container port so a probe spec can omit it, matching
  // web-app which writes `httpGet: { path: / }` with no port.
  const port = probe.port ?? defaultPort
  const out: RenderedProbe = { httpGet: port === undefined ? { path: probe.path } : { path: probe.path, port } }
  if (probe.initialDelaySeconds !== undefined) out.initialDelaySeconds = probe.initialDelaySeconds
  if (probe.timeoutSeconds !== undefined) out.timeoutSeconds = probe.timeoutSeconds
  if (probe.periodSeconds !== undefined) out.periodSeconds = probe.periodSeconds
  if (probe.failureThreshold !== undefined) out.failureThreshold = probe.failureThreshold
  return out
}
