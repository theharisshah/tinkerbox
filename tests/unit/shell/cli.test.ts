import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLI_MARKER,
  cliScriptPath,
  cliTokenPath,
  installCli,
  macAppBundlePath,
  readCliToken,
  refreshInstalledCli,
  renderUnixScript,
  renderWindowsShim,
  shellDoubleQuoteEscape,
  type CliEnvironment
} from '../../../src/main/cli'
import { parseDeepLink } from '../../../src/main/deeplinks'
import { tempDirs } from './helpers'

const TEMPLATE_PATH = resolve(__dirname, '../../../resources/bin/tinkerbox.sh')
const template = readFileSync(TEMPLATE_PATH, 'utf8')
const isWindows = process.platform === 'win32'

const tmp = tempDirs()
afterEach(() => tmp.cleanup())

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

/** A bin dir with fake `uname`, `open`, `xdg-open` that log their arguments (one per line) to $TW_LOG. */
function fakeBin(os: 'Darwin' | 'Linux', opts: { withXdgOpen?: boolean } = {}): { bin: string; log: string } {
  const dir = tmp.make()
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'calls.log')
  writeExecutable(join(bin, 'uname'), `#!/bin/sh\necho ${os}\n`)
  writeExecutable(join(bin, 'open'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$TW_LOG"; done\n')
  if (opts.withXdgOpen) {
    writeExecutable(join(bin, 'xdg-open'), '#!/bin/sh\nprintf \'xdg-open\\n%s\\n\' "$1" >> "$TW_LOG"\n')
  }
  return { bin, log }
}

function runScript(script: string, args: string[], env: Record<string, string>, cwd?: string) {
  const file = join(tmp.make(), 'tinkerbox')
  writeExecutable(file, script)
  // Like an interactive shell, export PWD (the logical working directory) when a cwd is given.
  return spawnSync('/bin/sh', [file, ...args], {
    env: { ...env, HOME: tmp.make(), ...(cwd ? { PWD: cwd } : {}) },
    cwd,
    encoding: 'utf8'
  })
}

async function waitForFile(path: string, timeoutMs = 3000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8')
      if (text.trim().split('\n').length >= 2) return text
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${path}`)
}

describe('CLI script rendering', () => {
  it('fills in the app location with shell-safe escaping', () => {
    const rendered = renderUnixScript(template, { app: '/Apps/My "Tink$well`.app', exec: '', execArg: '' })
    expect(rendered).toContain('TINKERBOX_APP="/Apps/My \\"Tink\\$well\\`.app"')
    expect(rendered).toContain('TINKERBOX_EXEC=""')
    expect(rendered).toContain(CLI_MARKER)
    expect(shellDoubleQuoteEscape('a\\b')).toBe('a\\\\b')
    expect(() => renderUnixScript('#!/bin/sh\necho hi', { app: '', exec: '', execArg: '' })).toThrow()
  })

  it.skipIf(isWindows)('keeps every app path literal, including replace() patterns such as $\' and $&', () => {
    const tricky = ["/Applications/Tink$'er.app", '/Applications/A$&B.app', '/Apps/$`x`/"q"/\\back$(id)', "/Apps/it's\nnew line"]
    for (const app of tricky) {
      const rendered = renderUnixScript(template, { app, exec: app, execArg: app, tokenFile: app })
      const file = join(tmp.make(), 'rendered.sh')
      writeFileSync(file, rendered)
      expect(spawnSync('/bin/sh', ['-n', file]).status, app).toBe(0)
      // Evaluate just the assignments: each variable must hold exactly the original value.
      const assignments = rendered.slice(rendered.indexOf('TINKERBOX_APP='), rendered.indexOf('\n# Running the template'))
      const probe = `${assignments}\nprintf '%s\\0' "$TINKERBOX_APP" "$TINKERBOX_EXEC" "$TINKERBOX_EXEC_ARG" "$TINKERBOX_TOKEN_FILE"`
      const out = spawnSync('/bin/sh', ['-c', probe], { encoding: 'utf8' })
      expect(out.status, out.stderr).toBe(0)
      expect(out.stdout.split('\0').slice(0, 4)).toEqual([app, app, app, app])
    }
  })

  it.skipIf(isWindows)('is valid POSIX sh (template and rendered)', () => {
    expect(spawnSync('/bin/sh', ['-n', TEMPLATE_PATH]).status).toBe(0)
    const file = join(tmp.make(), 'rendered.sh')
    writeFileSync(file, renderUnixScript(template, { app: '/Applications/Tinkerbox.app', exec: '/opt/x', execArg: '/repo' }))
    expect(spawnSync('/bin/sh', ['-n', file]).status).toBe(0)
  })

  it('derives the macOS bundle path from the executable path', () => {
    expect(macAppBundlePath('/Applications/Tinkerbox.app/Contents/MacOS/Tinkerbox')).toBe('/Applications/Tinkerbox.app')
    expect(macAppBundlePath('/usr/bin/electron')).toBeNull()
  })

  it('renders a Windows .cmd shim that starts the app with the absolute target path', () => {
    const shim = renderWindowsShim('C:\\Program Files\\Tinkerbox\\Tinkerbox.exe', '')
    expect(shim).toContain('\r\n')
    expect(shim).toContain('set "TW_TARGET=%~f1"')
    expect(shim).toContain('start "" "C:\\Program Files\\Tinkerbox\\Tinkerbox.exe" "%TW_TARGET%"')
    expect(renderWindowsShim('C:\\100%\\Tinkerbox.exe', 'C:\\repo')).toContain('"C:\\100%%\\Tinkerbox.exe" "C:\\repo"')
  })
})

describe.skipIf(isWindows)('CLI script behavior', () => {
  it('macOS: opens a tinkerbox:// URL for the folder with the installed app bundle', () => {
    const { bin, log } = fakeBin('Darwin')
    const app = join(tmp.make(), 'Tinkerbox.app')
    mkdirSync(app)
    const project = join(tmp.make(), 'my project ü')
    mkdirSync(project)
    const script = renderUnixScript(template, { app, exec: '', execArg: '' })
    const result = runScript(script, [project], { PATH: `${bin}:/usr/bin:/bin`, TW_LOG: log })
    expect(result.status, result.stderr).toBe(0)
    const [flag, appArg, url] = readFileSync(log, 'utf8').trim().split('\n')
    expect(flag).toBe('-a')
    expect(appArg).toBe(app)
    expect(url).toMatch(/^tinkerbox:\/\/open\?cwd=[A-Za-z0-9_-]+$/)
    expect(parseDeepLink(url)).toEqual({ path: project })
  })

  it('macOS: adds the token from the token file to the link (never from the script itself)', () => {
    const { bin, log } = fakeBin('Darwin')
    const project = tmp.make()
    const tokenFile = join(tmp.make(), 'cli-token')
    const token = 'f'.repeat(64)
    writeFileSync(tokenFile, token + '\n', { mode: 0o600 })
    const script = renderUnixScript(template, { app: '', exec: '', execArg: '', tokenFile })
    expect(script).not.toContain(token)
    expect(runScript(script, [project], { PATH: `${bin}:/usr/bin:/bin`, TW_LOG: log }).status).toBe(0)
    // Missing token file (e.g. another user running a system-wide link): a plain link, which the app confirms.
    const other = renderUnixScript(template, { app: '', exec: '', execArg: '', tokenFile: join(tmp.make(), 'missing') })
    expect(runScript(other, [project], { PATH: `${bin}:/usr/bin:/bin`, TW_LOG: log }).status).toBe(0)
    const [withToken, without] = readFileSync(log, 'utf8').trim().split('\n')
    expect(parseDeepLink(withToken)).toEqual({ path: project, token })
    expect(parseDeepLink(without)).toEqual({ path: project })
  })

  it('macOS: defaults to the current directory and resolves relative file paths', () => {
    const { bin, log } = fakeBin('Darwin')
    const project = tmp.make()
    mkdirSync(join(project, 'scripts'))
    writeFileSync(join(project, 'scripts', 'demo.php'), '<?php echo 1;')
    const script = renderUnixScript(template, { app: '', exec: '', execArg: '' })

    expect(runScript(script, [], { PATH: `${bin}:/usr/bin:/bin`, TW_LOG: log }, project).status).toBe(0)
    expect(runScript(script, ['scripts/demo.php'], { PATH: `${bin}:/usr/bin:/bin`, TW_LOG: log }, project).status).toBe(0)
    const urls = readFileSync(log, 'utf8').trim().split('\n')
    expect(parseDeepLink(urls[0])).toEqual({ path: project })
    expect(parseDeepLink(urls[1])).toEqual({ path: join(project, 'scripts', 'demo.php') })
  })

  it('fails with a message for missing paths and unknown options', () => {
    const { bin, log } = fakeBin('Darwin')
    const script = renderUnixScript(template, { app: '', exec: '', execArg: '' })
    const missing = runScript(script, ['/definitely/not/here'], { PATH: `${bin}:/usr/bin:/bin`, TW_LOG: log })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('no such file or directory')
    expect(runScript(script, ['--bogus'], { PATH: `${bin}:/usr/bin:/bin`, TW_LOG: log }).status).toBe(2)
    const help = runScript(script, ['--help'], { PATH: `${bin}:/usr/bin:/bin`, TW_LOG: log })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('Usage: tinkerbox')
    expect(existsSync(log)).toBe(false)
  })

  it('Linux: starts the app executable (with the dev app path) and the absolute folder', async () => {
    const { bin, log } = fakeBin('Linux')
    const exec = join(tmp.make(), 'tinkerbox-app')
    writeExecutable(exec, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$TW_LOG"; done\n')
    const project = tmp.make()
    const script = renderUnixScript(template, { app: '', exec, execArg: '/repo' })
    const result = runScript(script, [project], { PATH: `${bin}:/usr/bin:/bin`, TW_LOG: log })
    expect(result.status, result.stderr).toBe(0)
    const lines = (await waitForFile(log)).trim().split('\n')
    expect(lines).toEqual(['/repo', project])
  })

  it('Linux: falls back to xdg-open with the deep link when no executable is known', async () => {
    const { bin, log } = fakeBin('Linux', { withXdgOpen: true })
    const project = tmp.make()
    const script = renderUnixScript(template, { app: '', exec: '', execArg: '' })
    expect(runScript(script, [project], { PATH: `${bin}:/usr/bin:/bin`, TW_LOG: log }).status).toBe(0)
    const [name, url] = (await waitForFile(log)).trim().split('\n')
    expect(name).toBe('xdg-open')
    expect(parseDeepLink(url)).toEqual({ path: project })
  })
})

describe.skipIf(isWindows)('installCli (macOS / Linux)', () => {
  function env(overrides: Partial<CliEnvironment> = {}): CliEnvironment {
    return {
      platform: 'darwin',
      homeDir: tmp.make(),
      userDataPath: tmp.make(),
      templatePath: TEMPLATE_PATH,
      execPath: '/Applications/Tinkerbox.app/Contents/MacOS/Tinkerbox',
      isPackaged: true,
      appPath: '/Applications/Tinkerbox.app/Contents/Resources/app.asar',
      env: { PATH: '/usr/bin:/bin' },
      ...overrides
    }
  }

  it('symlinks the rendered script into a writable system bin dir', () => {
    const systemBinDir = tmp.make()
    const e = env({ systemBinDir })
    const result = installCli(e)
    const link = join(systemBinDir, 'tinkerbox')
    expect(result).toMatchObject({ installed: true, path: link })
    expect(result.manualCommand).toBeUndefined()
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    const script = cliScriptPath(e)
    expect(readlinkSync(link)).toBe(script)
    expect(statSync(script).mode & 0o111).not.toBe(0)
    expect(readFileSync(script, 'utf8')).toContain('TINKERBOX_APP="/Applications/Tinkerbox.app"')
    // Installing again replaces our own link.
    expect(installCli(e).installed).toBe(true)
  })

  it('falls back to ~/.local/bin (with PATH advice) when the system dir is not writable', () => {
    const e = env({ systemBinDir: join(tmp.make(), 'missing-dir') })
    const result = installCli(e)
    const link = join(e.homeDir, '.local', 'bin', 'tinkerbox')
    expect(result.installed).toBe(true)
    expect(result.path).toBe(link)
    expect(result.message).toContain('not on your PATH')
    expect(result.manualCommand).toMatch(/^sudo ln -sf '.*' '.*\/tinkerbox'$/)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)

    const onPath = installCli({ ...e, env: { PATH: `/usr/bin:${join(e.homeDir, '.local', 'bin')}` } })
    expect(onPath.message).not.toContain('not on your PATH')
  })

  it('creates a private deep-link token once and points the script at it', () => {
    const e = env({ systemBinDir: tmp.make() })
    expect(readCliToken(e.userDataPath)).toBeNull()
    installCli(e)
    const token = readCliToken(e.userDataPath)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(cliTokenPath(e.userDataPath)).mode & 0o077).toBe(0)
    const script = readFileSync(cliScriptPath(e), 'utf8')
    expect(script).toContain(`TINKERBOX_TOKEN_FILE="${cliTokenPath(e.userDataPath)}"`)
    expect(script).not.toContain(token)
    installCli(e)
    refreshInstalledCli(e)
    expect(readCliToken(e.userDataPath)).toBe(token)
  })

  it('never replaces a foreign `tinkerbox` symlink (or a dangling one)', () => {
    const systemBinDir = tmp.make()
    const foreign = join(tmp.make(), 'other-tool')
    writeExecutable(foreign, '#!/bin/sh\necho someone else\n')
    symlinkSync(foreign, join(systemBinDir, 'tinkerbox'))
    const e = env({ systemBinDir })
    const result = installCli(e)
    expect(readlinkSync(join(systemBinDir, 'tinkerbox'))).toBe(foreign)
    expect(result.path).toBe(join(e.homeDir, '.local', 'bin', 'tinkerbox'))

    const danglingDir = tmp.make()
    symlinkSync(join(tmp.make(), 'gone'), join(danglingDir, 'tinkerbox'))
    installCli(env({ systemBinDir: danglingDir }))
    expect(readlinkSync(join(danglingDir, 'tinkerbox'))).toContain('gone')
  })

  it('replaces its own symlink, also one to the helper of another user-data folder', () => {
    const systemBinDir = tmp.make()
    const old = env({ systemBinDir })
    installCli(old)
    const e = env({ systemBinDir })
    expect(installCli(e)).toMatchObject({ installed: true, path: join(systemBinDir, 'tinkerbox') })
    expect(readlinkSync(join(systemBinDir, 'tinkerbox'))).toBe(cliScriptPath(e))
  })

  it('never clobbers a foreign `tinkerbox` executable', () => {
    const systemBinDir = tmp.make()
    writeFileSync(join(systemBinDir, 'tinkerbox'), '#!/bin/sh\necho someone else\n')
    const e = env({ systemBinDir })
    const result = installCli(e)
    expect(readFileSync(join(systemBinDir, 'tinkerbox'), 'utf8')).toContain('someone else')
    expect(result.path).toBe(join(e.homeDir, '.local', 'bin', 'tinkerbox'))
  })

  it('returns a manual sudo command when nothing is writable', () => {
    const blockedHome = join(tmp.make(), 'home-is-a-file')
    writeFileSync(blockedHome, '')
    const result = installCli(env({ homeDir: blockedHome, systemBinDir: join(tmp.make(), 'missing') }))
    expect(result.installed).toBe(false)
    expect(result.manualCommand).toContain('sudo ln -sf')
    expect(result.message).toContain(result.manualCommand)
  })

  it('reports a missing template instead of throwing', () => {
    const result = installCli(env({ templatePath: '/nope/tinkerbox.sh', systemBinDir: tmp.make() }))
    expect(result.installed).toBe(false)
    expect(result.message).toContain('Could not create the CLI helper')
  })

  it('refreshInstalledCli re-renders an installed helper for a moved app', () => {
    const e = env({ systemBinDir: tmp.make() })
    expect(refreshInstalledCli(e)).toBe(false)
    installCli(e)
    expect(refreshInstalledCli({ ...e, execPath: '/Users/me/Apps/Tinkerbox.app/Contents/MacOS/Tinkerbox' })).toBe(true)
    expect(readFileSync(cliScriptPath(e), 'utf8')).toContain('TINKERBOX_APP="/Users/me/Apps/Tinkerbox.app"')
  })

  it('uses the AppImage path and the dev app dir on Linux', () => {
    const e = env({
      platform: 'linux',
      isPackaged: false,
      execPath: '/repo/node_modules/electron/dist/electron',
      appPath: '/repo',
      env: { PATH: '/usr/bin', APPIMAGE: '/home/me/Tinkerbox.AppImage' },
      systemBinDir: tmp.make()
    })
    installCli(e)
    const script = readFileSync(cliScriptPath(e), 'utf8')
    expect(script).toContain('TINKERBOX_EXEC="/home/me/Tinkerbox.AppImage"')
    expect(script).toContain('TINKERBOX_EXEC_ARG="/repo"')
    expect(script).toContain('TINKERBOX_APP=""')
  })
})

describe('installCli (Windows)', () => {
  it('writes a .cmd shim to %LOCALAPPDATA%\\Tinkerbox\\bin and explains the PATH step', () => {
    const localAppData = tmp.make()
    const e: CliEnvironment = {
      platform: 'win32',
      homeDir: tmp.make(),
      userDataPath: tmp.make(),
      templatePath: TEMPLATE_PATH,
      execPath: 'C:\\Program Files\\Tinkerbox\\Tinkerbox.exe',
      isPackaged: true,
      appPath: 'C:\\Program Files\\Tinkerbox\\resources\\app.asar',
      env: { LOCALAPPDATA: localAppData, Path: 'C:\\Windows' }
    }
    const result = installCli(e)
    expect(result.installed).toBe(true)
    expect(result.path).toBe(join(localAppData, 'Tinkerbox', 'bin', 'tinkerbox.cmd'))
    expect(readFileSync(result.path, 'utf8')).toContain('Tinkerbox.exe')
    expect(result.message).toContain('PATH')
  })
})
