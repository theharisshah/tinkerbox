import { chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { extractMarkedPath, loadShellPath, mergePathValues } from '../../../src/main/env/shellPath'
import { expandHome, findExecutable, isPhpScript, pathDirectories } from '../../../src/main/env/which'
import { PromiseCache } from '../../../src/main/execution/cache'
import { cleanupTempDirs, makeTempDir, writeTree } from './helpers'

afterAll(cleanupTempDirs)

describe('shell PATH', () => {
  it('merges PATH values with preference order and without duplicates', () => {
    expect(mergePathValues('/a:/b', '/b:/c::/a', ':')).toBe('/a:/b:/c')
    expect(mergePathValues('', '/x', ':')).toBe('/x')
  })

  it('extracts the PATH printed between markers, ignoring shell banners', () => {
    expect(extractMarkedPath('Welcome!\n__TINKERBOX_PATH_START__/usr/bin:/bin__TINKERBOX_PATH_END__\nbye')).toBe('/usr/bin:/bin')
    expect(extractMarkedPath('no markers')).toBeNull()
    expect(extractMarkedPath('__TINKERBOX_PATH_START__/x')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('loads the login shell PATH once and keeps existing entries', async () => {
    const before = pathDirectories()
    const first = loadShellPath()
    expect(loadShellPath()).toBe(first)
    await first
    const after = (process.env.PATH ?? '').split(delimiter)
    for (const dir of before) expect(after).toContain(dir)
    expect(new Set(after).size).toBe(after.length)
  })
})

describe('which helpers', () => {
  it('expands ~', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/x/y')).toBe(join(homedir(), 'x/y'))
    expect(expandHome('/abs')).toBe('/abs')
  })

  it.skipIf(process.platform === 'win32')('finds executables on PATH and by path', () => {
    expect(findExecutable('sh')).toMatch(/\/sh$/)
    expect(findExecutable('/bin/sh')).toBe('/bin/sh')
    expect(findExecutable('definitely-not-a-command-xyz')).toBeNull()
    const dir = makeTempDir()
    writeTree(dir, { tool: '#!/bin/sh\n' })
    expect(findExecutable('tool', [dir])).toBeNull() // not executable yet
    chmodSync(join(dir, 'tool'), 0o755)
    expect(findExecutable('tool', [dir])).toBe(join(dir, 'tool'))
  })

  it('recognises PHP scripts', () => {
    const dir = makeTempDir()
    writeTree(dir, { a: '#!/usr/bin/env php\n<?php', b: '<?php echo 1;', c: '#!/bin/sh\necho', 'd.phar': '' })
    expect(isPhpScript(join(dir, 'a'))).toBe(true)
    expect(isPhpScript(join(dir, 'b'))).toBe(true)
    expect(isPhpScript(join(dir, 'c'))).toBe(false)
    expect(isPhpScript(join(dir, 'd.phar'))).toBe(true)
  })
})

describe('PromiseCache', () => {
  it('shares in-flight work, honours the TTL and force, and never caches failures', async () => {
    const cache = new PromiseCache<number>(50)
    let calls = 0
    const factory = async (): Promise<number> => ++calls
    const [a, b] = await Promise.all([cache.get('k', factory), cache.get('k', factory)])
    expect([a, b, calls]).toEqual([1, 1, 1])
    expect(await cache.get('k', factory, true)).toBe(2)
    await new Promise((r) => setTimeout(r, 60))
    expect(await cache.get('k', factory)).toBe(3)
    await expect(cache.get('bad', () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await Promise.resolve()
    expect(await cache.get('bad', factory)).toBe(4)
    cache.deleteWhere((k) => k === 'k')
    expect(await cache.get('k', factory)).toBe(5)
    cache.clear()
    expect(cache.size).toBe(0)
  })
})
