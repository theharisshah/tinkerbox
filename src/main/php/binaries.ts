/**
 * PHP binary discovery, inspection and resolution (Settings → PHP binary, footer → PHP Settings).
 *
 * Discovery order (also the preference for `phpBinary: 'auto'` after Herd's default):
 * Herd (php85 … php74 aliases), Homebrew (incl. versioned php@X kegs, also used by Valet), MAMP, XAMPP,
 * Laragon / WAMP (Windows), system locations and finally every `php` on PATH. Results are deduplicated
 * by realpath and validated by actually running each binary. Detection results are cached for 60 s.
 */
import { readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Connection, PhpBinary, Settings } from '@shared/types'
import { expandHome, findExecutable, isExecutableFile, pathDirectories } from '../env/which'
import { runCapture } from '../execution/process'
import { herdAliases, herdAliasPath, herdDefaultPhp, herdIniEnv, herdPaths, isHerdAlias, isHerdBinary } from './herd'

const CACHE_TTL_MS = 60_000

export interface PhpCandidate {
  path: string
  source: string
  alias?: string
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Sort directory names containing versions (php8.3.1, php@8.2, php-8.1.2-Win32) newest first. */
function byVersionDesc(names: string[]): string[] {
  const key = (name: string): number[] => (name.match(/\d+/g) ?? []).map(Number)
  return [...names].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (kb[i] ?? -1) - (ka[i] ?? -1)
      if (d !== 0) return d
    }
    return a.localeCompare(b)
  })
}

/** Children of `parent` matching `pattern`, joined with `suffix`, newest version first. */
function versionedChildren(parent: string, pattern: RegExp, ...suffix: string[]): string[] {
  return byVersionDesc(listDir(parent).filter((n) => pattern.test(n))).map((n) => join(parent, n, ...suffix))
}

/** Where a binary comes from, for the UI label. */
export function phpBinarySource(path: string): string {
  if (isHerdBinary(path)) return 'Herd'
  let real = path
  try {
    real = realpathSync(path)
  } catch {
    /* keep the given path */
  }
  const p = real.replace(/\\/g, '/').toLowerCase()
  if (p.includes('/homebrew/') || p.includes('/cellar/') || p.includes('/linuxbrew/') || p.startsWith('/usr/local/opt/')) return 'Homebrew'
  if (p.includes('/mamp/')) return 'MAMP'
  if (p.includes('/xampp') || p.includes('/lampp/')) return 'XAMPP'
  if (p.includes('/laragon/')) return 'Laragon'
  if (p.includes('/wamp')) return 'WAMP'
  if (p.startsWith('/usr/bin/') || p.startsWith('/bin/') || p.startsWith('/usr/local/bin/')) return 'System'
  return 'PATH'
}

/** Platform-specific candidate list (existence checked, not yet validated), in preference order. */
export function phpBinaryCandidates(): PhpCandidate[] {
  const out: PhpCandidate[] = []
  const add = (path: string, source: string, alias?: string): void => {
    if (isExecutableFile(path)) out.push(alias ? { path, source, alias } : { path, source })
  }
  const home = homedir()

  // Laravel Herd: every alias (php85 … php74); the default `php` symlink dedupes onto its alias.
  for (const { alias, path } of herdAliases()) add(path, 'Herd', alias)
  const herdDefault = herdDefaultPhp()
  if (herdDefault) add(herdDefault, 'Herd')

  if (process.platform === 'win32') {
    for (const p of versionedChildren('C:\\laragon\\bin\\php', /^php/i, 'php.exe')) add(p, 'Laragon')
    add('C:\\xampp\\php\\php.exe', 'XAMPP')
    for (const root of ['C:\\wamp64\\bin\\php', 'C:\\wamp\\bin\\php']) {
      for (const p of versionedChildren(root, /^php/i, 'php.exe')) add(p, 'WAMP')
    }
    add('C:\\php\\php.exe', 'System')
    for (const p of versionedChildren('C:\\tools', /^php/i, 'php.exe')) add(p, 'System')
  } else {
    // Homebrew (Apple Silicon + Intel + Linuxbrew); Valet uses these too.
    for (const prefix of ['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew']) {
      add(join(prefix, 'bin', 'php'), 'Homebrew')
      for (const p of versionedChildren(join(prefix, 'opt'), /^php(@\d+(\.\d+)?)?$/, 'bin', 'php')) add(p, 'Homebrew')
    }
    if (process.platform === 'darwin') {
      for (const p of versionedChildren('/Applications/MAMP/bin/php', /^php\d/, 'bin', 'php')) add(p, 'MAMP')
      add('/Applications/XAMPP/xamppfiles/bin/php', 'XAMPP')
    } else {
      add('/opt/lampp/bin/php', 'XAMPP')
    }
    // System PHP (Debian/Ubuntu alternatives install php8.3 etc. next to php).
    add('/usr/bin/php', 'System')
    for (const name of byVersionDesc(listDir('/usr/bin').filter((n) => /^php\d+(\.\d+)?$/.test(n)))) add(join('/usr/bin', name), 'System')
    add('/usr/local/bin/php', 'System')
    add(join(home, '.config', 'valet', 'bin', 'php'), 'Valet')
  }

  // Every php on PATH (including versioned names like php8.2 / php83).
  const exe = process.platform === 'win32' ? /^php(\d+(\.\d+)?)?\.exe$/i : /^php(\d+(\.\d+)?)?$/
  for (const dir of pathDirectories()) {
    for (const name of byVersionDesc(listDir(dir).filter((n) => exe.test(n)))) {
      const path = join(dir, name)
      add(path, phpBinarySource(path), isHerdAlias(name) && isHerdBinary(path) ? name : undefined)
    }
  }
  return out
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Environment for spawning a PHP binary (Herd per-version ini directories added). */
export function phpEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...herdIniEnv(), ...extra }
}

/** Run a binary to confirm it is a working PHP CLI; returns version info or null. */
export async function validatePhpBinary(candidate: PhpCandidate): Promise<PhpBinary | null> {
  const env = phpEnvironment()
  try {
    const [info, version] = await Promise.all([
      runCapture(candidate.path, ['-d', 'xdebug.mode=off', '-r', 'echo PHP_VERSION, PHP_EOL, PHP_BINARY;'], {
        env,
        timeoutMs: 10_000,
        label: candidate.path
      }),
      runCapture(candidate.path, ['-d', 'xdebug.mode=off', '-v'], { env, timeoutMs: 10_000, label: candidate.path, allowFailure: true })
    ])
    // Startup warnings may precede the output; the last two lines are ours.
    const lines = info.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const ver = lines.length >= 2 ? lines[lines.length - 2] : (lines[0] ?? '')
    const m = /^(\d+\.\d+\.\d+)\S*/.exec(ver)
    if (!m) return null
    const versionLine =
      version.stdout.split(/\r?\n/).find((l) => /^PHP \d/.test(l.trim()))?.trim() ?? `PHP ${ver}`
    const result: PhpBinary = { path: candidate.path, version: ver, versionLine, source: candidate.source }
    if (candidate.alias) result.alias = candidate.alias
    return result
  } catch {
    return null
  }
}

let discoveryCache: { at: number; promise: Promise<PhpBinary[]> } | null = null
const inspectCache = new Map<string, { at: number; promise: Promise<PhpBinary | null> }>()

/** All working PHP binaries on this machine, deduplicated by realpath, in preference order. */
export function findPhpBinaries(options: { force?: boolean } = {}): Promise<PhpBinary[]> {
  if (!options.force && discoveryCache && Date.now() - discoveryCache.at < CACHE_TTL_MS) return discoveryCache.promise
  const promise = (async () => {
    const seen = new Set<string>()
    const unique: PhpCandidate[] = []
    for (const candidate of phpBinaryCandidates()) {
      const real = realpathOrSelf(candidate.path)
      if (seen.has(real)) continue
      seen.add(real)
      unique.push(candidate)
    }
    const validated = await Promise.all(unique.map((c) => validatePhpBinary(c)))
    return validated.filter((b): b is PhpBinary => b !== null)
  })()
  discoveryCache = { at: Date.now(), promise }
  promise.catch(() => {
    if (discoveryCache?.promise === promise) discoveryCache = null
  })
  return promise
}

/**
 * Turn a configured value into an absolute executable path: a Herd alias (`php83`), a bare command name
 * (`php8.2`, searched on PATH) or a path (`~` expanded). Null when nothing executable matches.
 */
export function locatePhpBinary(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isHerdAlias(trimmed)) return herdAliasPath(trimmed) ?? findExecutable(trimmed)
  if (/[\\/]/.test(trimmed) || trimmed.startsWith('~')) {
    const expanded = expandHome(trimmed)
    return isExecutableFile(expanded) ? expanded : null
  }
  return findExecutable(trimmed)
}

/** Validate a binary path or Herd alias; null when it is not a working PHP CLI. */
/**
 * Inspect a binary (path, command name or Herd alias). `auto` inspects whatever automatic detection currently
 * runs (see resolveAutoPhp), so the UI can show the real version instead of guessing.
 */
export function inspectPhpBinary(binary: string): Promise<PhpBinary | null> {
  const key = binary.trim()
  const cached = inspectCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.promise
  const promise = (async () => {
    const path = key.toLowerCase() === 'auto' ? await resolveAutoPhp() : locatePhpBinary(key)
    if (!path) return null
    const alias = isHerdAlias(key) && isHerdBinary(path) ? key : undefined
    return validatePhpBinary(alias ? { path, source: 'Herd', alias } : { path, source: phpBinarySource(path) })
  })()
  inspectCache.set(key, { at: Date.now(), promise })
  return promise
}

/** What `phpBinary: 'auto'` runs: Herd's default PHP, else the first discovered binary, else `php` on PATH. */
export async function resolveAutoPhp(): Promise<string | null> {
  const herd = herdDefaultPhp()
  if (herd) return herd
  const found = await findPhpBinaries()
  if (found.length > 0) return found[0].path
  return findExecutable('php')
}

export function clearPhpBinaryCaches(): void {
  discoveryCache = null
  inspectCache.clear()
}

/**
 * The PHP binary to run for a connection: the local connection's override, else the global setting.
 * `auto` → Herd's default PHP, else the first discovered binary. The returned env carries Herd's
 * per-version ini scan directories (harmless for non-Herd binaries).
 */
export async function resolvePhpBinary(settings: Settings, connection?: Connection): Promise<{ path: string; env: Record<string, string> }> {
  const override = connection && connection.type === 'local' ? connection.phpBinary?.trim() : ''
  const requested = override || settings.phpBinary?.trim() || 'auto'
  const env = herdIniEnv()
  if (requested === 'auto') {
    const auto = await resolveAutoPhp()
    if (auto) return { path: auto, env }
    throw new Error(
      'PHP binary not found: no PHP installation was detected. Install PHP (for example Laravel Herd) or choose a PHP binary in Settings → General.'
    )
  }
  const path = locatePhpBinary(requested)
  if (!path) {
    const hint = isHerdAlias(requested) && !herdPaths() ? ' (Herd aliases need Laravel Herd)' : ''
    throw new Error(`PHP binary not found: ${requested}${hint}`)
  }
  return { path, env }
}
