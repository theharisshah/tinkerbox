import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CommandError, runCapture, spawnStreaming, summarizeOutput } from '../../../src/main/execution/process'

const posix = process.platform !== 'win32'

function processRunning(pattern: string): boolean {
  return spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout.trim() !== ''
}

describe.skipIf(!posix)('spawnStreaming', () => {
  it('writes input to stdin and streams stdout / stderr', async () => {
    const out: string[] = []
    const err: string[] = []
    const r = await spawnStreaming(
      { command: 'sh', args: ['-c', 'cat; echo oops >&2; exit 3'] },
      { input: 'héllo wörld', onStdout: (c) => out.push(c), onStderr: (c) => err.push(c) }
    )
    expect(r.stdout).toBe('héllo wörld')
    expect(out.join('')).toBe('héllo wörld')
    expect(r.stderr).toBe('oops\n')
    expect(err.join('')).toBe('oops\n')
    expect(r.exitCode).toBe(3)
    expect(r.timedOut || r.cancelled).toBe(false)
  })

  it('decodes multibyte characters split across chunks', async () => {
    const r = await spawnStreaming({ command: 'sh', args: ['-c', "printf '\\360\\237'; sleep 0.05; printf '\\220\\230'"] }, {})
    expect(r.stdout).toBe('🐘')
  })

  it('reports spawn failures without throwing', async () => {
    const r = await spawnStreaming({ command: '/definitely/not/here/php', args: [] }, { input: 'x' })
    expect(r.spawnError?.code).toBe('ENOENT')
  })

  it('kills the whole process group on timeout', async () => {
    const marker = `sleep 31.${process.pid}`
    const started = Date.now()
    const r = await spawnStreaming({ command: 'sh', args: ['-c', `${marker} & sleep 30; echo never`] }, { timeoutMs: 300 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.stdout).not.toContain('never')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(processRunning(marker)).toBe(false)
  })

  it('cancels via AbortSignal', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const started = Date.now()
    const r = await spawnStreaming({ command: 'sleep', args: ['30'] }, { signal: controller.signal })
    expect(r.cancelled).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('returns immediately when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await spawnStreaming({ command: 'sleep', args: ['30'] }, { signal: controller.signal })
    expect(r.cancelled).toBe(true)
    expect(r.exitCode).toBeNull()
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const started = Date.now()
    const r = await spawnStreaming({ command: 'sh', args: ['-c', "trap '' TERM; sleep 30 & wait"] }, { timeoutMs: 100, killGraceMs: 300 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('stops processes that exceed the output limit', async () => {
    const r = await spawnStreaming({ command: 'sh', args: ['-c', 'yes'] }, { maxOutputBytes: 100_000 })
    expect(r.outputLimitExceeded).toBe(true)
    expect(r.stdout.length).toBeLessThanOrEqual(100_000)
  })

  it('resolves even when a background grandchild keeps the pipes open', async () => {
    const started = Date.now()
    const marker = `sleep 32.${process.pid}`
    const r = await spawnStreaming({ command: 'sh', args: ['-c', `(${marker}) & echo done`] }, {})
    expect(r.stdout).toBe('done\n')
    expect(r.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(4000)
    spawnSync('pkill', ['-f', marker])
  })
})

describe.skipIf(!posix)('runCapture', () => {
  it('returns output on success', async () => {
    const r = await runCapture('sh', ['-c', 'echo ok'])
    expect(r.stdout).toBe('ok\n')
  })

  it('throws actionable errors', async () => {
    await expect(runCapture('/nope/composer', [], { label: 'Composer', missingHint: 'Install it.' })).rejects.toThrow('Composer not found on PATH. Install it.')
    await expect(runCapture('sh', ['-c', 'echo bad >&2; exit 2'], { label: 'step' })).rejects.toThrow(/step failed \(exit code 2\): bad/)
    await expect(runCapture('sleep', ['5'], { label: 'sleeper', timeoutMs: 100 })).rejects.toBeInstanceOf(CommandError)
  })

  it('can allow failures', async () => {
    const r = await runCapture('sh', ['-c', 'exit 4'], { allowFailure: true })
    expect(r.exitCode).toBe(4)
  })
})

describe('summarizeOutput', () => {
  it('strips ANSI codes and keeps the tail', () => {
    expect(summarizeOutput('\u001b[31mred\u001b[0m  ')).toBe('red')
    expect(summarizeOutput('a'.repeat(700) + 'END', 10)).toBe('…aaaaaaaEND')
  })
})
