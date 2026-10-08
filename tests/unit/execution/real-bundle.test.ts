/**
 * Smoke tests against the real runner bundle (resources/php) through the local transport. These need the
 * finished P1 runner; checks needing the finished drivers (P3) are skipped while those are still stubs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SCRATCH_CONNECTION_ID } from '@shared/types'
import { projectSnippets, runCode, runDataMode } from '../../../src/main/execution'
import { cleanupTempDirs, fakeContext, hasHerdPhp, localConnection, makeTempDir, repoRoot, runRequest, writeTree } from './helpers'

afterAll(cleanupTempDirs)

const isStub = (file: string): boolean => /STUB/.test(readFileSync(join(repoRoot, 'resources/php/src', file), 'utf8'))
const runnerIsStub = isStub('Runner.php') || isStub('Capture.php')
const driversAreStubs = isStub('DriverRegistry.php')
const laravelProject = [process.env.TINKERBOX_TEST_LARAVEL ?? '']
  .filter((p) => p !== '')
  .find((p) => existsSync(join(p, 'artisan')) && existsSync(join(p, 'vendor/autoload.php')))

describe.skipIf(!hasHerdPhp)('real runner bundle', () => {
  const ctx = fakeContext()

  it('produces an envelope for a data mode', async () => {
    const envelope = await runDataMode<unknown>(ctx, SCRATCH_CONNECTION_ID, 'detect')
    expect(envelope.mode).toBe('detect')
    expect(envelope.phpVersion).toMatch(/^8\.3\./)
  })

  it.skipIf(runnerIsStub)('runs code and returns the last expression', async () => {
    const result = await runCode(ctx, runRequest("$x = 20;\n$x + 22"), () => {})
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.returnValue).toMatchObject({ t: 'int', v: '42' })
  })

  it.skipIf(runnerIsStub)('reads project snippets with the runner', async () => {
    const dir = makeTempDir('tw-real-snippets-')
    writeTree(dir, { '.tinkerbox/snippets/count.php': "<?php\n/**\n * @label Count things\n * @description Counts\n */\nreturn 1;\n" })
    const c = fakeContext({ connections: { p: localConnection('p', dir) } })
    const snippets = await projectSnippets(c, 'p')
    expect(snippets).toEqual([expect.objectContaining({ id: 'project:p:count.php', name: 'Count things', description: 'Counts', source: 'project' })])
    expect(snippets[0].code.trim()).toBe('return 1;')
  })

  it.skipIf(runnerIsStub || driversAreStubs || !laravelProject)('boots a real Laravel project read-only', async () => {
    const c = fakeContext({ connections: { app: localConnection('app', laravelProject!) } })
    const result = await runCode(c, runRequest('app()->version()', { connectionId: 'app' }), () => {})
    expect(result.error).toBeUndefined()
    expect(result.driver?.id).toBe('laravel')
    expect(result.returnValue).toMatchObject({ t: 'string' })
  })
})
