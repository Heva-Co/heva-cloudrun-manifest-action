/**
 * Inputs -> validated Spec -> manifest object.
 *
 * The input getter is injected rather than read from process.env so this whole
 * path is unit-testable. main.ts passes `core.getInput`; tests pass a plain map.
 * Without this split, the only way to test rendering end to end would be to
 * mutate process.env, and golden tests would be integration tests.
 */
import { parse as parseYaml } from 'yaml'
import {
  InputError,
  parseKeyValueBlock,
  parseListBlock,
  parseMapBlock,
  parseProbe,
  parseSecretBlock,
  parseTraffic,
} from './inputs.js'
import { render } from './render/index.js'
import { spec as specSchema, type Spec } from './schema.js'
import { validate } from './validate.js'

export type InputGetter = (name: string) => string

/** Every input name, used for the cross-kind "was it supplied" check. */
export const ALL_INPUT_NAMES = [
  'kind', 'name', 'region', 'image', 'service-account', 'environment',
  'port', 'cpu', 'memory', 'command', 'args',
  'env-plain', 'env-secrets', 'secret-volumes',
  'vpc-network', 'vpc-subnetwork', 'vpc-egress', 'vpc-tags',
  'cloudsql-instances', 'execution-environment',
  'ingress', 'invoker-iam-disabled', 'launch-stage', 'sandbox', 'cpu-throttling',
  'session-affinity', 'custom-audiences',
  'min-instances', 'max-instances', 'concurrency', 'timeout',
  'startup-probe', 'liveness-probe', 'readiness-probe', 'traffic',
  'parallelism', 'task-count', 'max-retries',
  'labels', 'annotations', 'template-annotations', 'overlay',
] as const

function accessors(get: InputGetter) {
  const has = (n: string) => get(n).trim().length > 0
  const str = (n: string) => (has(n) ? get(n) : undefined)
  const num = (n: string) => {
    if (!has(n)) return undefined
    const v = Number(get(n).trim())
    if (!Number.isInteger(v)) {
      throw new InputError(`${n} must be an integer, got ${JSON.stringify(get(n))}`)
    }
    return v
  }
  const bool = (n: string) => {
    if (!has(n)) return undefined
    const v = get(n).trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
    throw new InputError(`${n} must be "true" or "false", got ${JSON.stringify(get(n))}`)
  }
  return { has, str, num, bool }
}

/** `name:/mount/path=secret-id[:version]` */
function parseSecretVolumes(block: string | undefined) {
  return parseKeyValueBlock(block, 'secret-volumes').map(({ key, value }) => {
    const colon = key.indexOf(':')
    if (colon < 0) {
      throw new InputError(
        `secret-volumes: expected "name:/mount/path=secret[:version]", got ${JSON.stringify(key)}`,
      )
    }
    const last = value.lastIndexOf(':')
    return {
      name: key.slice(0, colon).trim(),
      mountPath: key.slice(colon + 1).trim(),
      secret: last > 0 ? value.slice(0, last).trim() : value,
      version: last > 0 ? value.slice(last + 1).trim() : 'latest',
    }
  })
}

export function buildSpec(get: InputGetter): Spec {
  const { str, num, bool } = accessors(get)

  const common = {
    name: get('name'),
    region: get('region'),
    image: get('image'),
    serviceAccount: get('service-account'),
    environment: (str('environment') ?? 'dev').toLowerCase(),
    cpu: str('cpu'),
    memory: str('memory'),
    command: parseListBlock(str('command')),
    args: parseListBlock(str('args')),
    envPlain: parseKeyValueBlock(str('env-plain'), 'env-plain'),
    envSecrets: parseSecretBlock(str('env-secrets'), 'env-secrets'),
    secretVolumes: parseSecretVolumes(str('secret-volumes')),
    vpcNetwork: str('vpc-network'),
    vpcSubnetwork: str('vpc-subnetwork'),
    vpcEgress: str('vpc-egress'),
    vpcTags: parseListBlock(str('vpc-tags')),
    // Accepts both comma- and newline-separated, because the existing workflows
    // pass a single comma-joined string.
    cloudsqlInstances: parseListBlock(str('cloudsql-instances')).flatMap((l) =>
      l.split(',').map((s) => s.trim()).filter(Boolean),
    ),
    executionEnvironment: str('execution-environment'),
    labels: parseMapBlock(str('labels'), 'labels'),
    templateAnnotations: parseMapBlock(str('template-annotations'), 'template-annotations'),
    timeoutSeconds: num('timeout'),
  }

  if ((str('kind') ?? 'service').toLowerCase() === 'job') {
    return specSchema.parse({
      kind: 'job',
      ...common,
      parallelism: num('parallelism'),
      taskCount: num('task-count'),
      maxRetries: num('max-retries'),
    })
  }

  return specSchema.parse({
    kind: 'service',
    ...common,
    port: num('port'),
    ingress: str('ingress'),
    invokerIamDisabled: bool('invoker-iam-disabled'),
    launchStage: str('launch-stage'),
    sandbox: str('sandbox'),
    cpuThrottling: bool('cpu-throttling'),
    sessionAffinity: bool('session-affinity'),
    customAudiences: parseListBlock(str('custom-audiences')),
    minInstances: num('min-instances'),
    maxInstances: num('max-instances'),
    concurrency: num('concurrency'),
    startupProbe: parseProbe(str('startup-probe'), 'startup-probe'),
    livenessProbe: parseProbe(str('liveness-probe'), 'liveness-probe'),
    readinessProbe: parseProbe(str('readiness-probe'), 'readiness-probe'),
    annotations: parseMapBlock(str('annotations'), 'annotations'),
    traffic: parseTraffic(str('traffic'), 'traffic'),
  })
}

/** Deep merge for the `overlay` escape hatch. Arrays replace, objects merge. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base
  if (Array.isArray(over) || Array.isArray(base)) return over
  if (base && over && typeof base === 'object' && typeof over === 'object') {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      out[k] = deepMerge(out[k], v)
    }
    return out
  }
  return over
}

export type BuildResult = { spec: Spec; manifest: unknown; allow: Set<string> }

/** The whole pipeline: parse, render, overlay, validate. Throws on any problem. */
export function build(get: InputGetter): BuildResult {
  const spec = buildSpec(get)
  const overlayText = get('overlay').trim()
  const overlay = overlayText.length > 0 ? (parseYaml(overlayText) as unknown) : undefined
  const manifest = deepMerge(render(spec), overlay)

  const allow = new Set(parseListBlock(get('secret-scan-allow')))
  const supplied = new Set(ALL_INPUT_NAMES.filter((n) => get(n).trim().length > 0))
  validate(spec, manifest, supplied, allow)
  return { spec, manifest, allow }
}

/** Builds an InputGetter over a plain record. Used by tests and by `fixture`. */
export function getterFrom(values: Record<string, string>): InputGetter {
  return (name: string) => values[name] ?? ''
}
