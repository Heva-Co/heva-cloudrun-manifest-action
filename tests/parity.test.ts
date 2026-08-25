/**
 * Parity against hand-authored legacy-style manifests.
 *
 * The golden tests only prove the renderer is stable. This file proves the input
 * surface can EXPRESS what a hand-written `envsubst` manifest expresses: it
 * renders the legacy template with envsubst and compares the STRUCTURE against
 * what the action produces from the equivalent inputs.
 *
 * The templates in tests/legacy/ are written by hand, in the old style, on
 * purpose. Generating them would make this test compare the generator against
 * itself.
 *
 * Structural rather than exact, deliberately. The action differs from the legacy
 * style in ways that are improvements, and each one is asserted explicitly below
 * rather than waved away. A difference that is NOT on that list is a bug.
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { build } from '../src/build.js'
import { normalizeObject } from '../src/normalize.js'
import { fixtureGetter, readLegacy } from './helpers.js'

/** Substitutes $VAR / ${VAR} the way envsubst does, from a supplied map. */
function envsubst(text: string, vars: Record<string, string>): string {
  return text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, a, b) => vars[a ?? b] ?? '',
  )
}

function container(manifest: any) {
  return manifest.kind === 'Job'
    ? manifest.spec.template.spec.template.spec.containers[0]
    : manifest.spec.template.spec.containers[0]
}

function envNames(manifest: any): string[] {
  return (container(manifest).env ?? []).map((e: any) => e.name as string).sort()
}

function templateAnnotations(manifest: any): Record<string, unknown> {
  return manifest.spec.template.metadata?.annotations ?? {}
}

describe('envsubst is available, so this file actually tests something', () => {
  it('finds the binary', () => {
    // Without it, these tests would silently compare nothing.
    expect(() => execFileSync('envsubst', ['--version'], { encoding: 'utf8' })).not.toThrow()
  })
})

/** A legacy template, the fixture that should reproduce it, and the variables. */
const PAIRS = [
  {
    legacy: 'service-secretref.legacy.yaml',
    fixture: 'internal-portal',
    vars: {
      SERVICE_NAME: 'internal-portal-dev',
      REGION: 'us-central1',
      IMAGE: 'us-central1-docker.pkg.dev/example-internal/apps/internal-portal:abc123',
      SERVICE_ACCOUNT: 'internal-portal@example-internal.iam.gserviceaccount.com',
      TRACKER_CLOUD_ID: '0a1b2c3d-4e5f-6789-abcd-ef0123456789',
      TRACKER_INTAKE_WEBHOOK_URL_SECRET_ID: 'tracker-intake-webhook-url',
      TRACKER_INTAKE_WEBHOOK_SECRET_ID: 'tracker-intake-webhook-secret',
      TRACKER_GENERAL_WEBHOOK_URL_SECRET_ID: 'tracker-general-webhook-url',
      TRACKER_GENERAL_WEBHOOK_SECRET_ID: 'tracker-general-webhook-secret',
      TRACKER_CLIENT_ID_SECRET_ID: 'tracker-client-id',
      TRACKER_CLIENT_SECRET_SECRET_ID: 'tracker-client-secret',
    },
  },
  {
    legacy: 'service-probes.legacy.yaml',
    fixture: 'admin-api',
    vars: {
      SERVICE_NAME: 'admin-api-prd',
      REGION: 'us-central1',
      IMAGE: 'us-central1-docker.pkg.dev/example-prd/apps/admin-api:abc123',
      SERVICE_ACCOUNT: 'admin-api@example-prd.iam.gserviceaccount.com',
      INGRESS: 'internal-and-cloud-load-balancing',
      INVOKER_IAM_DISABLED: 'true',
      MIN_SCALE: '1',
      MAX_SCALE: '10',
      CONTAINER_CONCURRENCY: '80',
      CPU: '1',
      MEMORY: '512Mi',
      PORT: '8080',
      // The real workflows export this WITH literal surrounding quotes
      // (`'''${{ vars.NETWORK_INTERFACES }}'''`) because the manifest leaves the
      // annotation unquoted — without them the JSON parses as a YAML array and
      // the k8s API rejects a non-string annotation. Reproduced faithfully.
      NETWORK_INTERFACES: '\'[{"network":"default","subnetwork":"default"}]\'',
      VPC_ACCESS_EGRESS: 'private-ranges-only',
      DB_INSTANCE_CONNECTION_NAME: 'example-prd:us-central1:main-db',
      PARAMETER_MANAGER_CONFIG_NAME: 'admin-api-config-prd',
    },
  },
  {
    legacy: 'job-migrate.legacy.yaml',
    fixture: 'core-api-job-migrate',
    vars: {
      SERVICE_NAME: 'core-api-migrate-prd',
      REGION: 'us-central1',
      IMAGE: 'us-central1-docker.pkg.dev/example-prd/apps/core-api:abc123',
      SERVICE_ACCOUNT: 'core-api@example-prd.iam.gserviceaccount.com',
      NETWORK_INTERFACES: '\'[{"network":"default","subnetwork":"default"}]\'',
      VPC_ACCESS_EGRESS: 'private-ranges-only',
      DB_INSTANCE_CONNECTION_NAME: 'example-prd:us-central1:main-db',
      GOOGLE_CLOUD_PROJECT: 'example-prd',
      APP_ENV: 'prd',
      PARAMETER_MANAGER_CONFIG_NAME: 'core-api-config-prd',
      MIGRATION_LOCK_WAIT: '10m',
      CPU: '1000m',
      MEMORY: '512Mi',
    },
  },
] as const

describe.each(PAIRS)('parity: $legacy', ({ legacy, fixture, vars }) => {
  const old = parseYaml(envsubst(readLegacy(legacy), vars as Record<string, string>)) as any
  const gen = build(fixtureGetter(fixture)).manifest as any

  it('agrees on apiVersion and kind', () => {
    expect(gen.apiVersion).toBe(old.apiVersion)
    expect(gen.kind).toBe(old.kind)
  })

  it('agrees on name and location label', () => {
    expect(gen.metadata.name).toBe(old.metadata.name)
    expect(gen.metadata.labels['cloud.googleapis.com/location']).toBe(
      old.metadata.labels['cloud.googleapis.com/location'],
    )
  })

  it('carries exactly the same set of env var names', () => {
    // The most valuable assertion in the file. A generator that quietly dropped
    // an env var would still pass every other test here.
    expect(envNames(gen)).toEqual(envNames(old))
  })

  it('agrees on which env vars come from Secret Manager', () => {
    const secretNames = (m: any) =>
      (container(m).env ?? []).filter((e: any) => e.valueFrom).map((e: any) => e.name).sort()
    expect(secretNames(gen)).toEqual(secretNames(old))
  })

  it('resolves every secretKeyRef to the same secret id and version', () => {
    // Also proves normalisation of the two key orders the old style used:
    // one template writes `name:` first, the other `key:` first.
    const refs = (m: any) =>
      Object.fromEntries(
        (container(m).env ?? [])
          .filter((e: any) => e.valueFrom)
          .map((e: any) => [e.name, `${e.valueFrom.secretKeyRef.name}:${e.valueFrom.secretKeyRef.key}`]),
      )
    expect(refs(gen)).toEqual(refs(old))
  })

  it('agrees on image and resource limits', () => {
    expect(container(gen).image).toBe(container(old).image)
    // Normalised: the legacy style writes `cpu: $CPU` unquoted, so after
    // envsubst `1` parses as a NUMBER, while k8s types resources.limits as
    // string->string. Emitting the string is the fix, not a mismatch.
    expect(normalizeObject(container(gen).resources ?? {})).toEqual(
      normalizeObject(container(old).resources ?? {}),
    )
  })

  it('agrees on the service account, wherever the kind puts it', () => {
    const sa = (m: any) =>
      m.kind === 'Job'
        ? m.spec.template.spec.template.spec.serviceAccountName
        : m.spec.template.spec.serviceAccountName
    expect(sa(gen)).toBe(sa(old))
  })

  it('agrees on every run.googleapis.com and autoscaling annotation', () => {
    const norm = (o: Record<string, unknown>) =>
      normalizeObject(
        Object.fromEntries(
          Object.entries(o).filter(
            ([k]) => k.startsWith('run.googleapis.com/') || k.startsWith('autoscaling.knative.dev/'),
          ),
        ),
      )
    expect(norm(templateAnnotations(gen))).toEqual(norm(templateAnnotations(old)))
  })
})

describe('the deliberate differences from the legacy style', () => {
  it('sorts env, where a hand-maintained list is in insertion order', () => {
    const gen = build(fixtureGetter('internal-portal')).manifest as any
    const names = container(gen).env.map((e: any) => e.name)
    expect(names).toEqual([...names].sort())

    const old = parseYaml(readLegacy('service-secretref.legacy.yaml')) as any
    const oldNames = container(old).env.map((e: any) => e.name)
    expect(oldNames).not.toEqual([...oldNames].sort())
  })

  it('adds ingress-status alongside ingress', () => {
    // Matching what `describe` reports back avoids a spurious diff on the next
    // round-trip. The legacy template omits it.
    const gen = build(fixtureGetter('internal-portal')).manifest as any
    expect(gen.metadata.annotations['run.googleapis.com/ingress-status']).toBe(
      gen.metadata.annotations['run.googleapis.com/ingress'],
    )
    const old = parseYaml(readLegacy('service-secretref.legacy.yaml')) as any
    expect(old.metadata.annotations['run.googleapis.com/ingress-status']).toBeUndefined()
  })

  it('always emits a traffic block, which the legacy template omits', () => {
    const gen = build(fixtureGetter('internal-portal')).manifest as any
    expect(gen.spec.traffic).toEqual([{ latestRevision: true, percent: 100 }])
    expect((parseYaml(readLegacy('service-secretref.legacy.yaml')) as any).spec.traffic).toBeUndefined()
  })

  it('drops metadata.generation, a copy-paste artefact from `describe`', () => {
    const gen = build(fixtureGetter('notifier')).manifest as any
    expect(gen.metadata.generation).toBeUndefined()
    // Present in the legacy template, and meaningless in a file you apply.
    const old = parseYaml(readLegacy('service-generation-artifact.legacy.yaml')) as any
    expect(old.metadata.generation).toBe(4)
  })
})

describe('one env list cannot drift between environments', () => {
  it('the same inputs render dev and prd with an identical env var set', () => {
    // This is the property that removes the whole class of bug where a
    // production-only copy of a manifest silently loses an env var: there is no
    // second file, so only the values and the plain/secret split change.
    const prd = build(fixtureGetter('core-api')).manifest as any
    const dev = build((n) => {
      const g = fixtureGetter('core-api')
      if (n === 'environment') return 'dev'
      if (n === 'name') return 'core-api-dev'
      if (n === 'env-secrets') return g('env-secrets').replace(/-prd$/gm, '-dev')
      return g(n)
    }).manifest as any
    expect(envNames(dev)).toEqual(envNames(prd))
  })
})
