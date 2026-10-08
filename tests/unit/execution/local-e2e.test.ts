/**
 * End-to-end runs through the real local transport (bundling, Herd PHP 8.3 spawn over stdin, streaming,
 * timeouts, cancellation, envelope parsing) with the protocol-compliant fixture runner in ./fixtures/php,
 * so the main-process pipeline is verified independently of the runner being built in resources/php
 * (see real-bundle.test.ts for the smoke test against the real runner).
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RunProgressEvent } from '@shared/types'
import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID } from '@shared/types'
import {
  cancelRun,
  introspectEnvironment,
  introspectMembers,
  invalidateCaches,
  listLogs,
  projectPanels,
  projectSnippets,
  readLog,
  runCode,
  runDataMode,
  testConnection
} from '../../../src/main/execution'
import { cleanupTempDirs, fakeContext as baseContext, hasHerdPhp, localConnection, makeTempDir, runOptions, runRequest, writeTree, type FakeContextOptions } from './helpers'

afterAll(cleanupTempDirs)

const fixtureResources = join(__dirname, 'fixtures')
const fakeContext = (options: FakeContextOptions = {}) => baseContext({ resourcesPath: fixtureResources, ...options })

function collect(): { events: Array<RunProgressEvent & { at: number }>; on: (e: RunProgressEvent) => void } {
  const events: Array<RunProgressEvent & { at: number }> = []
  return { events, on: (e) => events.push({ ...e, at: Date.now() }) }
}

const echoed = (result: { events: Array<{ kind: string; text?: string }>; rawOutput: string }, text: string): boolean =>
  result.events.some((e) => e.kind === 'echo' && (e.text ?? '').includes(text)) || result.rawOutput.includes(text)

describe.skipIf(!hasHerdPhp)('local transport end to end', () => {
  const ctx = fakeContext()

  it('runs code and returns the value of the last expression', async () => {
    const result = await runCode(ctx, runRequest('return 1 + 1;'), () => {})
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.connectionId).toBe(SCRATCH_CONNECTION_ID)
    expect(result.phpVersion).toMatch(/^8\.3\./)
    expect(result.hasReturnValue).toBe(true)
    expect(result.returnValue).toMatchObject({ t: 'int', v: '2' })
    expect(result.exitCode).toBe(0)
    expect(result.totalMs).toBeGreaterThan(0)
    expect(result.finishedAt).toBeLessThanOrEqual(Date.now())
  })

  it('captures echo output and exceptions', async () => {
    const echo = await runCode(ctx, runRequest("echo 'hello from php';"), () => {})
    expect(echoed(echo, 'hello from php')).toBe(true)

    const failed = await runCode(ctx, runRequest("throw new RuntimeException('boom');"), () => {})
    expect(failed.ok).toBe(false)
    expect(failed.error).toBeUndefined()
    expect(failed.exception).toMatchObject({ class: 'RuntimeException', message: 'boom' })
  })

  it('streams output written outside the envelope while the script is still running', async () => {
    const progress = collect()
    const code = [
      "$out = fopen('php://stdout', 'w');",
      "fwrite($out, \"tick\\n\"); fflush($out);",
      "fwrite(fopen('php://stderr', 'w'), \"warn\\n\");",
      'usleep(700000);',
      'return 42;'
    ].join('\n')
    const result = await runCode(ctx, runRequest(code, { options: runOptions({ outputType: 'realtime' }) }), progress.on)
    const finished = Date.now()
    expect(result.ok).toBe(true)
    const tick = progress.events.find((e) => e.stream === 'stdout' && e.chunk.includes('tick'))
    expect(tick).toBeDefined()
    expect(finished - tick!.at).toBeGreaterThan(400) // arrived long before the run finished
    expect(progress.events.some((e) => e.stream === 'stderr' && e.chunk.includes('warn'))).toBe(true)
    expect(progress.events.every((e) => e.runId === result.runId && e.tabId === 'tab-1')).toBe(true)
    // The envelope JSON is never streamed.
    expect(progress.events.some((e) => e.chunk.includes('BEGIN') || e.chunk.includes('"phpVersion"'))).toBe(false)
    expect(result.rawOutput).toContain('tick')
    expect(result.stderr).toContain('warn')
  })

  it('times out long-running scripts', async () => {
    const started = Date.now()
    const result = await runCode(ctx, runRequest('sleep(30);', { options: runOptions({ timeoutMs: 500 }) }), () => {})
    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timed out after 0\.5s/)
    expect(Date.now() - started).toBeLessThan(6000)
  })

  it('cancels a run and kills processes started by the script', async () => {
    const marker = `sleep 33.${process.pid}`
    const request = runRequest(`shell_exec('${marker}');`)
    const started = Date.now()
    setTimeout(() => cancelRun(request.runId), 400)
    const result = await runCode(ctx, request, () => {})
    expect(result.cancelled).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Execution cancelled.')
    expect(Date.now() - started).toBeLessThan(4000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim()).toBe('')
  })

  it("cancels through the caller's signal (window closed) and never spawns for an already aborted one", async () => {
    const marker = `sleep 34.${process.pid}`
    const caller = new AbortController()
    const started = Date.now()
    setTimeout(() => caller.abort(), 400)
    const result = await runCode(ctx, runRequest(`shell_exec('${marker}');`), () => {}, caller.signal)
    expect(result.cancelled).toBe(true)
    expect(result.error).toBe('Execution cancelled.')
    expect(Date.now() - started).toBeLessThan(4000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim()).toBe('')

    const early = await runCode(ctx, runRequest("echo 'must not run';"), () => {}, AbortSignal.abort())
    expect(early.cancelled).toBe(true)
    expect(early.rawOutput).toBe('')
  })

  it('ignores cancelling unknown runs', () => {
    expect(() => cancelRun('no-such-run')).not.toThrow()
  })

  it('reports a missing PHP binary and a missing project directory', async () => {
    const noPhp = fakeContext({ settings: { phpBinary: '/definitely/not/php' } })
    const r1 = await runCode(noPhp, runRequest('return 1;'), () => {})
    expect(r1.ok).toBe(false)
    expect(r1.error).toBe('PHP binary not found: /definitely/not/php')

    const missing = fakeContext({ connections: { gone: localConnection('gone', '/definitely/not/a/project') } })
    const r2 = await runCode(missing, runRequest('return 1;', { connectionId: 'gone' }), () => {})
    expect(r2.error).toBe('Project directory not found: /definitely/not/a/project')
    expect(r2.connectionId).toBe('gone')

    const unknown = await runCode(ctx, runRequest('return 1;', { connectionId: 'unknown-id' }), () => {})
    expect(unknown.error).toMatch(/no longer exists/)
  })

  it('runs in the project directory and passes the project path', async () => {
    const dir = makeTempDir('tw-project-')
    const projectCtx = fakeContext({ connections: { proj: localConnection('proj', dir) } })
    const result = await runCode(projectCtx, runRequest('return getcwd();', { connectionId: 'proj' }), () => {})
    expect(result.ok).toBe(true)
    expect(result.returnValue).toMatchObject({ t: 'string' })
    const cwd = (result.returnValue as { v: string }).v
    expect(cwd.replace(/^\/private/, '')).toBe(dir.replace(/^\/private/, ''))
  })

  it('runs the Default tab as plain PHP while no sandbox is installed', async () => {
    const result = await runCode(ctx, runRequest('return PHP_MAJOR_VERSION;', { connectionId: SANDBOX_CONNECTION_ID }), () => {})
    expect(result.ok).toBe(true)
    expect(result.connectionId).toBe(SANDBOX_CONNECTION_ID)
  })

  it('runs data modes and returns the data envelope', async () => {
    const envelope = await runDataMode<unknown>(ctx, SCRATCH_CONNECTION_ID, 'detect')
    expect(envelope.mode).toBe('detect')
    expect(envelope.phpVersion).toMatch(/^8\.3\./)
  })

  it('tests a connection by running PHP', async () => {
    const result = await testConnection(ctx, localConnection(SCRATCH_CONNECTION_ID, ''))
    expect(result.phpVersion).toMatch(/^8\.3\./)
    expect(result.durationMs).toBeGreaterThan(0)
    const broken = await testConnection(fakeContext({ settings: { phpBinary: '/nope/php' } }), localConnection('x', ''))
    expect(broken).toMatchObject({ ok: false, message: 'PHP binary not found: /nope/php' })
  })

  it('returns no project snippets without a snippets folder (no PHP process)', async () => {
    const dir = makeTempDir('tw-nosnippets-')
    const c = fakeContext({ connections: { p: localConnection('p', dir) } })
    expect(await projectSnippets(c, 'p')).toEqual([])
    expect(await projectSnippets(c, SCRATCH_CONNECTION_ID)).toEqual([])
  })

  it('reads project snippets through the runner and maps them to read-only snippets', async () => {
    const dir = makeTempDir('tw-snippets-')
    writeTree(dir, {
      '.tinkerbox/snippets/count-users.php': "<?php\n/**\n * @label Count users\n * @description How many users\n */\nreturn 42;\n",
      '.tinkerbox/snippets/readme.txt': 'ignored'
    })
    const c = fakeContext({ connections: { p: localConnection('p', dir) } })
    const snippets = await projectSnippets(c, 'p')
    expect(snippets).toHaveLength(1)
    expect(snippets[0]).toMatchObject({
      id: 'project:p:count-users.php',
      name: 'Count users',
      description: 'How many users',
      code: 'return 42;',
      connectionId: 'p',
      source: 'project'
    })
    expect(snippets[0].updatedAt).toBeGreaterThan(0)
  })

  it('sends the documented payload', async () => {
    const dir = makeTempDir('tw-payload-')
    const c = fakeContext({ connections: { p: localConnection('p', dir, { driver: 'laravel' }) } })
    const result = await runCode(c, runRequest("echo 'x';", { connectionId: 'p', lineOffset: 7, options: runOptions({ strictTypes: true }) }), () => {})
    const payload = (result as unknown as { payload?: unknown }).payload
    expect(payload).toBeUndefined() // extra envelope keys are not leaked into RunResult
    const envelope = await runDataMode<unknown>(c, 'p', 'members', { className: 'App\\Models\\User' })
    const sent = (envelope as unknown as { payload: Record<string, unknown> }).payload
    expect(sent).toMatchObject({ mode: 'members', driver: 'laravel', className: 'App\\Models\\User', lineOffset: 1, logLimit: 500, homePath: homedir() })
    expect((sent.projectPath as string).replace(/^\/private/, '')).toBe(dir.replace(/^\/private/, ''))
    expect(sent.nonce).toMatch(/^tw_[0-9a-f]{24}$/)
    expect(sent.options).toMatchObject({ magicComments: false, coverage: false, outputType: 'buffered' })
    expect(result.driver?.id).toBe('laravel')
  })

  it('caches environment and member introspection per connection', async () => {
    const dir = makeTempDir('tw-intro-')
    const c = fakeContext({ connections: { p: localConnection('p', dir) } })
    const env1 = await introspectEnvironment(c, { connectionId: 'p' })
    expect(env1.phpVersion).toMatch(/^8\.3\./)
    expect(env1.functions[0]).toMatchObject({ name: 'strlen' })
    expect(await introspectEnvironment(c, { connectionId: 'p' })).toBe(env1)
    const forced = await introspectEnvironment(c, { connectionId: 'p', force: true })
    expect(forced).not.toBe(env1)
    invalidateCaches('p')
    expect(await introspectEnvironment(c, { connectionId: 'p' })).not.toBe(forced)

    const m1 = await introspectMembers(c, { connectionId: 'p', className: '\\ArrayObject' })
    expect(m1).toMatchObject({ class: 'ArrayObject' })
    expect(await introspectMembers(c, { connectionId: 'p', className: 'ArrayObject' })).toBe(m1)
    expect(await introspectMembers(c, { connectionId: 'p', className: 'Missing' })).toBeNull()
    expect(await introspectMembers(c, { connectionId: 'p' })).toBeNull()
    invalidateCaches()
  })

  it('lists logs, reads a log, loads panels', async () => {
    const dir = makeTempDir('tw-logs-')
    const c = fakeContext({ connections: { p: localConnection('p', dir) } })
    expect((await listLogs(c, 'p')).root).toContain('storage/logs')
    expect(await listLogs(c, SCRATCH_CONNECTION_ID)).toEqual({ root: '', files: [] })
    expect(await readLog(c, { connectionId: 'p', file: 'laravel.log', limit: 25 })).toEqual([
      { datetime: '2026-01-01 00:00:00', level: 'info', message: 'laravel.log:25' }
    ])
    expect(await projectPanels(c, 'p')).toEqual([{ title: 'App Information', sections: [] }])
  })
})
