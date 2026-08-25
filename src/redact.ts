/**
 * Redacted view of a manifest, for printing.
 *
 * Printing a rendered manifest is genuinely useful for debugging a deploy, and
 * it is also how credentials end up in an Actions log: any value interpolated as
 * a plain `env[].value` is right there in the output. Redacting by default keeps
 * the useful half.
 */

/** Replaces every `value:` payload while leaving structure readable. */
export function redactManifest(yamlText: string): string {
  return yamlText.replace(/^(\s*value:\s).*$/gm, '$1"<redacted>"')
}

/**
 * True if `text` leaks any of `secrets`.
 *
 * Used by the tests to assert that nothing we print carries a real value. Short
 * strings are skipped: a 3-character "secret" would match by coincidence and
 * make the assertion useless.
 */
export function leaks(text: string, secrets: readonly string[]): string[] {
  return secrets.filter((s) => s.length >= 8 && text.includes(s))
}
