/**
 * Laravel Herd integration (macOS + Windows): PHP binaries and aliases (php74 … php85), the per-version
 * php.ini scan directories Herd normally injects through the user's shell profile
 * (`HERD_PHP_83_INI_SCAN_DIR=…/Herd/config/php/83/`), bundled Xdebug extensions and the Valet config.
 *
 * Layout (macOS):  ~/Library/Application Support/Herd/{bin/php83, bin/php -> php83, config/php/83/php.ini,
 *                  config/valet/config.json}, /Applications/Herd.app/Contents/Resources/xdebug/xdebug-83-arm64.so
 * Layout (Windows): %USERPROFILE%\.config\herd\{bin\php83\php.exe, bin\php.bat, config\valet\config.json}
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { HerdSite } from '@shared/types'
import { isExecutableFile } from '../env/which'

export interface HerdPaths {
  root: string
  bin: string
  /** Per-version ini directories (`<configPhp>/83/php.ini`). */
  configPhp: string
  /** Valet-compatible configuration directory (config.json, Nginx/, Certificates/, Sites/). */
  valet: string
  /** Herd.app resources (macOS) used for bundled Xdebug builds; null elsewhere. */
  appResources: string | null
}

export function herdPaths(home = homedir(), platform: NodeJS.Platform = process.platform): HerdPaths | null {
  if (platform === 'darwin') {
    const root = join(home, 'Library', 'Application Support', 'Herd')
    return {
      root,
      bin: join(root, 'bin'),
      configPhp: join(root, 'config', 'php'),
      valet: join(root, 'config', 'valet'),
      appResources: '/Applications/Herd.app/Contents/Resources'
    }
  }
  if (platform === 'win32') {
    const root = join(home, '.config', 'herd')
    return {
      root,
      bin: join(root, 'bin'),
      configPhp: join(root, 'config', 'php'),
      valet: join(root, 'config', 'valet'),
      appResources: null
    }
  }
  return null
}

const ALIAS_RE = /^php(\d)(\d{1,2})$/

/** `php83` → `8.3`; null when not a Herd-style alias. */
export function aliasToVersion(alias: string): string | null {
  const m = ALIAS_RE.exec(alias)
  return m ? `${m[1]}.${m[2]}` : null
}

export function isHerdAlias(value: string): boolean {
  return ALIAS_RE.test(value)
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Absolute binary for a Herd alias (`php83`) or null when Herd does not provide it. */
export function herdAliasPath(alias: string, paths = herdPaths()): string | null {
  if (!paths || !isHerdAlias(alias)) return null
  const candidate = process.platform === 'win32' ? join(paths.bin, alias, 'php.exe') : join(paths.bin, alias)
  return isExecutableFile(candidate) ? candidate : null
}

/** Every PHP alias Herd provides, newest version first. */
export function herdAliases(paths = herdPaths()): Array<{ alias: string; path: string }> {
  if (!paths) return []
  const out: Array<{ alias: string; path: string }> = []
  for (const entry of safeReaddir(paths.bin)) {
    if (!isHerdAlias(entry)) continue
    const path = herdAliasPath(entry, paths)
    if (path) out.push({ alias: entry, path })
  }
  return out.sort((a, b) => compareVersions(aliasToVersion(b.alias) ?? '0', aliasToVersion(a.alias) ?? '0'))
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Herd's globally selected PHP: `bin/php` (a symlink to e.g. php83) on macOS; on Windows the version
 * referenced by `bin/php.bat` (or the newest alias). Null when Herd is not installed.
 */
export function herdDefaultPhp(paths = herdPaths()): string | null {
  if (!paths) return null
  if (process.platform === 'win32') {
    try {
      const bat = readFileSync(join(paths.bin, 'php.bat'), 'utf8')
      const m = /(php\d{2,3})[\\/]+php\.exe/i.exec(bat)
      if (m) {
        const path = herdAliasPath(m[1].toLowerCase(), paths)
        if (path) return path
      }
    } catch {
      /* no php.bat: fall back to the newest alias */
    }
    return herdAliases(paths)[0]?.path ?? null
  }
  const php = join(paths.bin, 'php')
  return isExecutableFile(php) ? php : (herdAliases(paths)[0]?.path ?? null)
}

/** Whether a binary lives in Herd's bin directory (directly or through a symlink). */
export function isHerdBinary(binaryPath: string, paths = herdPaths()): boolean {
  if (!paths) return false
  const bin = paths.bin.replace(/[\\/]+$/, '')
  const inside = (p: string): boolean => p === bin || p.startsWith(bin + '/') || p.startsWith(bin + '\\')
  if (inside(binaryPath)) return true
  try {
    return inside(realpathSync(binaryPath))
  } catch {
    return false
  }
}

/** Herd version digits of a binary (`…/Herd/bin/php` → `83`), following symlinks. */
export function herdVersionDigits(binaryPath: string, paths = herdPaths()): string | null {
  if (!isHerdBinary(binaryPath, paths)) return null
  const names = [binaryPath]
  try {
    names.push(realpathSync(binaryPath))
  } catch {
    /* dangling symlink */
  }
  for (const name of names) {
    // macOS: …/bin/php83 ; Windows: …\bin\php83\php.exe
    const base = basename(name).toLowerCase() === 'php.exe' ? basename(join(name, '..')) : basename(name)
    const m = ALIAS_RE.exec(base.toLowerCase())
    if (m) return `${m[1]}${m[2]}`
  }
  return null
}

/**
 * Environment variables Herd normally exports from the shell profile so its PHP builds load the
 * per-version php.ini (`HERD_PHP_83_INI_SCAN_DIR`). GUI apps launched from Finder do not inherit them.
 * Existing values in `baseEnv` win.
 */
export function herdIniEnv(paths = herdPaths(), baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  if (!paths || process.platform !== 'darwin') return env
  for (const entry of safeReaddir(paths.configPhp)) {
    if (!/^\d{2,3}$/.test(entry)) continue
    const dir = join(paths.configPhp, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const key = `HERD_PHP_${entry}_INI_SCAN_DIR`
    if (baseEnv[key]) continue
    env[key] = dir.endsWith('/') ? dir : `${dir}/`
  }
  return env
}

/**
 * Xdebug extension bundled with Herd for a PHP version, only when the version's php.ini does not already
 * load Xdebug (Herd Pro enables it per version). Used for the per-tab debugging toggle.
 */
export function herdXdebugExtension(versionDigits: string, paths = herdPaths()): string | null {
  if (!paths?.appResources) return null
  try {
    const ini = readFileSync(join(paths.configPhp, versionDigits, 'php.ini'), 'utf8')
    if (/^\s*zend_extension\s*=.*xdebug/im.test(ini)) return null
  } catch {
    /* no ini: Herd does not load Xdebug for this version */
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86'
  const so = join(paths.appResources, 'xdebug', `xdebug-${versionDigits}-${arch}.so`)
  return existsSync(so) ? so : null
}

// ---------------------------------------------------------------------------------------------
// Sites (Get started tab, Open Anything)
// ---------------------------------------------------------------------------------------------

interface ValetConfig {
  tld?: unknown
  paths?: unknown
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** `8.3` from an isolated site's nginx config (`$herd_sock_83` / `herd83.sock`); undefined = global PHP. */
export function phpVersionFromNginx(config: string): string | undefined {
  const m = /herd_sock_(\d)(\d{1,2})\b/.exec(config) ?? /herd(\d)(\d{1,2})\.sock/.exec(config)
  return m ? `${m[1]}.${m[2]}` : undefined
}

/**
 * Sites served by Herd: every folder inside the parked paths of Herd's Valet config plus linked sites
 * (symlinks in `config/valet/Sites`, which win over parked folders of the same name). URLs use the
 * configured TLD and https when the site is secured; isolated sites report their PHP version.
 */
export async function listHerdSites(paths = herdPaths()): Promise<HerdSite[]> {
  if (!paths) return []
  const raw = await readText(join(paths.valet, 'config.json'))
  if (raw === null) return []
  let config: ValetConfig
  try {
    config = JSON.parse(raw) as ValetConfig
  } catch {
    return [] // corrupted Herd config: nothing to offer, Herd itself will complain
  }
  const tld = typeof config.tld === 'string' && config.tld.trim() ? config.tld.trim() : 'test'
  const sitesDir = join(paths.valet, 'Sites')
  const parked = Array.isArray(config.paths) ? config.paths.filter((p): p is string => typeof p === 'string') : []
  const found = new Map<string, string>()

  for (const dir of parked) {
    if (resolve(dir) === resolve(sitesDir)) continue
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue // parked folder was removed
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (await isDir(full)) found.set(entry, full)
    }
  }
  let links: string[] = []
  try {
    links = await readdir(sitesDir)
  } catch {
    links = []
  }
  for (const entry of links) {
    if (entry.startsWith('.')) continue
    const full = join(sitesDir, entry)
    if (!(await isDir(full))) continue
    try {
      found.set(entry, await realpath(full))
    } catch {
      found.set(entry, full)
    }
  }

  const sites: HerdSite[] = []
  for (const [name, path] of found) {
    const host = `${name.toLowerCase()}.${tld}`
    const nginx = (await readText(join(paths.valet, 'Nginx', host))) ?? ''
    const secure = existsSync(join(paths.valet, 'Certificates', `${host}.crt`)) || /listen\s+[^;]*443/.test(nginx)
    const site: HerdSite = { name, path, url: `${secure ? 'https' : 'http'}://${host}` }
    const phpVersion = phpVersionFromNginx(nginx)
    if (phpVersion) site.phpVersion = phpVersion
    sites.push(site)
  }
  return sites.sort((a, b) => a.name.localeCompare(b.name))
}
