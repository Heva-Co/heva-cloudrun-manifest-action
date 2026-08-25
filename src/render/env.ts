/**
 * Builds the container `env` array.
 *
 * Plain values and secret references land in one list, sorted by name. Sorting
 * is deliberate: it makes a manifest diff between two deploys show only what
 * actually changed, instead of moving 158 entries around because someone
 * inserted a var in the middle of a hand-maintained block.
 */
import type { Spec } from '../schema.js'

export type EnvEntry =
  | { name: string; value: string }
  | { name: string; valueFrom: { secretKeyRef: { name: string; key: string } } }

export function renderEnv(spec: Spec): EnvEntry[] {
  const entries: EnvEntry[] = [
    ...spec.envPlain.map((e) => ({ name: e.key, value: e.value })),
    ...spec.envSecrets.map((s) => ({
      name: s.key,
      // name-then-key ordering, which is what 3 of the 4 repos using
      // secretKeyRef write. normalize.ts makes the order irrelevant for
      // comparison, but the emitted file should still look like one house style.
      valueFrom: { secretKeyRef: { name: s.secret, key: s.version } },
    })),
  ]
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export type VolumeMount = { name: string; mountPath: string }
export type Volume = {
  name: string
  secret: { secretName: string; items: { key: string; path: string }[] }
}

/**
 * Secret-as-file mounts. No manifest in the fleet uses these today, but
 * core-api's prd workflow carries a `yq` step that deletes volumeMounts —
 * so the shape has existed at some point. Modelling it means that step is a
 * matter of not passing an input, rather than post-processing the output.
 */
export function renderVolumes(spec: Spec): { volumes: Volume[]; mounts: VolumeMount[] } {
  const volumes: Volume[] = []
  const mounts: VolumeMount[] = []
  for (const v of spec.secretVolumes) {
    const file = v.mountPath.split('/').filter(Boolean).pop() ?? v.name
    volumes.push({
      name: v.name,
      secret: { secretName: v.secret, items: [{ key: v.version, path: file }] },
    })
    // Cloud Run mounts a directory, so the mount path is the parent of the file.
    const dir = v.mountPath.slice(0, v.mountPath.length - file.length - 1) || '/'
    mounts.push({ name: v.name, mountPath: dir })
  }
  return { volumes, mounts }
}
