import { timingSafeEqual } from 'node:crypto'
import { isAbsolute, resolve as resolvePath } from 'node:path'

/** URL scheme registered by the app: `tinkerbox://open?cwd=<base64 path>`. */
export const PROTOCOL = 'tinkerbox'

/**
 * Decode standard or URL-safe base64 (padding optional). URLSearchParams turns `+` into spaces, so spaces are
 * mapped back. Returns null for anything that is not clean base64 or not valid UTF-8.
 */
export function decodeBase64Param(value: string): string | null {
  // Map spaces back to '+' *before* trimming: a trailing '+' arrives as a trailing space.
  let b64 = value.replace(/ /g, '+').trim().replace(/-/g, '+').replace(/_/g, '/')
  if (b64 === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null
  b64 = b64.replace(/=+$/, '')
  if (b64.length % 4 === 1) return null
  b64 += '='.repeat((4 - (b64.length % 4)) % 4)
  const bytes = Buffer.from(b64, 'base64')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Not UTF-8 → not a path we produced.
    return null
  }
}

export function encodeBase64UrlParam(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Build the deep link the CLI helper opens. */
export function buildOpenUrl(path: string): string {
  return `${PROTOCOL}://open?cwd=${encodeBase64UrlParam(path)}`
}

/** Shape of the secret the installed CLI helper appends to its links (`&token=…`). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/

export interface DeepLink {
  path: string
  /** `token` parameter (present when the installed CLI helper built the link). */
  token?: string
}

/**
 * Parse `tinkerbox://open?cwd=<base64>[&token=…]` (also `tinkerbox:open?…` and `tinkerbox:///open?…`). Returns the
 * absolute path to open, or null for anything else.
 *
 * Network locations (`\\server\share`, `//server/share`) are refused: any web page can trigger a deep link, and
 * merely touching such a path makes Windows connect (and authenticate) to the remote host.
 */
export function parseDeepLink(url: string): DeepLink | null {
  if (typeof url !== 'string' || url.length > 16_384) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${PROTOCOL}:`) return null
  const action = (parsed.host || parsed.pathname.replace(/^\/+/, '')).split('/')[0].toLowerCase()
  if (action !== 'open') return null
  const cwd = parsed.searchParams.get('cwd')
  if (!cwd) return null
  const path = decodeBase64Param(cwd)
  if (!path || path.includes('\0') || isNetworkPath(path) || !isAbsoluteAnyPlatform(path)) return null
  const token = parsed.searchParams.get('token')
  return token && TOKEN_PATTERN.test(token) ? { path, token } : { path }
}

function isAbsoluteAnyPlatform(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)
}

/** UNC / device paths (`\\server\share`, `//server/share`, `\\?\…`): two leading separators of either kind. */
function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
}

export interface OpenTarget {
  /** Absolute path from a path argument or a deep link; existence is checked by the caller. */
  path: string
  /**
   * 'argv': a path the local user handed over (command line, Finder / dock `open-file`, Open Recent).
   * 'url': a tinkerbox:// deep link, which any web page or program can trigger.
   */
  source: 'argv' | 'url'
  /** Token of a deep link (see {@link DeepLink.token}). */
  token?: string
}

/**
 * Whether opening `target` needs the user's explicit confirmation first. Opening a project folder loads and runs its
 * PHP code (Composer autoload, framework bootstrap, `.tinkerbox/drivers`), so a deep link, which anything can
 * trigger, is only trusted without asking when it carries the secret token of the installed CLI helper
 * (`cliToken`, null when no helper is installed).
 */
export function needsOpenConfirmation(target: OpenTarget, cliToken: string | null): boolean {
  if (target.source !== 'url') return false
  if (!cliToken || !target.token) return true
  const given = Buffer.from(target.token, 'utf8')
  const expected = Buffer.from(cliToken, 'utf8')
  return given.length !== expected.length || !timingSafeEqual(given, expected)
}

/**
 * Extract paths / deep links from a command line (first launch or `second-instance`).
 *
 * - argv[0] is the executable; when running unpackaged (`electron .`), argv[1] is the app path and skipped too.
 * - Switches (`--foo`, `-psn_…` from Finder) are ignored.
 * - Relative paths are resolved against `cwd` (the invoking shell's working directory for second instances).
 */
export function extractOpenTargets(argv: readonly string[], opts: { defaultApp: boolean; cwd: string }): OpenTarget[] {
  const args = argv.slice(1)
  const targets: OpenTarget[] = []
  // Unpackaged (`electron <app> …`) the first positional argument is the app itself. It is not always argv[1]:
  // Chromium moves switches in front of the positional arguments in the argv of 'second-instance'.
  let appPathSkipped = !opts.defaultApp
  for (const arg of args) {
    if (typeof arg !== 'string' || arg === '' || arg.startsWith('-')) continue
    if (!appPathSkipped) {
      appPathSkipped = true
      continue
    }
    if (arg.toLowerCase().startsWith(`${PROTOCOL}:`)) {
      const link = parseDeepLink(arg)
      if (link) targets.push({ ...link, source: 'url' })
      continue
    }
    // Other URL-ish arguments (e.g. file://) are not ours.
    if (/^[a-z][a-z0-9+.-]+:\/\//i.test(arg)) continue
    targets.push({ path: resolvePath(opts.cwd, arg), source: 'argv' })
  }
  return targets
}
