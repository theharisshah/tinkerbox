/**
 * The Transport extension point: a registered transport takes over runs for the connections it supports
 * without touching runCode (this is how SSH / Docker transports will plug in later).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Connection } from '@shared/types'
import { registerTransport, registeredTransports, runCode, runDataMode, transportFor, unregisterTransport, type Transport } from '../../../src/main/execution'
import { cleanupTempDirs, fakeContext, localConnection, runOptions, runRequest } from './helpers'

/** Decode the payload embedded in a bundle by buildInvocation(). */
function payloadOf(script: string): Record<string, unknown> {
  const b64 = /base64_decode\('([A-Za-z0-9+/=]+)'\), true\)\);\n}\n$/.exec(script)?.[1]
  if (!b64) throw new Error('payload not found')
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
}

function cannedTransport(id: string, reply: (payload: Record<string, unknown>) => { stdout: string; stderr?: string; exitCode?: number | null }): Transport & { calls: number } {
  const t = {
    id,
    calls: 0,
    supports: (c: Connection) => c.id.startsWith('remote:'),
    payloadDefaults: () => ({ projectPath: '/srv/app', homePath: '' }),
    async run(req: Parameters<Transport['run']>[0]) {
      t.calls++
      const r = reply(payloadOf(req.script))
      req.onStdout(r.stdout)
      return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0, timedOut: false, cancelled: false }
    }
  }
  return t
}

const envelope = (nonce: string, data: Record<string, unknown>): string => `noise\n${nonce}BEGIN\n${JSON.stringify(data)}\n${nonce}END\n`

afterEach(() => {
  unregisterTransport('fake')
  cleanupTempDirs()
})

describe('transport registry', () => {
  it('uses the local transport by default', () => {
    expect(registeredTransports().map((t) => t.id)).toContain('local')
    expect(transportFor(localConnection('x', '/tmp')).id).toBe('local')
  })

  it('routes supported connections to a registered transport with its payload defaults', async () => {
    const fake = cannedTransport('fake', (p) => ({
      stdout: envelope(p.nonce as string, {
        version: 1,
        mode: 'run',
        phpVersion: '8.4.1',
        driver: { id: 'laravel', name: 'Laravel' },
        events: [],
        hasReturnValue: true,
        returnValue: { t: 'string', v: `${p.projectPath}|${p.homePath}`, len: 1 },
        magic: [],
        coverage: [],
        exception: null,
        diagnostics: [],
        bootMs: 1,
        durationMs: 2,
        memoryPeak: 3
      })
    }))
    registerTransport(fake)
    const ctx = fakeContext({ connections: { 'remote:1': localConnection('remote:1', '/local/checkout') } })
    const progress: string[] = []
    const result = await runCode(ctx, runRequest('1', { connectionId: 'remote:1' }), (e) => progress.push(e.chunk))
    expect(fake.calls).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.returnValue).toEqual({ t: 'string', v: '/srv/app|', len: 1 })
    expect(result.rawOutput).toBe('noise')
    expect(progress.join('')).toBe('noise')
    expect(transportFor(localConnection('other', '')).id).toBe('local')
  })

  it('explains a missing envelope', async () => {
    registerTransport(cannedTransport('fake', () => ({ stdout: 'Segmentation fault', stderr: 'PHP Fatal error: oops', exitCode: 139 })))
    const ctx = fakeContext({ connections: { 'remote:1': localConnection('remote:1', '') } })
    const result = await runCode(ctx, runRequest('1', { connectionId: 'remote:1' }), () => {})
    expect(result.ok).toBe(false)
    expect(result.error).toBe('PHP exited with code 139 without reporting a result: PHP Fatal error: oops')
    expect(result.rawOutput).toBe('Segmentation fault')
    await expect(runDataMode(ctx, 'remote:1', 'detect')).rejects.toThrow(/exited with code 139/)
  })

  it('explains a runner that cannot be compiled and a truncated envelope', async () => {
    registerTransport(
      cannedTransport('fake', (p) =>
        p.mode === 'run'
          ? { stdout: '', stderr: 'PHP Parse error: syntax error, unexpected token in Standard input code on line 12', exitCode: 255 }
          : { stdout: `${p.nonce}BEGIN\n{"version":1`, exitCode: null }
      )
    )
    const ctx = fakeContext({ connections: { 'remote:1': localConnection('remote:1', '') } })
    const result = await runCode(ctx, runRequest('1', { connectionId: 'remote:1', options: runOptions() }), () => {})
    expect(result.error).toMatch(/^PHP could not compile the Tinkerbox runner \(Tinkerbox needs PHP 7\.4 or newer\)/)
    await expect(runDataMode(ctx, 'remote:1', 'detect')).rejects.toThrow('The PHP process stopped while reporting its result (the output was cut off).')
  })

  it('reports a rejected transport as a failed run (never throws)', async () => {
    registerTransport({ id: 'fake', supports: (c) => c.id === 'remote:x', run: () => Promise.reject(new Error('SSH authentication failed for forge@example.com')) })
    const ctx = fakeContext({ connections: { 'remote:x': localConnection('remote:x', '') } })
    const result = await runCode(ctx, runRequest('1', { connectionId: 'remote:x' }), () => {})
    expect(result).toMatchObject({ ok: false, error: 'SSH authentication failed for forge@example.com', connectionId: 'remote:x' })
  })
})
