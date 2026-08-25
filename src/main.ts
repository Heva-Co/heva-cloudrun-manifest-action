/**
 * Action entrypoint. Glue only: read inputs, call build(), write, scan, report.
 *
 * Deliberately thin, and excluded from the coverage threshold: everything
 * interesting lives in build.ts / validate.ts / scan.ts, which are unit-tested.
 * What this file adds is process and runner wiring, and the only thing that
 * genuinely verifies THAT is self-test.yml running the action for real.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as core from './core.js'
import { parse as parseYaml } from 'yaml'
import { build, getterFrom, type InputGetter } from './build.js'
import { emit } from './emit.js'
import { InputError } from './inputs.js'
import { redactManifest } from './redact.js'
import type { ScanMode } from './schema.js'
import { effectiveMode, mergeFindings, scanEntropy, scanNames, type Finding } from './scan.js'
import { summaryMarkdown } from './summary.js'
import { ValidationError } from './validate.js'

/**
 * TEST SCAFFOLDING. Loads the whole input set from a YAML file.
 *
 * self-test.yml runs a matrix of ~10 cases, each needing ~30 inputs; inline
 * `with:` blocks would be a 400-line workflow. This is NOT a product config
 * file — consumer repos pass inputs via `with:`, which is the deliberate design
 * decision this action was built around.
 */
function fixtureGetter(path: string): InputGetter {
  const doc = (parseYaml(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(doc)) {
    values[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join('\n') : String(v)
  }
  return getterFrom(values)
}

export function run(): void {
  const fixture = core.getInput('fixture').trim()
  let get: InputGetter = (name) => core.getInput(name)
  if (fixture) {
    core.info(`Loading inputs from fixture ${fixture} (test scaffolding, not for product use)`)
    const fromFile = fixtureGetter(fixture)
    // Real inputs still win, so a self-test job can override one field.
    get = (name) => {
      const live = core.getInput(name)
      return live.trim().length > 0 ? live : fromFile(name)
    }
  }

  const { spec, allow, manifest } = build(get)

  const outPath = resolve(
    get('output').trim() || `${process.env.RUNNER_TEMP ?? '/tmp'}/cloudrun-${spec.name}.yaml`,
  )
  const yamlText = emit(manifest)
  writeFileSync(outPath, yamlText, 'utf8')

  // Redacted by default: the structure is what makes a printed manifest useful,
  // and the values are what make it a leak.
  core.startGroup(`Rendered manifest (values redacted): ${outPath}`)
  core.info(redactManifest(yamlText))
  core.endGroup()

  const resolved = effectiveMode((get('secret-scan').trim() || 'auto') as ScanMode, spec.environment)

  let findings: Finding[] = []
  let note: string | undefined
  if (resolved !== 'off') {
    const scriptPath = resolve(process.env.GITHUB_ACTION_PATH ?? process.cwd(), 'scripts/scan_manifest.py')
    const baselineInput = get('secret-scan-baseline').trim()
    const entropy = existsSync(scriptPath)
      ? scanEntropy(outPath, scriptPath, baselineInput && existsSync(baselineInput) ? baselineInput : undefined, allow)
      : { available: false, findings: [], note: `scan_manifest.py not found at ${scriptPath}` }
    note = entropy.note
    findings = mergeFindings(scanNames(spec, allow), entropy.findings)
  }

  core.setOutput('manifest-path', outPath)
  core.setOutput('name', spec.name)
  core.setOutput('kind', spec.kind)
  core.setOutput('findings-count', String(findings.length))
  // Names and detectors only. Never a value.
  core.setOutput('findings', JSON.stringify(findings))

  const summary = summaryMarkdown({
    kind: spec.kind,
    name: spec.name,
    region: spec.region,
    environment: spec.environment,
    manifestPath: outPath,
    findings,
    mode: resolved,
    note,
  })
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'utf8')
  } else {
    core.info(summary)
  }

  if (findings.length > 0) {
    const message =
      `${findings.length} env var(s) look like plaintext secrets: ` +
      `${findings.map((f) => f.name).join(', ')}. ` +
      `Move them to env-secrets so they mount from Secret Manager, ` +
      `or add them to secret-scan-allow if they are genuinely public.`
    if (resolved === 'error') core.setFailed(message)
    else core.warning(message)
  }
  if (note) core.info(note)
}

/* c8 ignore start -- module bootstrap */
try {
  run()
} catch (err) {
  if (err instanceof ValidationError || err instanceof InputError) {
    core.setFailed(err.message)
  } else {
    core.setFailed(err instanceof Error ? (err.stack ?? err.message) : String(err))
  }
}
/* c8 ignore stop */
