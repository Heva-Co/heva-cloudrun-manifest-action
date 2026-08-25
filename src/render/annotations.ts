/**
 * Builds the run.googleapis.com/* and autoscaling.knative.dev/* annotation maps.
 *
 * Centralised because the fleet is inconsistent about which annotations exist
 * where, and about how their values are quoted. Deriving them from typed inputs
 * is what makes `run.googleapis.com/network-interfaces` stop being a JSON blob
 * hand-escaped in a workflow.
 */
import type { JobSpec, ServiceSpec, Spec } from '../schema.js'

/**
 * Direct VPC egress. The fleet uses ZERO legacy vpc-access-connectors, so this
 * only ever emits the network-interfaces form.
 */
function networkInterfaces(spec: Spec): string | undefined {
  if (!spec.vpcNetwork && !spec.vpcSubnetwork) return undefined
  const iface: Record<string, unknown> = {}
  if (spec.vpcNetwork) iface.network = spec.vpcNetwork
  if (spec.vpcSubnetwork) iface.subnetwork = spec.vpcSubnetwork
  if (spec.vpcTags.length > 0) iface.tags = spec.vpcTags
  return JSON.stringify([iface])
}

/** Annotations shared by Services and Jobs, on the revision/task template. */
export function templateAnnotations(spec: Spec): Record<string, string> {
  const out: Record<string, string> = {}

  const ni = networkInterfaces(spec)
  if (ni) out['run.googleapis.com/network-interfaces'] = ni
  if (spec.vpcEgress) out['run.googleapis.com/vpc-access-egress'] = spec.vpcEgress

  if (spec.cloudsqlInstances.length > 0) {
    out['run.googleapis.com/cloudsql-instances'] = spec.cloudsqlInstances.join(',')
  }
  if (spec.executionEnvironment) {
    out['run.googleapis.com/execution-environment'] = spec.executionEnvironment
  }

  if (spec.kind === 'service') {
    if (spec.minInstances !== undefined) {
      out['autoscaling.knative.dev/minScale'] = String(spec.minInstances)
    }
    if (spec.maxInstances !== undefined) {
      out['autoscaling.knative.dev/maxScale'] = String(spec.maxInstances)
    }
    if (spec.sandbox) out['run.googleapis.com/sandbox'] = spec.sandbox
    // Only emitted when explicitly set: absent means "use the Cloud Run
    // default" (throttling on), which is not the same as "false".
    if (spec.cpuThrottling !== undefined) {
      out['run.googleapis.com/cpu-throttling'] = String(spec.cpuThrottling)
    }
  }

  // User-supplied template annotations win, so a field the schema does not
  // model yet is still reachable without waiting for a release.
  return { ...out, ...spec.templateAnnotations }
}

/** Service-level (not revision-level) annotations. Jobs have none. */
export function serviceAnnotations(spec: ServiceSpec): Record<string, string> {
  const out: Record<string, string> = {}
  if (spec.ingress) {
    out['run.googleapis.com/ingress'] = spec.ingress
    // ingress-status is what `gcloud run services describe` reports back. The
    // fleet sets it alongside ingress in 7 of 9 services; keeping them together
    // avoids a spurious diff on the next describe-based round-trip.
    out['run.googleapis.com/ingress-status'] = spec.ingress
  }
  if (spec.launchStage) out['run.googleapis.com/launch-stage'] = spec.launchStage
  if (spec.invokerIamDisabled !== undefined) {
    out['run.googleapis.com/invoker-iam-disabled'] = String(spec.invokerIamDisabled)
  }
  if (spec.customAudiences.length > 0) {
    out['run.googleapis.com/custom-audiences'] = JSON.stringify(spec.customAudiences)
  }
  return { ...out, ...spec.annotations }
}

export function labels(spec: Spec): Record<string, string> {
  // Every manifest in the fleet carries the location label, without exception.
  return { 'cloud.googleapis.com/location': spec.region, ...spec.labels }
}

/** Kept for symmetry so callers never reach into JobSpec for annotations. */
export function jobTemplateAnnotations(spec: JobSpec): Record<string, string> {
  return templateAnnotations(spec)
}
