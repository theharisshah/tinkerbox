import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { DEFAULT_SETTINGS } from '../../../src/shared/defaults'
import type { RunRequest, RunResult } from '../../../src/shared/types'
import type { ShellContext } from '../../../src/main/ipc/context'
import { executionHandlers } from '../../../src/main/ipc/execution'
import { RunOwners, RunService } from '../../../src/main/ipc/runs'
import { silentLogger } from './helpers'

describe('RunOwners', () => {
  it('aborts only the runs of the window that went away', () => {
    const owners = new RunOwners()
    const a1 = owners.start(1)
    const a2 = owners.start(1)
    const b = owners.start(2)
    expect(owners.count()).toBe(3)
    owners.cancelOwner(1)
    expect(a1.signal.aborted).toBe(true)
    expect(a2.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    expect(owners.count(1)).toBe(0)
    owners.cancelOwner(3) // unknown owner: no-op
  })

  it('forgets finished runs', () => {
    const owners = new RunOwners()
    const run = owners.start(1)
    run.release()
    run.release()
    expect(owners.count()).toBe(0)
    owners.cancelOwner(1)
    expect(run.signal.aborted).toBe(false)
  })
})

/** A WebContents stand-in: an EventEmitter with an id. */
class FakeSender extends EventEmitter {
  destroyed = false
  sent: string[] = []
  constructor(readonly id: number) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(channel: string): void {
    this.sent.push(channel)
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function setup() {
  const started: Array<{ request: RunRequest; signal?: AbortSignal }> = []
  const result = (request: RunRequest, cancelled: boolean): RunResult =>
    ({ runId: request.runId, tabId: request.tabId, connectionId: 'scratch', ok: !cancelled, cancelled, events: [], rawOutput: '' }) as unknown as RunResult
  // A run that only ends when it is cancelled (like `while (true) {}`).
  const runs = new RunService({
    execute: (request, _onProgress, signal) =>
      new Promise((resolve) => {
        started.push({ request, signal })
        signal?.addEventListener('abort', () => resolve(result(request, true)))
      }),
    resolveConnection: () => ({ id: 'scratch', name: 'PHP', type: 'local', path: '', createdAt: 0 }),
    envReady: Promise.resolve(),
    connections: { touch: () => undefined } as never,
    history: { add: () => undefined } as never,
    stats: { record: () => undefined } as never,
    broadcast: () => undefined,
    logger: silentLogger
  })
  const ctx = { settings: { get: () => DEFAULT_SETTINGS }, runs, envReady: Promise.resolve() } as unknown as ShellContext
  const handlers = executionHandlers(ctx)
  const start = (sender: FakeSender, runId: string): Promise<RunResult> =>
    handlers['run:start']({ sender: sender as unknown as WebContents } as never, { runId, tabId: 't', connectionId: null, code: 'while (true) {}' }) as Promise<RunResult>
  return { started, start }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('run:start ownership', () => {
  it('cancels the runs of a window when it is closed (destroyed)', async () => {
    const { started, start } = setup()
    const win1 = new FakeSender(1)
    const win2 = new FakeSender(2)
    const run1 = start(win1, 'r1')
    const run2 = start(win2, 'r2')
    await settle()
    expect(started).toHaveLength(2)
    win1.destroy()
    expect((await run1).cancelled).toBe(true)
    expect(started[1].signal?.aborted).toBe(false)
    win2.destroy()
    expect((await run2).cancelled).toBe(true)
  })

  it('cancels them when the renderer reloads / navigates, but not on same-document navigation', async () => {
    const { started, start } = setup()
    const win = new FakeSender(7)
    const run = start(win, 'r')
    await settle()
    win.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    win.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(started[0].signal?.aborted).toBe(false)
    win.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect((await run).cancelled).toBe(true)
    // Lifecycle listeners are installed once per window, not once per run.
    const again = start(win, 'r2')
    await settle()
    expect(win.listenerCount('destroyed')).toBe(1)
    expect(win.listenerCount('did-start-navigation')).toBe(1)
    win.destroy()
    expect((await again).cancelled).toBe(true)
  })
})
