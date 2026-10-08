import { randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  statSync,
  symlinkSync,
  unlinkSync,
  type Stats
} from 'node:fs'
import { delimiter, dirname, join, normalize, resolve } from 'node:path'
import { errorMessage } from './store/common'
import { writeFileAtomicSync } from './store/jsonStore'

/**
 * `tinkerbox` command line helper.
 *
 * macOS / Linux: resources/bin/tinkerbox.sh is rendered with the app location into `<userData>/bin/tinkerbox` and
 * symlinked into /usr/local/bin (when writable) or ~/.local/bin. Re-rendered on every start so the link keeps
 * working after the app is moved or updated.
 * Windows: a `tinkerbox.cmd` shim in %LOCALAPPDATA%\Tinkerbox\bin that starts Tinkerbox.exe with the path (the single
 * instance lock forwards it to the running window).
 *
 * The macOS / Linux helper hands paths over as tinkerbox:// deep links, which any web page can trigger as well. The
 * helper therefore appends a per-install secret (`<userData>/cli-token`, readable by the user only) to its links;
 * the app opens other deep links only after asking (see deeplinks.ts needsOpenConfirmation).
 */

export const CLI_MARKER = 'Tinkerbox command line helper'

export interface CliResult {
  installed: boolean
  path: string
  message: string
  /** Command the user can run in a terminal to finish a system-wide install (when not installed there). */
  manualCommand?: string
}

export interface CliEnvironment {
  platform: NodeJS.Platform
  homeDir: string
  userDataPath: string
  /** resources/bin/tinkerbox.sh */
  templatePath: string
  execPath: string
  isPackaged: boolean
  /** app.getAppPath() — passed to the Electron binary when running unpackaged. */
  appPath: string
  env: NodeJS.ProcessEnv
  /** System-wide bin directory (default /usr/local/bin). */
  systemBinDir?: string
}

export interface UnixScriptVars {
  /** macOS .app bundle used with `open -a`. */
  app: string
  /** Executable started directly on Linux. */
  exec: string
  /** Extra first argument for the executable (the app directory when running unpackaged). */
  execArg: string
  /** File holding the deep-link token (read by the script at run time, so the token never sits in the script). */
  tokenFile?: string
}

/** Escape a value for use inside a double-quoted POSIX shell string. */
export function shellDoubleQuoteEscape(value: string): string {
  return value.replace(/[\\"$`]/g, (c) => '\\' + c)
}

/** Quote a value as a single-quoted POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** `/Applications/Tinkerbox.app/Contents/MacOS/Tinkerbox` → `/Applications/Tinkerbox.app`. */
export function macAppBundlePath(execPath: string): string | null {
  const match = /^(.*?\.app)(?:\/|$)/.exec(execPath)
  return match ? match[1] : null
}

export function unixScriptVars(env: CliEnvironment): UnixScriptVars {
  const tokenFile = cliTokenPath(env.userDataPath)
  if (env.platform === 'darwin') {
    return { app: macAppBundlePath(env.execPath) ?? '', exec: '', execArg: '', tokenFile }
  }
  // An AppImage's execPath points into a temporary mount; APPIMAGE is the stable file.
  const exec = env.env.APPIMAGE || env.execPath
  return { app: '', exec, execArg: env.isPackaged ? '' : env.appPath, tokenFile }
}

export function renderUnixScript(template: string, vars: UnixScriptVars): string {
  if (!template.includes(CLI_MARKER)) throw new Error('The CLI helper template is not a Tinkerbox script')
  // Function replacer: with a replacement *string*, patterns such as `$&` or `$'` inside the value would be expanded.
  const fill = (text: string, name: string, value: string): string =>
    text.replace(`"__${name}__"`, () => `"${shellDoubleQuoteEscape(value)}"`)
  let script = fill(template, 'TINKERBOX_APP', vars.app)
  script = fill(script, 'TINKERBOX_EXEC', vars.exec)
  script = fill(script, 'TINKERBOX_EXEC_ARG', vars.execArg)
  return fill(script, 'TINKERBOX_TOKEN_FILE', vars.tokenFile ?? '')
}

/** Where the deep-link token of the installed helper is kept. */
export function cliTokenPath(userDataPath: string): string {
  return join(userDataPath, 'cli-token')
}

const CLI_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/

/** The installed helper's deep-link token, or null when there is none (no helper installed yet). */
export function readCliToken(userDataPath: string): string | null {
  try {
    const value = readFileSync(cliTokenPath(userDataPath), 'utf8').trim()
    return CLI_TOKEN_PATTERN.test(value) ? value : null
  } catch {
    // No helper installed (or the file is unreadable): every deep link asks first.
    return null
  }
}

function ensureCliToken(userDataPath: string): string {
  const existing = readCliToken(userDataPath)
  if (existing) return existing
  const token = randomBytes(32).toString('hex')
  writeFileAtomicSync(cliTokenPath(userDataPath), token + '\n', 0o600)
  return token
}

/** Escape a value for a double-quoted string inside a .cmd batch file. */
function batchEscape(value: string): string {
  return value.replace(/%/g, '%%')
}

export function renderWindowsShim(execPath: string, execArg: string): string {
  const exec = `"${batchEscape(execPath)}"`
  const arg = execArg ? ` "${batchEscape(execArg)}"` : ''
  return [
    '@echo off',
    `rem ${CLI_MARKER}: tinkerbox [folder or file.php]`,
    'setlocal',
    'if "%~1"=="" (set "TW_TARGET=%CD%") else (set "TW_TARGET=%~f1")',
    'if not exist "%TW_TARGET%" (',
    '  echo tinkerbox: no such file or directory: %TW_TARGET% 1>&2',
    '  exit /b 1',
    ')',
    `start "" ${exec}${arg} "%TW_TARGET%"`,
    'endlocal',
    ''
  ].join('\r\n')
}

export function cliScriptPath(env: Pick<CliEnvironment, 'platform' | 'userDataPath' | 'homeDir' | 'env'>): string {
  if (env.platform === 'win32') {
    const localAppData = env.env.LOCALAPPDATA || join(env.homeDir, 'AppData', 'Local')
    return join(localAppData, 'Tinkerbox', 'bin', 'tinkerbox.cmd')
  }
  return join(env.userDataPath, 'bin', 'tinkerbox')
}

function writeScript(env: CliEnvironment): string {
  const target = cliScriptPath(env)
  if (env.platform === 'win32') {
    writeFileAtomicSync(target, renderWindowsShim(env.execPath, env.isPackaged ? '' : env.appPath), 0o644)
  } else {
    const template = readFileSync(env.templatePath, 'utf8')
    ensureCliToken(env.userDataPath)
    writeFileAtomicSync(target, renderUnixScript(template, unixScriptVars(env)), 0o755)
    chmodSync(target, 0o755)
  }
  return target
}

function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return statSync(dir).isDirectory()
  } catch {
    // Not writable / does not exist.
    return false
  }
}

function pathContains(envPath: string | undefined, dir: string, platform: NodeJS.Platform): boolean {
  const sepChar = platform === 'win32' ? ';' : delimiter
  const wanted = normalize(dir).replace(/[\\/]+$/, '')
  return (envPath ?? '')
    .split(sepChar)
    .filter(Boolean)
    .some((p) => {
      const candidate = normalize(p).replace(/[\\/]+$/, '')
      return platform === 'win32' ? candidate.toLowerCase() === wanted.toLowerCase() : candidate === wanted
    })
}

/** True when `path` (following symlinks) is a regular file whose first bytes carry the helper marker. */
function isCliHelperFile(path: string): boolean {
  let fd: number | null = null
  try {
    if (!statSync(path).isFile()) return false
    fd = openSync(path, 'r')
    const head = Buffer.alloc(4096)
    const read = readSync(fd, head, 0, head.length, 0)
    return head.subarray(0, read).toString('utf8').includes(CLI_MARKER)
  } catch {
    // Missing / unreadable target: not provably ours.
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Whether an existing `<dir>/tinkerbox` may be replaced: our own helper file, or a symlink to the script we are
 * about to link (or to another Tinkerbox helper, e.g. of a moved user-data folder). Anything else, including a
 * dangling symlink or one to an unrelated program, belongs to someone else.
 */
function isOwnHelperEntry(link: string, stat: Stats, script: string): boolean {
  if (stat.isSymbolicLink()) {
    let target: string
    try {
      target = resolve(dirname(link), readlinkSync(link))
    } catch {
      return false
    }
    return target === resolve(script) || isCliHelperFile(target)
  }
  return stat.isFile() && isCliHelperFile(link)
}

/** Create / replace `<dir>/tinkerbox` as a symlink to the rendered script. Throws with a readable message. */
function linkInto(dir: string, script: string): string {
  const link = join(dir, 'tinkerbox')
  let stat: Stats | null = null
  try {
    stat = lstatSync(link)
  } catch {
    // Nothing there yet.
  }
  if (stat) {
    if (!isOwnHelperEntry(link, stat, script)) throw new Error(`${link} already exists and is not the Tinkerbox helper`)
    unlinkSync(link)
  }
  symlinkSync(script, link)
  return link
}

/** Install the CLI helper (see module docs). Never throws; failures are reported in the result. */
export function installCli(env: CliEnvironment): CliResult {
  let script: string
  try {
    script = writeScript(env)
  } catch (err) {
    return { installed: false, path: '', message: `Could not create the CLI helper: ${errorMessage(err)}` }
  }

  if (env.platform === 'win32') {
    const dir = dirname(script)
    const onPath = pathContains(env.env.Path ?? env.env.PATH, dir, 'win32')
    return {
      installed: true,
      path: script,
      message: onPath
        ? `Installed the tinkerbox command (${script}).`
        : `Installed ${script}. Add ${dir} to your PATH, e.g. in PowerShell: ` +
          `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${dir}', 'User') ` +
          '— then open a new terminal.'
    }
  }

  const systemDir = env.systemBinDir ?? '/usr/local/bin'
  const userDir = join(env.homeDir, '.local', 'bin')
  const problems: string[] = []

  if (isWritableDir(systemDir)) {
    try {
      const link = linkInto(systemDir, script)
      return { installed: true, path: link, message: `Installed the tinkerbox command in ${systemDir}.` }
    } catch (err) {
      problems.push(errorMessage(err))
    }
  }

  try {
    mkdirSync(userDir, { recursive: true })
    const link = linkInto(userDir, script)
    const onPath = pathContains(env.env.PATH, userDir, env.platform)
    const manualCommand = sudoLinkCommand(script, systemDir)
    return onPath
      ? { installed: true, path: link, message: `Installed the tinkerbox command in ${userDir}.` }
      : {
          installed: true,
          path: link,
          message:
            `Installed the tinkerbox command in ${userDir}, which is not on your PATH. Add ` +
            `export PATH="$HOME/.local/bin:$PATH" to your shell profile, or install it system-wide with: ${manualCommand}`,
          manualCommand
        }
  } catch (err) {
    problems.push(errorMessage(err))
  }

  const manualCommand = sudoLinkCommand(script, systemDir)
  return {
    installed: false,
    path: script,
    message: `Could not install the tinkerbox command automatically (${problems.join('; ')}). Run this in a terminal: ${manualCommand}`,
    manualCommand
  }
}

function sudoLinkCommand(script: string, systemDir: string): string {
  return `sudo ln -sf ${shellQuote(script)} ${shellQuote(join(systemDir, 'tinkerbox'))}`
}

/**
 * Re-render an installed helper so it points at the current app location (after an update or move).
 * Returns false when no helper is installed.
 */
export function refreshInstalledCli(env: CliEnvironment): boolean {
  if (!existsSync(cliScriptPath(env))) return false
  writeScript(env)
  return true
}
