import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createProjectWithAuthFallback,
  bundledSandboxDir,
  bundledSandboxNeedsCopy,
  composerCommand,
  ensureSandboxReady,
  finalizeSandbox,
  findComposer,
  installSandbox,
  isSandboxAvailable,
  isSandboxInstalledAt,
  sandboxPathSync,
  sandboxStatus
} from '../../../src/main/sandbox'
import { cleanupTempDirs, fakeContext, hasHerdPhp, herdBin, herdPhp83, makeTempDir, writeTree } from './helpers'

afterAll(cleanupTempDirs)

const laravelFiles = (version: string): Record<string, string> => ({
  artisan: '',
  'vendor/autoload.php': '<?php',
  'vendor/laravel/framework/src/Illuminate/Foundation/Application.php': `<?php\nclass Application { const VERSION = '${version}'; }`
})

function context(opts: { bundled?: string; installed?: string } = {}) {
  const resourcesPath = makeTempDir('tw-res-')
  const userDataPath = makeTempDir('tw-ud-')
  if (opts.bundled) writeTree(join(resourcesPath, 'sandbox'), laravelFiles(opts.bundled))
  if (opts.installed) writeTree(join(userDataPath, 'sandbox'), laravelFiles(opts.installed))
  return fakeContext({ resourcesPath, userDataPath })
}

describe('sandbox location & status', () => {
  it('reports a missing sandbox', async () => {
    const ctx = context()
    expect(isSandboxAvailable(ctx)).toBe(false)
    expect(sandboxPathSync(ctx)).toBe(join(ctx.userDataPath, 'sandbox'))
    expect(await sandboxStatus(ctx)).toEqual({ installed: false, path: join(ctx.userDataPath, 'sandbox'), installing: false })
  })

  it('reads the version of an installed sandbox (marker wins over vendor)', async () => {
    const ctx = context({ installed: '12.1.0' })
    expect(await sandboxStatus(ctx)).toMatchObject({ installed: true, laravelVersion: '12.1.0', path: join(ctx.userDataPath, 'sandbox') })
    writeFileSync(join(ctx.userDataPath, 'sandbox', '.tinkerbox-sandbox.json'), JSON.stringify({ laravelVersion: '12.9.9' }))
    expect((await sandboxStatus(ctx)).laravelVersion).toBe('12.9.9')
  })

  it('uses a bundled sandbox in place during development', async () => {
    const ctx = context({ bundled: '11.5.0' })
    const bundled = bundledSandboxDir(ctx.resourcesPath)!
    expect(bundled).toBe(join(ctx.resourcesPath, 'sandbox'))
    expect(bundledSandboxNeedsCopy(bundled)).toBe(false)
    expect(isSandboxAvailable(ctx)).toBe(true)
    expect(sandboxPathSync(ctx)).toBe(bundled)
    expect(await ensureSandboxReady(ctx)).toBe(bundled)
    expect(await sandboxStatus(ctx)).toMatchObject({ installed: true, path: bundled, laravelVersion: '11.5.0' })
  })

  it('finds the bundled sandbox in packaged layouts (extraResources, or unpacked from the asar)', () => {
    // electron-builder.yml extraResources: resources/sandbox → <Resources>/sandbox.
    const extra = makeTempDir('tw-res-')
    writeTree(join(extra, 'sandbox'), laravelFiles('12.0.0'))
    expect(bundledSandboxDir(extra)).toBe(join(extra, 'sandbox'))
    // Packaged without that entry: inside the app, unpacked by asarUnpack resources/**.
    const unpacked = makeTempDir('tw-res-')
    writeTree(join(unpacked, 'app.asar.unpacked', 'resources', 'sandbox'), laravelFiles('12.0.0'))
    const dir = bundledSandboxDir(unpacked)
    expect(dir).toBe(join(unpacked, 'app.asar.unpacked', 'resources', 'sandbox'))
    expect(isSandboxAvailable(fakeContext({ resourcesPath: unpacked, userDataPath: makeTempDir('tw-ud-') }))).toBe(true)
  })

  it('is shipped as an extra resource, outside the app archive (electron-builder.yml)', () => {
    const config = readFileSync(join(__dirname, '../../../electron-builder.yml'), 'utf8')
    expect(config).toMatch(/extraResources:[\s\S]*- from: resources\/sandbox\s+to: sandbox/)
    expect(config).toContain("- '!resources/sandbox{,/**/*}'")
  })

  it('prefers an installed sandbox over the bundled one', () => {
    const ctx = context({ bundled: '11.0.0', installed: '12.0.0' })
    expect(sandboxPathSync(ctx)).toBe(join(ctx.userDataPath, 'sandbox'))
  })

  it('requires artisan and vendor/autoload.php', () => {
    const dir = makeTempDir()
    writeTree(dir, { artisan: '' })
    expect(isSandboxInstalledAt(dir)).toBe(false)
    expect(isSandboxInstalledAt(null)).toBe(false)
  })
})

describe('composer GitHub auth fallback', () => {
  it.skipIf(process.platform === 'win32')('retries create-project with a clean COMPOSER_HOME when GitHub auth fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-composer-auth-'))
    const log = join(dir, 'calls.log')
    const fake = join(dir, 'composer')
    // Fails like Composer does with a stale token unless COMPOSER_HOME was swapped for a throw-away one.
    writeFileSync(fake, `#!/bin/sh\necho "home=$COMPOSER_HOME" >> "${log}"\nif [ "$COMPOSER_HOME" = "/real/home" ]; then echo "  Could not authenticate against github.com" >&2; exit 1; fi\nexit 0\n`)
    chmodSync(fake, 0o755)
    const lines: string[] = []
    let cleaned = 0
    await createProjectWithAuthFallback({ command: fake, args: [] }, dir, { ...process.env, COMPOSER_HOME: '/real/home' }, (l) => lines.push(l), 10000, async () => { cleaned++ })
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe('home=/real/home')
    expect(calls[1]).toMatch(/tinkerbox-composer-/)
    expect(cleaned).toBe(1)
    expect(lines.some((l) => /Retrying without your Composer credentials/.test(l))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('does not retry other failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-composer-fail-'))
    const fake = join(dir, 'composer')
    writeFileSync(fake, '#!/bin/sh\necho "Your requirements could not be resolved" >&2\nexit 2\n')
    chmodSync(fake, 0o755)
    await expect(createProjectWithAuthFallback({ command: fake, args: [] }, dir, process.env, () => {}, 10000, async () => {})).rejects.toThrow(/exit code 2/)
  })
})

describe('composer', () => {
  it('runs PHP scripts / phars through PHP and native executables directly', () => {
    const dir = makeTempDir()
    writeTree(dir, { 'composer.phar': 'x', composer: '#!/usr/bin/env php\n<?php', 'native-composer': '#!/bin/sh\necho' })
    expect(composerCommand(join(dir, 'composer.phar'), '/php', ['-V'])).toEqual({ command: '/php', args: ['-d', 'xdebug.mode=off', join(dir, 'composer.phar'), '-V'] })
    expect(composerCommand(join(dir, 'composer'), '/php', ['-V']).command).toBe('/php')
  })

  it.skipIf(!hasHerdPhp)("finds Herd's composer", () => {
    expect(findComposer()).toBe(join(herdBin, 'composer'))
  })
})

describe.skipIf(!hasHerdPhp)('sandbox finalization', () => {
  it('creates .env and the SQLite database, generates a key, migrates and writes the marker', async () => {
    const dir = makeTempDir('tw-finalize-')
    const log = join(dir, 'artisan.log')
    writeTree(dir, {
      '.env.example': 'APP_NAME=Laravel\nAPP_KEY=\nDB_CONNECTION=sqlite\n',
      'vendor/laravel/framework/src/Illuminate/Foundation/Application.php': "<?php const VERSION = '12.0.0';",
      // Fake artisan: records its arguments, fills APP_KEY, prints the framework version.
      artisan: `<?php
file_put_contents(__DIR__ . '/artisan.log', implode(' ', array_slice($argv, 1)) . "\\n", FILE_APPEND);
if (($argv[1] ?? '') === 'key:generate') file_put_contents(__DIR__ . '/.env', str_replace('APP_KEY=', 'APP_KEY=base64:x', file_get_contents(__DIR__ . '/.env')));
if (($argv[1] ?? '') === '--version') echo "Laravel Framework 12.34.5\\n";
`
    })
    const lines: string[] = []
    const marker = await finalizeSandbox(dir, herdPhp83, process.env, (l) => lines.push(l))
    expect(existsSync(join(dir, '.env'))).toBe(true)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('APP_KEY=base64:x')
    expect(existsSync(join(dir, 'database', 'database.sqlite'))).toBe(true)
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    expect(calls).toEqual(['key:generate --force --no-interaction', 'migrate --force --graceful --no-interaction', '--version --no-ansi'])
    expect(marker).toMatchObject({ laravelVersion: '12.34.5', source: 'composer', phpVersion: expect.stringMatching(/^8\.3\./) })
    expect(JSON.parse(readFileSync(join(dir, '.tinkerbox-sandbox.json'), 'utf8')).laravelVersion).toBe('12.34.5')
    expect(lines).toContain('$ php artisan migrate --force --graceful')
  })

  it('reports install failures in the status and streams them, sharing concurrent installs', async () => {
    const ctx = context()
    ;(ctx.getSettings() as { phpBinary: string }).phpBinary = '/definitely/not/php'
    const a: string[] = []
    const b: string[] = []
    const [s1, s2] = await Promise.all([installSandbox(ctx, (l) => a.push(l)), installSandbox(ctx, (l) => b.push(l))])
    for (const status of [s1, s2]) {
      expect(status).toMatchObject({ installed: false, installing: false, error: 'PHP binary not found: /definitely/not/php' })
    }
    expect(a).toContain('Error: PHP binary not found: /definitely/not/php')
    expect(b).toContain('Error: PHP binary not found: /definitely/not/php')
    expect((await sandboxStatus(ctx)).error).toBe('PHP binary not found: /definitely/not/php')
  })
})
