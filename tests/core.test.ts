/**
 * Tests for the hand-rolled runner protocol.
 *
 * This code replaced @actions/core, so it is on us to prove it speaks the
 * protocol correctly. A silent bug here means outputs never reach the workflow —
 * which looks like the action working, since the manifest is still written.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as core from '../src/core.js'

let out: string[]
const ENV_KEYS: string[] = []

beforeEach(() => {
  out = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const k of ENV_KEYS) delete process.env[k]
  ENV_KEYS.length = 0
  delete process.env.GITHUB_OUTPUT
  process.exitCode = 0
})

function setEnv(key: string, value: string) {
  process.env[key] = value
  ENV_KEYS.push(key)
}

describe('getInput', () => {
  it('reads INPUT_<UPPERCASE>', () => {
    setEnv('INPUT_NAME', 'core-api-prd')
    expect(core.getInput('name')).toBe('core-api-prd')
  })

  it('keeps hyphens, which the runner does NOT translate', () => {
    // The single most important detail: `service-account` becomes
    // INPUT_SERVICE-ACCOUNT, not INPUT_SERVICE_ACCOUNT. Getting this wrong makes
    // every hyphenated input silently empty.
    setEnv('INPUT_SERVICE-ACCOUNT', 'sa@p.iam.gserviceaccount.com')
    expect(core.getInput('service-account')).toBe('sa@p.iam.gserviceaccount.com')
  })

  it('turns spaces into underscores', () => {
    setEnv('INPUT_TWO_WORDS', 'x')
    expect(core.getInput('two words')).toBe('x')
  })

  it('trims, and returns empty for an unset input', () => {
    setEnv('INPUT_PADDED', '  value  ')
    expect(core.getInput('padded')).toBe('value')
    expect(core.getInput('never-set')).toBe('')
  })

  it('preserves inner newlines of a block input', () => {
    setEnv('INPUT_ENV-PLAIN', 'A=1\nB=2\n')
    expect(core.getInput('env-plain')).toBe('A=1\nB=2')
  })
})

describe('setOutput via GITHUB_OUTPUT', () => {
  it('writes a UUID-delimited heredoc', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gho-')), 'out')
    writeFileSync(file, '')
    setEnv('GITHUB_OUTPUT', file)

    core.setOutput('name', 'core-api-prd')
    const text = readFileSync(file, 'utf8')
    expect(text).toMatch(/^name<<ghadelimiter_[0-9a-f-]{36}\ncore-api-prd\nghadelimiter_[0-9a-f-]{36}\n$/)
  })

  it('survives a multiline value, which is why the heredoc form is used', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gho-')), 'out')
    writeFileSync(file, '')
    setEnv('GITHUB_OUTPUT', file)

    const json = '[\n  {"name": "A"},\n  {"name": "B"}\n]'
    core.setOutput('findings', json)
    const text = readFileSync(file, 'utf8')
    const delimiter = /findings<<(\S+)\n/.exec(text)![1]!
    const body = text.slice(text.indexOf('\n') + 1, text.lastIndexOf(`${delimiter}\n`) - 1)
    expect(body).toBe(json)
  })

  it('appends rather than overwriting, so multiple outputs coexist', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gho-')), 'out')
    writeFileSync(file, '')
    setEnv('GITHUB_OUTPUT', file)

    core.setOutput('a', '1')
    core.setOutput('b', '2')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('a<<')
    expect(text).toContain('b<<')
  })

  it('falls back to ::set-output outside a runner, so local runs show outputs', () => {
    core.setOutput('kind', 'service')
    expect(out.join('')).toBe('::set-output name=kind::service\n')
  })
})

describe('command escaping', () => {
  it('escapes newlines, so a multiline message cannot truncate the command', () => {
    core.warning('line one\nline two')
    expect(out.join('')).toBe('::warning::line one%0Aline two\n')
  })

  it('escapes % first, so an escape sequence is not double-decoded', () => {
    core.error('100% done')
    expect(out.join('')).toBe('::error::100%25 done\n')
  })

  it('escapes carriage returns', () => {
    core.warning('a\r\nb')
    expect(out.join('')).toBe('::warning::a%0D%0Ab\n')
  })
})

describe('groups and failure', () => {
  it('emits group and endgroup', () => {
    core.startGroup('Rendered manifest')
    core.info('body')
    core.endGroup()
    expect(out.join('')).toBe('::group::Rendered manifest\nbody\n::endgroup::\n')
  })

  it('setFailed emits an error and sets the exit code without exiting', () => {
    // process.exit would truncate buffered stdout, losing the summary and the
    // redacted manifest we just printed.
    core.setFailed('nope')
    expect(out.join('')).toBe('::error::nope\n')
    expect(process.exitCode).toBe(1)
  })

  it('info does not escape: it is plain log output, not a command', () => {
    core.info('100% and a\nnewline')
    expect(out.join('')).toBe('100% and a\nnewline\n')
  })
})
