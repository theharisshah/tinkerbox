#!/usr/bin/env node
/**
 * Build-time preparation of the bundled Laravel Sandbox (`resources/sandbox`).
 *
 * Creates a ready-to-run Laravel application the same way the app installs it on demand
 * (src/main/sandbox/index.ts): `composer create-project laravel/laravel`, `.env`, SQLite database,
 * app key, `php artisan migrate --force --graceful`, and a `.tinkerbox-sandbox.json` marker. The packaged
 * app copies it to the user data folder on first use (SQLite needs a writable location).
 *
 * Usage:
 *   node scripts/prepare-sandbox.mjs [--force] [--out <dir>] [--php <binary>] [--composer <path>]
 *                                    [--constraint <version>] [--no-dev]
 *
 *   --force        rebuild even when the target already contains a sandbox
 *   --out          target directory (default: <repo>/resources/sandbox)
 *   --php          PHP binary (default: $TINKERBOX_PHP, Herd's php, then php on PATH)
 *   --composer     Composer executable or composer.phar (default: Herd's composer, then PATH)
 *   --constraint   laravel/laravel version constraint, e.g. "^12.0" (default: latest)
 *   --no-dev       skip require-dev packages (smaller bundle, no factories/Faker)
 */
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const opts = { force: false, out: join(repoRoot, 'resources', 'sandbox'), php: '', composer: '', constraint: '', noDev: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) fail(`Missing value for ${arg}`)
      return v
    }
    if (arg === '--force') opts.force = true
    else if (arg === '--no-dev') opts.noDev = true
    else if (arg === '--out') opts.out = resolve(value())
    else if (arg === '--php') opts.php = value()
    else if (arg === '--composer') opts.composer = value()
    else if (arg === '--constraint') opts.constraint = value()
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 22).join('\n'))
      process.exit(0)
    } else fail(`Unknown option ${arg}`)
  }
  return opts
}

class PrepareError extends Error {}

/** Abort with a message; main() cleans up the temporary directory and exits with status 1. */
function fail(message) {
  throw new PrepareError(message)
}

function isExecutable(path) {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function which(name) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.bat', '.cmd'] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

function herdBin() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Herd', 'bin')
  if (process.platform === 'win32') return join(homedir(), '.config', 'herd', 'bin')
  return null
}

function findPhp(explicit) {
  if (explicit) return explicit
  if (process.env.TINKERBOX_PHP) return process.env.TINKERBOX_PHP
  const herd = herdBin()
  if (herd && process.platform === 'darwin' && isExecutable(join(herd, 'php'))) return join(herd, 'php')
  return which('php') ?? fail('PHP not found. Install PHP (e.g. Laravel Herd) or pass --php <binary>.')
}

function findComposer(explicit) {
  if (explicit) return explicit
  const herd = herdBin()
  if (herd) {
    for (const name of ['composer', 'composer.phar']) if (existsSync(join(herd, name))) return join(herd, name)
  }
  return which('composer') ?? which('composer.phar') ?? fail('Composer not found. Install Composer or pass --composer <path>.')
}

/** Composer is usually a PHP script/phar: run it through the chosen PHP binary. */
function isPhpScript(path) {
  if (/\.(phar|php)$/i.test(path)) return true
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(128)
    const n = readSync(fd, buf, 0, 128, 0)
    closeSync(fd)
    const head = buf.subarray(0, n).toString('utf8')
    return head.startsWith('<?php') || (head.startsWith('#!') && /php/.test(head.split('\n')[0]))
  } catch {
    return false
  }
}

/** Herd's PHP builds read their per-version ini from HERD_PHP_<ver>_INI_SCAN_DIR (normally set by the shell profile). */
function herdIniEnv() {
  const env = {}
  if (process.platform !== 'darwin') return env
  const configPhp = join(homedir(), 'Library', 'Application Support', 'Herd', 'config', 'php')
  if (!existsSync(configPhp)) return env
  for (const entry of readdirSafe(configPhp)) {
    if (/^\d{2,3}$/.test(entry) && !process.env[`HERD_PHP_${entry}_INI_SCAN_DIR`]) env[`HERD_PHP_${entry}_INI_SCAN_DIR`] = join(configPhp, entry) + '/'
  }
  return env
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function run(command, args, cwd, env, what) {
  console.log(`$ ${[command, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) fail(`${what}: ${result.error.message}`)
  if (result.status !== 0) fail(`${what} failed with exit code ${result.status ?? result.signal}`)
}

function capture(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  return result.status === 0 ? result.stdout : ''
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const isReady = (dir) => existsSync(join(dir, 'artisan')) && existsSync(join(dir, 'vendor', 'autoload.php'))
  if (isReady(opts.out) && !opts.force) {
    console.log(`Sandbox already prepared in ${opts.out} (use --force to rebuild).`)
    return
  }
  const php = findPhp(opts.php)
  const composer = findComposer(opts.composer)
  const env = { ...process.env, ...herdIniEnv(), COMPOSER_NO_INTERACTION: '1', XDEBUG_MODE: 'off' }
  const phpArgs = ['-d', 'xdebug.mode=off']

  const tmp = `${opts.out}.tmp-${Date.now()}`
  mkdirSync(dirname(opts.out), { recursive: true })
  rmSync(tmp, { recursive: true, force: true })
  try {
    const pkg = opts.constraint ? `laravel/laravel:${opts.constraint}` : 'laravel/laravel'
    const createArgs = ['create-project', pkg, tmp, '--prefer-dist', '--no-interaction', '--no-progress']
    if (opts.noDev) createArgs.push('--no-dev')
    if (isPhpScript(composer)) run(php, [...phpArgs, composer, ...createArgs], dirname(opts.out), env, 'composer create-project')
    else run(composer, createArgs, dirname(opts.out), env, 'composer create-project')

    if (!existsSync(join(tmp, '.env')) && existsSync(join(tmp, '.env.example'))) copyFileSync(join(tmp, '.env.example'), join(tmp, '.env'))
    const database = join(tmp, 'database', 'database.sqlite')
    if (!existsSync(database)) {
      mkdirSync(dirname(database), { recursive: true })
      writeFileSync(database, '')
    }
    const dotenv = existsSync(join(tmp, '.env')) ? readFileSync(join(tmp, '.env'), 'utf8') : ''
    if (/^APP_KEY=\s*$/m.test(dotenv)) run(php, [...phpArgs, 'artisan', 'key:generate', '--force', '--no-interaction'], tmp, env, 'php artisan key:generate')
    run(php, [...phpArgs, 'artisan', 'migrate', '--force', '--graceful', '--no-interaction'], tmp, env, 'php artisan migrate')

    const versionLine = capture(php, [...phpArgs, 'artisan', '--version', '--no-ansi'], tmp, env)
    let laravelVersion = /Laravel Framework\s+(\S+)/.exec(versionLine)?.[1]
    if (!laravelVersion) {
      const app = join(tmp, 'vendor', 'laravel', 'framework', 'src', 'Illuminate', 'Foundation', 'Application.php')
      laravelVersion = existsSync(app) ? /const\s+VERSION\s*=\s*'([^']+)'/.exec(readFileSync(app, 'utf8'))?.[1] : undefined
    }
    const phpVersion = capture(php, [...phpArgs, '-r', 'echo PHP_VERSION;'], tmp, env).trim() || undefined
    writeFileSync(
      join(tmp, '.tinkerbox-sandbox.json'),
      JSON.stringify({ laravelVersion, phpVersion, installedAt: new Date().toISOString(), source: 'bundled' }, null, 2)
    )
    // Logs written while migrating are not worth shipping.
    rmSync(join(tmp, 'storage', 'logs', 'laravel.log'), { force: true })

    if (existsSync(opts.out)) {
      const old = `${opts.out}.old-${Date.now()}`
      renameSync(opts.out, old)
      renameSync(tmp, opts.out)
      rmSync(old, { recursive: true, force: true })
    } else {
      renameSync(tmp, opts.out)
    }
    console.log(`Laravel ${laravelVersion ?? ''} sandbox prepared in ${opts.out}`)
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw err
  }
}

try {
  main()
} catch (err) {
  console.error(`prepare-sandbox: ${err instanceof PrepareError ? err.message : (err?.stack ?? err)}`)
  process.exit(1)
}
