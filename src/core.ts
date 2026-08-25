/**
 * The slice of the GitHub Actions runner protocol this action needs.
 *
 * Replaces @actions/core, which pulls in @actions/http-client and undici for
 * OIDC support. That was ~70% of the bundle, and this action has no business
 * making a network call at all — it needs no credentials and never talks to GCP.
 * Dropping it takes dist/ from 1.2MB to ~65KB, which makes the committed bundle
 * reviewable and removes an HTTP stack from the audit surface.
 *
 * The protocol is documented and stable:
 * https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions
 */
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * Escaping for workflow command DATA. The runner parses `::name::data` line by
 * line, so a literal newline in the data would be read as the end of the
 * command.
 */
function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function issue(command: string, message = ''): void {
  process.stdout.write(`::${command}::${escapeData(message)}\n`)
}

/**
 * Reads an action input.
 *
 * The runner exposes `with:` entries as `INPUT_<NAME>`, uppercased with spaces
 * turned into underscores — hyphens are NOT translated, so `service-account`
 * arrives as `INPUT_SERVICE-ACCOUNT`. action.yml declares them in exactly that
 * form.
 */
export function getInput(name: string): string {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
  return (process.env[key] ?? '').trim()
}

/**
 * Sets a step output.
 *
 * Uses the GITHUB_OUTPUT file with a UUID-delimited heredoc, which is the only
 * form that survives a multiline value. Falls back to the deprecated
 * `::set-output` when the variable is absent, so render-local.sh still shows
 * outputs outside a runner.
 */
export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT
  if (!file) {
    issue(`set-output name=${name}`, value)
    return
  }
  const delimiter = `ghadelimiter_${randomUUID()}`
  if (name.includes(delimiter) || value.includes(delimiter)) {
    throw new Error('output value contains the generated delimiter')
  }
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, 'utf8')
}

export function info(message: string): void {
  process.stdout.write(`${message}\n`)
}

export function warning(message: string): void {
  issue('warning', message)
}

export function error(message: string): void {
  issue('error', message)
}

export function startGroup(name: string): void {
  issue('group', name)
}

export function endGroup(): void {
  issue('endgroup')
}

/** Marks the step failed. Sets the exit code rather than calling process.exit, so buffered stdout still flushes. */
export function setFailed(message: string): void {
  error(message)
  process.exitCode = 1
}
