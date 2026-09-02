/**
 * The action's contract, as a zod schema.
 *
 * Shaped as a discriminated union on `kind` so that a Service input on a Job
 * (or vice versa) is a schema error rather than a field that Cloud Run silently
 * ignores — which is what happens today with, say, an ingress annotation on a
 * Job manifest.
 */
import { z } from 'zod'

export const ENVIRONMENTS = ['dev', 'stg', 'prd'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

export const SCAN_MODES = ['auto', 'warn', 'error', 'off'] as const
export type ScanMode = (typeof SCAN_MODES)[number]

const probe = z.object({
  path: z.string().min(1),
  port: z.number().int().positive().optional(),
  initialDelaySeconds: z.number().int().nonnegative().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  periodSeconds: z.number().int().positive().optional(),
  failureThreshold: z.number().int().positive().optional(),
})
export type Probe = z.infer<typeof probe>

const envVar = z.object({ key: z.string().min(1), value: z.string() })
const secretRef = z.object({
  key: z.string().min(1),
  secret: z.string().min(1),
  version: z.string().min(1),
})

/** A Secret Manager secret mounted as a file rather than an env var. */
const secretVolume = z.object({
  name: z.string().min(1),
  mountPath: z.string().min(1),
  secret: z.string().min(1),
  version: z.string().min(1).default('latest'),
})
export type SecretVolume = z.infer<typeof secretVolume>

/** Fields every Cloud Run workload carries, Service or Job alike. */
const common = {
  // No .min(1) on these four on purpose. An unset workflow variable renders an
  // empty string, and validate.ts owns that case so the error can say *why* the
  // deploy would fail and name the field, instead of zod's generic
  // "String must contain at least 1 character(s)".
  name: z.string().max(63),
  region: z.string(),
  image: z.string(),
  serviceAccount: z.string(),
  environment: z.enum(ENVIRONMENTS).or(z.literal('')).optional(),

  cpu: z.string().min(1).optional(),
  memory: z.string().min(1).optional(),
  command: z.array(z.string()).default([]),
  args: z.array(z.string()).default([]),

  envPlain: z.array(envVar).default([]),
  envSecrets: z.array(secretRef).default([]),
  secretVolumes: z.array(secretVolume).default([]),

  // Direct VPC egress. The fleet uses zero legacy VPC connectors, so network +
  // subnetwork are modelled directly and the JSON annotation is derived.
  vpcNetwork: z.string().optional(),
  vpcSubnetwork: z.string().optional(),
  vpcEgress: z.enum(['all-traffic', 'private-ranges-only']).optional(),
  vpcTags: z.array(z.string()).default([]),

  cloudsqlInstances: z.array(z.string()).default([]),
  executionEnvironment: z.enum(['gen1', 'gen2']).optional(),

  labels: z.record(z.string()).default({}),
  templateAnnotations: z.record(z.string()).default({}),
  overlay: z.unknown().optional(),
}

export const serviceSpec = z.object({
  kind: z.literal('service'),
  ...common,

  port: z.number().int().positive().optional(),
  ingress: z.enum(['all', 'internal', 'internal-and-cloud-load-balancing']).optional(),
  invokerIamDisabled: z.boolean().optional(),
  launchStage: z.string().optional(),
  sandbox: z.literal('gvisor').optional(),
  cpuThrottling: z.boolean().optional(),
  sessionAffinity: z.boolean().optional(),
  customAudiences: z.array(z.string()).default([]),

  minInstances: z.number().int().nonnegative().optional(),
  maxInstances: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),

  startupProbe: probe.optional(),
  livenessProbe: probe.optional(),
  readinessProbe: probe.optional(),

  /** Service-level annotations, the escape hatch for anything unmodelled. */
  annotations: z.record(z.string()).default({}),

  /**
   * How traffic is routed. Required: see parseTraffic for why it has no default.
   *
   * Only `latest` and `hold` today. Percentage splits (canary, or rolling back to
   * an older revision) are a deliberate later addition — this shape extends to
   * them without changing what callers already wrote.
   */
  traffic: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('latest') }),
    z.object({ mode: z.literal('hold'), revision: z.string().min(1) }),
  ]),
})
export type ServiceSpec = z.infer<typeof serviceSpec>

export const jobSpec = z.object({
  kind: z.literal('job'),
  ...common,

  parallelism: z.number().int().positive().optional(),
  taskCount: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
})
export type JobSpec = z.infer<typeof jobSpec>

export const spec = z.discriminatedUnion('kind', [serviceSpec, jobSpec])
export type Spec = z.infer<typeof spec>

/** Inputs that only make sense on a Service, for the cross-kind rejection. */
export const SERVICE_ONLY_INPUTS = [
  'port',
  'ingress',
  'invoker-iam-disabled',
  'launch-stage',
  'sandbox',
  'cpu-throttling',
  'session-affinity',
  'custom-audiences',
  'min-instances',
  'max-instances',
  'concurrency',
  'startup-probe',
  'liveness-probe',
  'readiness-probe',
  'annotations',
  'traffic',
] as const

/** Inputs that only make sense on a Job. */
export const JOB_ONLY_INPUTS = ['parallelism', 'task-count', 'max-retries'] as const
