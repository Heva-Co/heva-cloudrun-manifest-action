/**
 * Job summary and log annotations.
 *
 * Only NAMES and detector types are ever written here. The manifest itself is
 * printed redacted, and no code path emits a secret value.
 */
import type { Finding } from './scan.js'

export function findingsTable(findings: Finding[]): string {
  if (findings.length === 0) return '_No plaintext secrets detected._\n'
  const rows = findings
    .map((f) => `| \`${f.name}\` | ${f.detector} | ${f.source === 'name' ? 'name heuristic' : 'entropy'} |`)
    .join('\n')
  return ['| Env var | Detector | Signal |', '| --- | --- | --- |', rows, ''].join('\n')
}

export function summaryMarkdown(opts: {
  kind: string
  name: string
  region: string
  environment: string
  manifestPath: string
  findings: Finding[]
  mode: string
  note?: string
}): string {
  const lines = [
    `## Cloud Run manifest: \`${opts.name}\``,
    '',
    `| | |`,
    `| --- | --- |`,
    `| Kind | ${opts.kind} |`,
    `| Region | ${opts.region} |`,
    `| Environment | ${opts.environment} |`,
    `| Output | \`${opts.manifestPath}\` |`,
    '',
    `### Secret scan (\`${opts.mode}\`)`,
    '',
    findingsTable(opts.findings),
  ]
  if (opts.note) lines.push('', `> ${opts.note}`)
  return lines.join('\n')
}
