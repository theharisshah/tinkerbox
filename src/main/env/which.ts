/**
 * Small, dependency-free helpers for locating executables and expanding user paths.
 */
import { accessSync, constants, openSync, readSync, closeSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Expand a leading `~` / `~/` (and `~\` on Windows) to the user's home directory. */
export function expandHome(path: string, home = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (path === '~') return home
  if (path.startsWith('~/') || (platform === 'win32' && path.startsWith('~\\'))) return join(home, path.slice(2))
  return path
}

/** Directories of the current PATH (deduplicated, empty entries removed). */
export function pathDirectories(pathValue = process.env.PATH ?? process.env.Path ?? ''): string[] {
  return [...new Set(pathValue.split(delimiter).map((d) => d.trim()).filter(Boolean))]
}

/** True when `path` is an existing regular file that the current user may execute (any file on Windows). */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function windowsExtensions(): string[] {
  const pathext = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase())
  return ['', ...pathext.filter(Boolean)]
}

/**
 * Locate an executable by name on PATH (plus `extraDirs`, searched after PATH). Names containing a path
 * separator are checked directly. Returns the absolute path or null.
 */
export function findExecutable(name: string, extraDirs: string[] = []): string | null {
  if (!name) return null
  const exts = process.platform === 'win32' ? windowsExtensions() : ['']
  if (isAbsolute(name) || name.includes('/') || (process.platform === 'win32' && name.includes('\\'))) {
    const expanded = expandHome(name)
    for (const ext of exts) if (isExecutableFile(expanded + ext)) return expanded + ext
    return null
  }
  for (const dir of [...pathDirectories(), ...extraDirs]) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/** Read the first bytes of a file ('' when unreadable). */
export function readFileHead(path: string, bytes = 256): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Whether a file is a PHP script (composer proxies, .phar) that should be run through an explicit
 * PHP binary instead of relying on its `#!/usr/bin/env php` shebang (GUI apps often lack `php` on PATH).
 */
export function isPhpScript(path: string): boolean {
  if (/\.phar$/i.test(path) || /\.php$/i.test(path)) return true
  const head = readFileHead(path, 256)
  if (head.startsWith('<?php')) return true
  if (head.startsWith('#!')) {
    const firstLine = head.split('\n', 1)[0]
    return /\bphp[\d.]*\b/.test(firstLine)
  }
  return false
}
