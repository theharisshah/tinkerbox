/**
 * Laravel Sandbox ("Default" tab): a stock Laravel application used when no project is open.
 *
 * Locations:
 *  - `<userData>/sandbox`: installed / updated on demand via `composer create-project laravel/laravel`,
 *    or a copy of the bundled sandbox. When present it is used (a user-initiated install is an update).
 *  - `<resources>/sandbox`: prepared at build time by `scripts/prepare-sandbox.mjs` (packaged via
 *    electron-builder.yml extraResources), so no install is needed. Inside a packaged (read-only, code-signed) app it is copied to `<userData>/sandbox` on first
 *    use so SQLite writes work (and re-copied when a newer bundled version ships); in development it is
 *    used in place.
 */
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile, copyFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SandboxStatus } from '@shared/types'
import { windowsBatchCommand, type SpawnCommand } from '../execution/argv'
import { isPackagedApp } from '../execution/bundle'
import { runCapture, spawnStreaming, summarizeOutput } from '../execution/process'
import type { ExecutionContext } from '../execution/types'
import { findExecutable, isExecutableFile, isPhpScript } from '../env/which'
import { phpEnvironment, resolvePhpBinary } from '../php/binaries'
import { herdPaths } from '../php/herd'

export const SANDBOX_MARKER = '.tinkerbox-sandbox.json'
const INSTALL_TIMEOUT_MS = 20 * 60_000
const ARTISAN_TIMEOUT_MS = 5 * 60_000

export interface SandboxMarker {
  laravelVersion?: string
  phpVersion?: string
  installedAt?: string
  source?: 'composer' | 'bundled'
}

type SandboxContext = Pick<ExecutionContext, 'resourcesPath' | 'userDataPath'> & Partial<Pick<ExecutionContext, 'getSettings'>>

/** A Laravel sandbox is usable once it has `artisan` and its Composer dependencies. */
export function isSandboxInstalledAt(dir: string | null | undefined): boolean {
  if (!dir) return false
  return existsSync(join(dir, 'artisan')) && existsSync(join(dir, 'vendor', 'autoload.php'))
}

export function userSandboxDir(userDataPath: string): string {
  return join(userDataPath, 'sandbox')
}

/**
 * Sandbox prepared at build time, or null. Packaged, electron-builder's extraResources puts it at
 * `<process.resourcesPath>/sandbox` (paths.resources); an app packaged without that entry still carries it inside
 * the app, unpacked from the asar archive (asarUnpack resources/**) at `app.asar.unpacked/resources/sandbox`.
 * Unpackaged, paths.resources is `<repo>/resources`.
 */
export function bundledSandboxDir(resourcesPath: string): string | null {
  const roots = [resourcesPath]
  const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (electronResources && resolve(electronResources) !== resolve(resourcesPath)) roots.push(electronResources)
  const candidates = roots.flatMap((root) => [
    join(root, 'sandbox'),
    join(root, 'resources', 'sandbox'),
    join(root, 'app.asar.unpacked', 'resources', 'sandbox')
  ])
  for (const dir of candidates) if (isSandboxInstalledAt(dir)) return dir
  return null
}

/** Whether a bundled sandbox must be copied before use (it ships inside the read-only app bundle). */
export function bundledSandboxNeedsCopy(bundled: string): boolean {
  if (!isPackagedApp()) return false
  const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return !electronResources || resolve(bundled).startsWith(resolve(electronResources))
}

/** Directory the sandbox connection points at (synchronous; the copy of a bundled sandbox is lazy). */
export function sandboxPathSync(ctx: SandboxContext): string {
  const user = userSandboxDir(ctx.userDataPath)
  if (isSandboxInstalledAt(user)) return user
  const bundled = bundledSandboxDir(ctx.resourcesPath)
  if (bundled && !bundledSandboxNeedsCopy(bundled)) return bundled
  return user
}

/** True when a sandbox is available (installed in userData or bundled with the app). */
export function isSandboxAvailable(ctx: SandboxContext): boolean {
  return isSandboxInstalledAt(userSandboxDir(ctx.userDataPath)) || bundledSandboxDir(ctx.resourcesPath) !== null
}

export function readSandboxMarker(dir: string | null): SandboxMarker | null {
  if (!dir) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, SANDBOX_MARKER), 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as SandboxMarker) : null
  } catch {
    return null
  }
}

/** `Application::VERSION` from the installed framework (no PHP needed). */
export function laravelVersionFromVendor(dir: string | null): string | undefined {
  if (!dir) return undefined
  try {
    const src = readFileSync(join(dir, 'vendor', 'laravel', 'framework', 'src', 'Illuminate', 'Foundation', 'Application.php'), 'utf8')
    return /const\s+VERSION\s*=\s*'([^']+)'/.exec(src)?.[1]
  } catch {
    return undefined
  }
}

const installState: { running: Promise<SandboxStatus> | null; error?: string; listeners: Set<(line: string) => void> } = {
  running: null,
  listeners: new Set()
}

let copying: Promise<string> | null = null

/**
 * Make sure the sandbox can be executed and return its path: copies a bundled sandbox out of the
 * packaged app on first use (or when the bundled version changed).
 */
export async function ensureSandboxReady(ctx: SandboxContext): Promise<string> {
  const user = userSandboxDir(ctx.userDataPath)
  const bundled = bundledSandboxDir(ctx.resourcesPath)
  if (!bundled || !bundledSandboxNeedsCopy(bundled)) return sandboxPathSync(ctx)
  const userMarker = readSandboxMarker(user)
  const bundledMarker = readSandboxMarker(bundled)
  const upToDate =
    isSandboxInstalledAt(user) &&
    (userMarker?.source !== 'bundled' || !bundledMarker?.laravelVersion || userMarker.laravelVersion === bundledMarker.laravelVersion)
  if (upToDate) return user
  if (!copying) {
    copying = (async () => {
      const tmp = `${user}.copying-${Date.now()}`
      try {
        await mkdir(dirname(user), { recursive: true })
        await cp(bundled, tmp, { recursive: true, verbatimSymlinks: true })
        const marker: SandboxMarker = { ...(bundledMarker ?? {}), source: 'bundled', installedAt: new Date().toISOString() }
        await writeFile(join(tmp, SANDBOX_MARKER), JSON.stringify(marker, null, 2))
        await swapDirectory(tmp, user)
        return user
      } catch (err) {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
        throw new Error(`Could not prepare the Laravel Sandbox: ${(err as Error).message}`)
      } finally {
        copying = null
      }
    })()
  }
  return copying
}

/** Replace `target` with `source` (both on the same volume), removing the previous directory. */
async function swapDirectory(source: string, target: string): Promise<void> {
  if (existsSync(target)) {
    const old = `${target}.old-${Date.now()}`
    await rename(target, old)
    await rename(source, target)
    await rm(old, { recursive: true, force: true })
  } else {
    await rename(source, target)
  }
}

export async function sandboxStatus(ctx: SandboxContext): Promise<SandboxStatus> {
  const path = sandboxPathSync(ctx)
  const bundled = bundledSandboxDir(ctx.resourcesPath)
  const installed = isSandboxInstalledAt(path) || bundled !== null
  const status: SandboxStatus = { installed, path, installing: installState.running !== null }
  const source = isSandboxInstalledAt(path) ? path : bundled
  const laravelVersion = readSandboxMarker(source)?.laravelVersion ?? laravelVersionFromVendor(source)
  if (laravelVersion) status.laravelVersion = laravelVersion
  if (installState.error) status.error = installState.error
  return status
}

/** Composer executable: Herd's bundled copy, then PATH and common install locations. */
export function findComposer(): string | null {
  const herd = herdPaths()
  const candidates: string[] = []
  if (herd) {
    if (process.platform === 'win32') candidates.push(join(herd.bin, 'composer.phar'), join(herd.bin, 'composer.bat'))
    else candidates.push(join(herd.bin, 'composer'))
  }
  for (const c of candidates) if (existsSync(c)) return c
  const extra =
    process.platform === 'win32'
      ? ['C:\\ProgramData\\ComposerSetup\\bin']
      : ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.composer', 'vendor', 'bin'), join(homedir(), '.local', 'bin')]
  return findExecutable('composer', extra) ?? findExecutable('composer.phar', extra)
}

/** How to invoke composer: PHP scripts/phars run through the resolved PHP (no shebang / PATH reliance). */
export function composerCommand(composer: string, php: string, args: string[]): SpawnCommand {
  if (isPhpScript(composer) || !isExecutableFile(composer)) return { command: php, args: ['-d', 'xdebug.mode=off', composer, ...args] }
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(composer)) return windowsBatchCommand(composer, args, process.env.ComSpec || 'cmd.exe')
  return { command: composer, args }
}

function lineSplitter(emit: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let pending = ''
  return {
    push(chunk: string) {
      pending += chunk
      const parts = pending.split(/\r\n|\n|\r/)
      pending = parts.pop() ?? ''
      // eslint-disable-next-line no-control-regex
      for (const line of parts) emit(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))
    },
    flush() {
      // eslint-disable-next-line no-control-regex
      if (pending) emit(pending.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))
      pending = ''
    }
  }
}

async function runStep(spec: SpawnCommand, cwd: string, env: NodeJS.ProcessEnv, emit: (line: string) => void, timeoutMs: number, what: string): Promise<string> {
  const out = lineSplitter(emit)
  const err = lineSplitter(emit)
  const result = await spawnStreaming(
    { command: spec.command, args: spec.args, cwd, env, windowsVerbatimArguments: spec.windowsVerbatimArguments },
    { timeoutMs, onStdout: (c) => out.push(c), onStderr: (c) => err.push(c) }
  )
  out.flush()
  err.flush()
  if (result.spawnError) throw new Error(`${what}: could not start ${spec.command} (${result.spawnError.code ?? result.spawnError.message})`)
  if (result.timedOut) throw new Error(`${what} timed out after ${Math.round(timeoutMs / 60000)} minutes`)
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed (exit code ${result.exitCode ?? result.signal}): ${summarizeOutput(result.stderr || result.stdout, 400)}`)
  }
  return result.stdout
}

/** Composer's message when a (usually stale) GitHub token in the user's auth.json is rejected. */
const GITHUB_AUTH_FAILURE = /could not authenticate against github\.com/i

/**
 * Runs `composer create-project …`. A stale GitHub token in the user's Composer `auth.json` makes Composer fail
 * even for public packages; in that case retry once with a throw-away `COMPOSER_HOME` (no credentials, no cache).
 * The user's own Composer configuration is never modified.
 */
export async function createProjectWithAuthFallback(
  spec: SpawnCommand,
  cwd: string,
  env: NodeJS.ProcessEnv,
  emit: (line: string) => void,
  timeoutMs: number,
  cleanTarget: () => Promise<void>
): Promise<void> {
  let authFailed = false
  const watch = (line: string): void => {
    if (GITHUB_AUTH_FAILURE.test(line)) authFailed = true
    emit(line)
  }
  try {
    await runStep(spec, cwd, env, watch, timeoutMs, 'composer create-project')
    return
  } catch (err) {
    if (!authFailed && !GITHUB_AUTH_FAILURE.test((err as Error).message)) throw err
  }
  emit('Composer could not authenticate against GitHub (a stale token in your Composer auth.json?). Retrying without your Composer credentials…')
  const isolatedHome = await mkdtemp(join(tmpdir(), 'tinkerbox-composer-'))
  try {
    await cleanTarget()
    const { COMPOSER_AUTH: _ignored, ...rest } = env
    await runStep(spec, cwd, { ...rest, COMPOSER_HOME: isolatedHome }, emit, timeoutMs, 'composer create-project')
  } finally {
    await rm(isolatedHome, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Post-install steps shared with the build script: `.env`, SQLite database, app key, migrations
 * (`php artisan migrate --force --graceful`, only ever inside the sandbox) and the marker file.
 */
export async function finalizeSandbox(dir: string, php: string, env: NodeJS.ProcessEnv, emit: (line: string) => void): Promise<SandboxMarker> {
  if (!existsSync(join(dir, '.env')) && existsSync(join(dir, '.env.example'))) await copyFile(join(dir, '.env.example'), join(dir, '.env'))
  const database = join(dir, 'database', 'database.sqlite')
  if (!existsSync(database)) {
    await mkdir(dirname(database), { recursive: true })
    await writeFile(database, '')
  }
  const dotenv = existsSync(join(dir, '.env')) ? await readFile(join(dir, '.env'), 'utf8') : ''
  if (/^APP_KEY=\s*$/m.test(dotenv)) {
    emit('$ php artisan key:generate --force')
    await runStep({ command: php, args: ['-d', 'xdebug.mode=off', 'artisan', 'key:generate', '--force', '--no-interaction'] }, dir, env, emit, ARTISAN_TIMEOUT_MS, 'php artisan key:generate')
  }
  emit('$ php artisan migrate --force --graceful')
  await runStep({ command: php, args: ['-d', 'xdebug.mode=off', 'artisan', 'migrate', '--force', '--graceful', '--no-interaction'] }, dir, env, emit, ARTISAN_TIMEOUT_MS, 'php artisan migrate')
  let laravelVersion = laravelVersionFromVendor(dir)
  try {
    const version = await runCapture(php, ['-d', 'xdebug.mode=off', 'artisan', '--version', '--no-ansi'], { cwd: dir, env, timeoutMs: 60_000, label: 'php artisan --version' })
    laravelVersion = /Laravel Framework\s+(\S+)/.exec(version.stdout)?.[1] ?? laravelVersion
  } catch {
    /* the vendor constant is good enough */
  }
  let phpVersion: string | undefined
  try {
    phpVersion = (await runCapture(php, ['-d', 'xdebug.mode=off', '-r', 'echo PHP_VERSION;'], { env, timeoutMs: 10_000 })).stdout.trim() || undefined
  } catch {
    /* optional */
  }
  const marker: SandboxMarker = { laravelVersion, phpVersion, installedAt: new Date().toISOString(), source: 'composer' }
  await writeFile(join(dir, SANDBOX_MARKER), JSON.stringify(marker, null, 2))
  return marker
}

/**
 * Install (or re-install) the sandbox into `<userData>/sandbox` with
 * `composer create-project laravel/laravel`, streaming output lines. Resolves with the new status; the
 * failure reason is reported in `status.error` (and streamed) instead of rejecting.
 */
export function installSandbox(ctx: ExecutionContext, onLine: (line: string) => void): Promise<SandboxStatus> {
  installState.listeners.add(onLine)
  if (installState.running) return installState.running.finally(() => installState.listeners.delete(onLine))
  const emit = (line: string): void => {
    for (const l of installState.listeners) {
      try {
        l(line)
      } catch {
        /* a listener failing must not abort the install */
      }
    }
  }
  installState.error = undefined
  const running = (async (): Promise<SandboxStatus> => {
    const target = userSandboxDir(ctx.userDataPath)
    const tmp = `${target}.installing-${Date.now()}`
    try {
      const { path: php, env: herdEnv } = await resolvePhpBinary(ctx.getSettings())
      const composer = findComposer()
      if (!composer) throw new Error('Composer not found. Install Composer (https://getcomposer.org) or Laravel Herd and try again.')
      const env = phpEnvironment({ ...herdEnv, COMPOSER_NO_INTERACTION: '1', XDEBUG_MODE: 'off' })
      await mkdir(dirname(target), { recursive: true })
      await rm(tmp, { recursive: true, force: true })
      emit(`$ composer create-project laravel/laravel ${target} --prefer-dist`)
      const spec = composerCommand(composer, php, ['create-project', 'laravel/laravel', tmp, '--prefer-dist', '--no-interaction', '--no-progress', '--no-ansi'])
      await createProjectWithAuthFallback(spec, dirname(target), env, emit, INSTALL_TIMEOUT_MS, () => rm(tmp, { recursive: true, force: true }))
      await finalizeSandbox(tmp, php, env, emit)
      await swapDirectory(tmp, target)
      emit(`Laravel Sandbox installed in ${target}`)
    } catch (err) {
      installState.error = (err as Error).message
      emit(`Error: ${installState.error}`)
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    } finally {
      installState.running = null
    }
    return sandboxStatus(ctx)
  })()
  installState.running = running
  return running.finally(() => installState.listeners.delete(onLine))
}
