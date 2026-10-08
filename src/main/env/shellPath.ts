/**
 * GUI apps on macOS (and some Linux desktops) start with launchd's minimal PATH, so `php`, `composer`
 * or other tools installed via Herd / Homebrew / profile scripts are invisible.
 * `loadShellPath()` asks the user's login shell for its PATH (once) and merges it into process.env.PATH.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const START = '__TINKERBOX_PATH_START__'
const END = '__TINKERBOX_PATH_END__'
const TIMEOUT_MS = 3000

let loading: Promise<void> | null = null

/** Merge PATH strings: entries of `preferred` first, then the rest, without duplicates or empty entries. */
export function mergePathValues(preferred: string, existing: string, sep = delimiter): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of [...preferred.split(sep), ...existing.split(sep)]) {
    const dir = entry.trim()
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out.join(sep)
}

/** Extract the PATH printed between the markers (rc files may print banners around it). */
export function extractMarkedPath(output: string): string | null {
  const s = output.lastIndexOf(START)
  if (s === -1) return null
  const e = output.indexOf(END, s + START.length)
  if (e === -1) return null
  const value = output.slice(s + START.length, e).trim()
  return value || null
}

/** Well-known bin directories that are appended when they exist (covers shells that time out). */
export function wellKnownBinDirs(home = homedir()): string[] {
  if (process.platform === 'win32') return []
  const dirs = [
    join(home, 'Library', 'Application Support', 'Herd', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.composer', 'vendor', 'bin'),
    join(home, '.config', 'composer', 'vendor', 'bin'),
    '/home/linuxbrew/.linuxbrew/bin',
    join(home, '.local', 'bin')
  ]
  return dirs.filter((d) => existsSync(d))
}

function readLoginShellPath(): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
    let output = ''
    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ['-ilc', `printf '%s' "${START}$PATH${END}"`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
        env: {
          ...process.env,
          // Keep oh-my-zsh & friends from prompting or auto-updating in the background shell.
          DISABLE_AUTO_UPDATE: 'true',
          ZSH_TMUX_AUTOSTARTED: 'true',
          ZSH_TMUX_AUTOSTART: 'false'
        }
      })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already exited */
      }
      finish(extractMarkedPath(output))
    }, TIMEOUT_MS)
    child.stdout?.on('data', (buf: Buffer) => {
      output += buf.toString('utf8')
    })
    child.on('error', () => finish(null))
    child.on('close', () => finish(extractMarkedPath(output)))
  })
}

/**
 * Merge the login shell's PATH (and well-known tool directories) into process.env.PATH. Runs once;
 * later calls return the same promise. No-op on Windows, where GUI apps inherit the user PATH.
 */
export function loadShellPath(): Promise<void> {
  if (loading) return loading
  loading = (async () => {
    if (process.platform === 'win32') return
    const current = process.env.PATH ?? ''
    const shellPath = await readLoginShellPath()
    let merged = shellPath ? mergePathValues(shellPath, current) : current
    merged = mergePathValues(merged, wellKnownBinDirs().join(delimiter))
    process.env.PATH = merged
  })()
  return loading
}
