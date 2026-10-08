import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import {
  clearPhpBinaryCaches,
  findPhpBinaries,
  inspectPhpBinary,
  locatePhpBinary,
  phpBinarySource,
  resolvePhpBinary
} from '../../../src/main/php/binaries'
import { aliasToVersion, herdIniEnv, herdPaths, herdVersionDigits, herdXdebugExtension, isHerdAlias, isHerdBinary } from '../../../src/main/php/herd'
import { hasHerdPhp, herdBin, herdPhp83, localConnection } from './helpers'

describe('Herd helpers', () => {
  it('parses aliases', () => {
    expect(aliasToVersion('php83')).toBe('8.3')
    expect(aliasToVersion('php74')).toBe('7.4')
    expect(aliasToVersion('php')).toBeNull()
    expect(isHerdAlias('php85')).toBe(true)
    expect(isHerdAlias('php8.3')).toBe(false)
  })

  it('knows the platform layout', () => {
    expect(herdPaths('/Users/me', 'darwin')?.bin).toBe('/Users/me/Library/Application Support/Herd/bin')
    expect(herdPaths('/home/me', 'linux')).toBeNull()
    expect(herdPaths('C:\\Users\\me', 'win32')?.bin).toContain('herd')
  })
})

describe.skipIf(!hasHerdPhp)('PHP binary discovery on this machine', () => {
  it('finds Herd binaries with aliases, versions and no duplicate realpaths', async () => {
    clearPhpBinaryCaches()
    const binaries = await findPhpBinaries()
    const php83 = binaries.find((b) => b.alias === 'php83')
    expect(php83).toMatchObject({ path: herdPhp83, source: 'Herd' })
    expect(php83!.version).toMatch(/^8\.3\.\d+$/)
    expect(php83!.versionLine).toMatch(/^PHP 8\.3\.\d+ \(cli\)/)
    const reals = binaries.map((b) => realpathSync(b.path))
    expect(new Set(reals).size).toBe(reals.length)
    // Herd comes first (preference order).
    expect(binaries[0].source).toBe('Herd')
    // Cached for 60 s: same promise result.
    expect(await findPhpBinaries()).toBe(binaries)
  })

  it('inspects paths and Herd aliases, rejecting non-PHP files', async () => {
    expect(await inspectPhpBinary('php82')).toMatchObject({ alias: 'php82', source: 'Herd', version: expect.stringMatching(/^8\.2\./) })
    expect(await inspectPhpBinary(herdPhp83)).toMatchObject({ version: expect.stringMatching(/^8\.3\./) })
    expect(await inspectPhpBinary('/definitely/missing/php')).toBeNull()
    expect(await inspectPhpBinary('/bin/ls')).toBeNull()
    expect(await inspectPhpBinary('')).toBeNull()
  })

  it("inspects 'auto' as the binary automatic detection runs (Herd's default php)", async () => {
    const auto = await inspectPhpBinary('auto')
    const { path } = await resolvePhpBinary({ ...DEFAULT_SETTINGS, phpBinary: 'auto' })
    expect(auto?.path).toBe(path)
    expect(auto?.source).toBe('Herd')
    expect(auto?.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('resolves auto to Herd and applies Herd per-version ini directories', async () => {
    const { path, env } = await resolvePhpBinary({ ...DEFAULT_SETTINGS, phpBinary: 'auto' })
    expect(path).toBe(join(herdBin, 'php'))
    const iniKeys = Object.keys(env).filter((k) => /^HERD_PHP_\d+_INI_SCAN_DIR$/.test(k))
    if (!process.env.HERD_PHP_83_INI_SCAN_DIR) expect(env.HERD_PHP_83_INI_SCAN_DIR).toMatch(/Herd\/config\/php\/83\/$/)
    for (const key of iniKeys) expect(env[key].endsWith('/')).toBe(true)
  })

  it('prefers the connection override and reports missing binaries', async () => {
    const r = await resolvePhpBinary({ ...DEFAULT_SETTINGS, phpBinary: 'auto' }, localConnection('p', '/tmp', { phpBinary: 'php82' }))
    expect(r.path).toBe(join(herdBin, 'php82'))
    const g = await resolvePhpBinary({ ...DEFAULT_SETTINGS, phpBinary: 'php84' })
    expect(g.path).toBe(join(herdBin, 'php84'))
    await expect(resolvePhpBinary({ ...DEFAULT_SETTINGS, phpBinary: '/nope/php' })).rejects.toThrow('PHP binary not found: /nope/php')
    await expect(resolvePhpBinary({ ...DEFAULT_SETTINGS, phpBinary: 'php99' })).rejects.toThrow('PHP binary not found: php99')
  })

  it('locates and classifies binaries', () => {
    expect(locatePhpBinary('php83')).toBe(herdPhp83)
    expect(locatePhpBinary('~/Library/Application Support/Herd/bin/php83')).toBe(herdPhp83)
    expect(phpBinarySource(join(herdBin, 'php'))).toBe('Herd')
    expect(isHerdBinary(join(herdBin, 'php'))).toBe(true)
    expect(herdVersionDigits(join(herdBin, 'php'))).toMatch(/^\d{2}$/)
    expect(herdVersionDigits('/usr/bin/true')).toBeNull()
  })

  it('exposes Herd ini dirs only for versions that exist', () => {
    const env = herdIniEnv(herdPaths(), {})
    expect(Object.keys(env)).toContain('HERD_PHP_83_INI_SCAN_DIR')
    expect(herdIniEnv(herdPaths(), { HERD_PHP_83_INI_SCAN_DIR: '/custom' }).HERD_PHP_83_INI_SCAN_DIR).toBeUndefined()
  })

  it('finds a bundled Xdebug extension only when the ini does not load one', () => {
    const ext = herdXdebugExtension('82')
    if (ext) expect(ext).toMatch(/xdebug-82-(arm64|x86)\.so$/)
    expect(herdXdebugExtension('99')).toBeNull()
  })
})
