import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { getterFrom, type InputGetter } from '../src/build.js'

export const FIXTURE_DIR = join(import.meta.dirname, 'fixtures')
export const LEGACY_DIR = join(import.meta.dirname, 'legacy')

export function fixtureCases(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.inputs.yml'))
    .map((f) => f.replace('.inputs.yml', ''))
    .sort()
}

/** Reads a fixture into an InputGetter, the same way main.ts's `fixture` does. */
export function fixtureGetter(name: string): InputGetter {
  const doc = (parseYaml(readFileSync(join(FIXTURE_DIR, `${name}.inputs.yml`), 'utf8')) ?? {}) as Record<
    string,
    unknown
  >
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(doc)) {
    values[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join('\n') : String(v)
  }
  return getterFrom(values)
}

export function readFixture(name: string, suffix: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.${suffix}`), 'utf8')
}

export function readLegacy(name: string): string {
  return readFileSync(join(LEGACY_DIR, name), 'utf8')
}

/** A getter over an override map, for one-off cases inside a test. */
export function inputs(values: Record<string, string>): InputGetter {
  return getterFrom(values)
}
