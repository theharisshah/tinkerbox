import { formatWithCursor } from 'prettier/standalone'
import phpPlugin from '@prettier/plugin-php/standalone'
import { maskPhp } from './phpScan'

/**
 * Prettier PHP for editor code without an open tag: the code is wrapped in `<?php\n`, formatted and unwrapped.
 * Code whose last statement lacks a semicolon (allowed by the runner) is formatted with a temporary `;`.
 */

export interface PrettifyOptions {
  quoteStyle: 'single' | 'double'
  tabSize: number
  /** PHP version of the connection ("8.3.12"); controls version dependent output. */
  phpVersion?: string | null
  printWidth?: number
}

export interface PrettifyResult {
  code: string
  /** Cursor offset in the formatted code. */
  cursorOffset: number
}

const SUPPORTED = [7.0, 7.1, 7.2, 7.3, 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, 8.5]
const DEFAULT_PHP_VERSION = '8.0'

/**
 * Prettier's `phpVersion` for a PHP version string: major.minor clamped to the supported range. Unknown versions
 * use 8.0 (conservative: newer syntax such as PHP 8.4 `new Foo()->bar()` is never produced).
 * Never "auto" / "composer": those read composer.json from disk, which the renderer cannot do.
 */
export function prettierPhpVersion(version: string | null | undefined): string {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '')
  if (!m) return DEFAULT_PHP_VERSION
  const value = Number(`${m[1]}.${m[2]}`)
  if (!Number.isFinite(value)) return DEFAULT_PHP_VERSION
  const clamped = Math.min(Math.max(value, SUPPORTED[0]), SUPPORTED[SUPPORTED.length - 1])
  const best = SUPPORTED.filter((v) => v <= clamped).pop() ?? SUPPORTED[0]
  return best.toFixed(1)
}

/** Error with the editor line (the wrapper's `<?php` line removed from Prettier's message). */
export class PrettifyError extends Error {
  line?: number
  constructor(message: string, line?: number) {
    super(message)
    this.name = 'PrettifyError'
    this.line = line
  }
}

const OPEN_TAG = /^\s*<\?(?:php\b)?/

/** Offset right after the last code character (comments / whitespace excluded), or -1 for no code. */
function lastCodeOffset(code: string): number {
  const masked = maskPhp(code)
  for (let i = masked.length - 1; i >= 0; i--) {
    if (!/\s/.test(masked[i])) return i + 1
  }
  return -1
}

/** Insert a `;` after the last statement when it has none. Returns null when not needed. */
export function withTrailingSemicolon(code: string): { code: string; offset: number } | null {
  const end = lastCodeOffset(code)
  if (end < 0) return null
  const last = maskPhp(code)[end - 1]
  if (last === ';' || last === '}' || last === ':' || last === '{') return null
  return { code: `${code.slice(0, end)};${code.slice(end)}`, offset: end }
}

function removeLastSemicolon(code: string, cursor: number): { code: string; cursor: number } {
  const end = lastCodeOffset(code)
  if (end > 0 && maskPhp(code)[end - 1] === ';') {
    const at = end - 1
    return { code: code.slice(0, at) + code.slice(end), cursor: cursor > at ? cursor - 1 : cursor }
  }
  return { code, cursor }
}

interface PrettierLoc {
  start?: { line?: number; column?: number }
}

function errorLine(err: unknown): number | undefined {
  const loc = (err as { loc?: PrettierLoc } | null)?.loc
  return typeof loc?.start?.line === 'number' ? loc.start.line : undefined
}

async function runPrettier(source: string, cursorOffset: number, options: PrettifyOptions): Promise<{ formatted: string; cursorOffset: number }> {
  return formatWithCursor(source, {
    parser: 'php',
    plugins: [phpPlugin],
    cursorOffset: Math.max(0, Math.min(cursorOffset, source.length)),
    singleQuote: options.quoteStyle === 'single',
    tabWidth: Math.max(1, Math.min(16, Math.round(options.tabSize || 4))),
    useTabs: false,
    printWidth: options.printWidth ?? 80,
    trailingCommaPHP: false,
    braceStyle: 'per-cs',
    phpVersion: prettierPhpVersion(options.phpVersion)
  })
}

/** Format editor code. Throws PrettifyError (with the editor line) on syntax errors. */
export async function prettifyPhp(code: string, cursorOffset: number, options: PrettifyOptions): Promise<PrettifyResult> {
  if (code.trim() === '') return { code, cursorOffset }
  const hasOpenTag = OPEN_TAG.test(code)
  const prefix = hasOpenTag ? '' : '<?php\n'

  const attempt = async (source: string, cursor: number): Promise<{ formatted: string; cursorOffset: number }> =>
    runPrettier(prefix + source, cursor + prefix.length, options)

  let result: { formatted: string; cursorOffset: number }
  let addedSemicolon = false
  try {
    result = await attempt(code, cursorOffset)
  } catch (err) {
    const patched = withTrailingSemicolon(code)
    if (!patched) throw toPrettifyError(err, prefix)
    try {
      result = await attempt(patched.code, cursorOffset > patched.offset ? cursorOffset + 1 : cursorOffset)
      addedSemicolon = true
    } catch {
      throw toPrettifyError(err, prefix)
    }
  }

  let out = result.formatted
  let cursor = result.cursorOffset
  if (!hasOpenTag) {
    const m = /^<\?php[ \t]*\r?\n(?:[ \t]*\r?\n)*/.exec(out)
    if (m) {
      out = out.slice(m[0].length)
      cursor = Math.max(0, cursor - m[0].length)
    }
  }
  if (addedSemicolon) {
    const stripped = removeLastSemicolon(out, cursor)
    out = stripped.code
    cursor = stripped.cursor
  }
  if (!/\n$/.test(code)) {
    const trimmed = out.replace(/\s+$/, '')
    cursor = Math.min(cursor, trimmed.length)
    out = trimmed
  }
  return { code: out, cursorOffset: Math.max(0, Math.min(cursor, out.length)) }
}

function toPrettifyError(err: unknown, prefix: string): PrettifyError {
  const raw = err instanceof Error ? err.message : String(err)
  const shift = prefix ? 1 : 0
  let line = errorLine(err)
  if (line !== undefined) line = Math.max(1, line - shift)
  const message = raw
    .split('\n')[0]
    .replace(/\s*\(\d+:\d+\)\s*$/, '')
    .replace(/on line (\d+)/i, (_, n: string) => `on line ${Math.max(1, Number(n) - shift)}`)
  return new PrettifyError(line !== undefined && !/on line \d+/i.test(message) ? `${message} (line ${line})` : message, line)
}

/** Smallest single replacement turning `before` into `after` (common prefix / suffix removed); null when equal. */
export function minimalEdit(before: string, after: string): { start: number; end: number; text: string } | null {
  if (before === after) return null
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore--
    endAfter--
  }
  return { start, end: endBefore, text: after.slice(start, endAfter) }
}
