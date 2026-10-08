import type { EventChannel, EventChannels, InvokeArgs, InvokeChannel, InvokeReturn, TinkerboxBridge } from '@shared/ipc'
import type { RunRequest, RunResult } from '@shared/types'
import { createMockBridge } from '@/api.mock'
import type { EditorBridge, EditorSelection } from '@/editorBridge'

type Handler<C extends InvokeChannel> = (...args: InvokeArgs<C>) => InvokeReturn<C> | Promise<InvokeReturn<C>>
export type Overrides = { [C in InvokeChannel]?: Handler<C> }

export interface FakeBridge {
  bridge: TinkerboxBridge
  calls: Array<{ channel: InvokeChannel; args: unknown[] }>
  callsTo<C extends InvokeChannel>(channel: C): Array<InvokeArgs<C>>
  emit<E extends EventChannel>(channel: E, payload: EventChannels[E]): void
}

/** In-memory bridge (the browser mock) with per-channel overrides, call recording and event emission. */
export function fakeBridge(overrides: Overrides = {}): FakeBridge {
  const base = createMockBridge('darwin')
  const calls: FakeBridge['calls'] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const bridge: TinkerboxBridge = {
    platform: 'darwin',
    async invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeReturn<C>> {
      calls.push({ channel, args: JSON.parse(JSON.stringify(args ?? [])) as unknown[] })
      const override = overrides[channel] as Handler<C> | undefined
      if (override) return override(...args)
      return base.invoke(channel, ...args)
    },
    on<E extends EventChannel>(channel: E, listener: (payload: EventChannels[E]) => void): () => void {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      const wrapped = listener as (payload: unknown) => void
      set.add(wrapped)
      const offBase = base.on(channel, listener)
      return () => {
        set.delete(wrapped)
        offBase()
      }
    }
  }
  return {
    bridge,
    calls,
    callsTo<C extends InvokeChannel>(channel: C): Array<InvokeArgs<C>> {
      return calls.filter((c) => c.channel === channel).map((c) => c.args as InvokeArgs<C>)
    },
    emit<E extends EventChannel>(channel: E, payload: EventChannels[E]): void {
      for (const l of listeners.get(channel) ?? []) l(payload)
    }
  }
}

export function okResult(request: RunRequest, patch: Partial<RunResult> = {}): RunResult {
  return {
    runId: request.runId,
    tabId: request.tabId,
    connectionId: request.connectionId ?? 'scratch',
    ok: true,
    phpVersion: '8.3.12',
    driver: null,
    events: [],
    hasReturnValue: true,
    returnValue: { t: 'int', v: '42' },
    magic: [],
    coverage: [1],
    exception: null,
    diagnostics: [],
    bootMs: 0,
    durationMs: 1.5,
    memoryPeak: 2 * 1024 * 1024,
    totalMs: 30,
    stderr: '',
    rawOutput: '',
    exitCode: 0,
    finishedAt: Date.now(),
    ...patch
  }
}

/** Editor bridge double backed by a string buffer. */
export function fakeEditor(initial: string, selection: EditorSelection | null = null) {
  const state = { code: initial, selection, cursorLine: 1, prettified: 0, decorated: [] as RunResult[], cleared: 0, focused: 0 }
  const editor: EditorBridge = {
    getCode: () => state.code,
    getSelection: () => state.selection,
    insertText: (text) => {
      state.code += text
    },
    replaceAll: (code) => {
      state.code = code
    },
    focus: () => {
      state.focused++
    },
    revealLine: () => undefined,
    applyRunDecorations: (result) => {
      state.decorated.push(result)
    },
    clearDecorations: () => {
      state.cleared++
    },
    getCursorLine: () => state.cursorLine,
    prettify: async () => {
      state.prettified++
      state.code = state.code.replace(/\s+;/g, ';')
    }
  }
  return { editor, state }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
