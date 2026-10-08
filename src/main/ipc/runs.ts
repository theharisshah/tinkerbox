import type { EventChannels } from '../../shared/ipc'
import type { Connection, RunOptions, RunProgressEvent, RunRequest, RunResult } from '../../shared/types'
import { isFiniteNumber, isPlainObject, type Logger } from '../store/common'
import type { ConnectionsStore } from '../store/connections'
import { historyEntryFromRun, type HistoryStore } from '../store/history'
import type { StatsStore } from '../store/stats'
import { connectionIdOrNull, nonEmptyStr, obj, str } from './validate'

/** Largest script accepted from the renderer. */
export const MAX_CODE_LENGTH = 5 * 1024 * 1024

export interface RunServiceDeps {
  execute(request: RunRequest, onProgress: (event: RunProgressEvent) => void, signal?: AbortSignal): Promise<RunResult>
  resolveConnection(id: string | null): Connection
  /** Resolves when the login shell PATH is loaded (processes must not be spawned before). */
  envReady: Promise<void>
  connections: ConnectionsStore
  history: HistoryStore
  stats: StatsStore
  broadcast<E extends keyof EventChannels>(channel: E, payload: EventChannels[E]): void
  logger: Logger
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return isFiniteNumber(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

/** Validate RunOptions from the renderer, falling back to `defaults` for missing / invalid fields. */
export function sanitizeRunOptions(raw: unknown, defaults: RunOptions): RunOptions {
  const o = isPlainObject(raw) ? raw : {}
  const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
  return {
    maxDepth: clampInt(o.maxDepth, 1, 64, defaults.maxDepth),
    maxItems: clampInt(o.maxItems, 1, 100_000, defaults.maxItems),
    maxStringLength: clampInt(o.maxStringLength, 16, 10_000_000, defaults.maxStringLength),
    captureQueries: flag(o.captureQueries, defaults.captureQueries),
    magicComments: flag(o.magicComments, defaults.magicComments),
    coverage: flag(o.coverage, defaults.coverage),
    strictTypes: flag(o.strictTypes, defaults.strictTypes),
    outputType: o.outputType === 'realtime' || o.outputType === 'buffered' ? o.outputType : defaults.outputType,
    timeoutMs: clampInt(o.timeoutMs, 1_000, 86_400_000, defaults.timeoutMs)
  }
}

export function sanitizeRunRequest(raw: unknown, defaults: RunOptions): RunRequest {
  const r = obj(raw, 'request')
  const request: RunRequest = {
    runId: nonEmptyStr(r.runId, 'runId', 200),
    tabId: nonEmptyStr(r.tabId, 'tabId', 200),
    connectionId: connectionIdOrNull(r.connectionId),
    code: str(r.code, 'code', MAX_CODE_LENGTH),
    options: sanitizeRunOptions(r.options, defaults)
  }
  if (r.lineOffset !== undefined && r.lineOffset !== null) {
    request.lineOffset = clampInt(r.lineOffset, 1, 10_000_000, 1)
  }
  return request
}

/**
 * Runs code for the renderer and does the bookkeeping afterwards: history entry, usage stats, project recency and
 * the 'history:changed' event.
 */
export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  /**
   * Never rejects for run failures: the execution module reports them in `RunResult.error`. `signal` cancels the
   * run (also while it still waits for the login shell PATH).
   */
  async run(request: RunRequest, onProgress: (event: RunProgressEvent) => void = () => undefined, signal?: AbortSignal): Promise<RunResult> {
    await this.deps.envReady
    const result = await this.deps.execute(request, onProgress, signal)
    this.afterRun(request, result)
    return result
  }

  private afterRun(request: RunRequest, result: RunResult): void {
    const { logger } = this.deps
    let connection: Connection | null = null
    try {
      connection = this.deps.resolveConnection(request.connectionId)
    } catch (err) {
      // The project was removed while the code ran; the run result already carries the error.
      logger.warn('Run finished for an unknown project:', err)
    }
    const name = connection?.name || result.connectionId || 'PHP'
    try {
      this.deps.history.add(historyEntryFromRun(request, result, name))
    } catch (err) {
      logger.error('Could not record history entry', err)
    }
    try {
      this.deps.stats.record(result, name)
    } catch (err) {
      logger.error('Could not record usage stats', err)
    }
    if (connection) this.deps.connections.touch(connection.id)
    this.deps.broadcast('history:changed', undefined)
  }
}

/**
 * In-flight runs per renderer (web contents id). A window that is closed or reloaded can no longer send
 * run:cancel, so the shell cancels its runs through this registry instead of leaving the PHP processes running until
 * the app quits (on macOS the app keeps running without windows).
 */
export class RunOwners {
  private readonly byOwner = new Map<number, Set<AbortController>>()

  /** Register a run of `ownerId`: its signal aborts on cancelOwner(); call release() once the run finished. */
  start(ownerId: number): { signal: AbortSignal; release(): void } {
    const controller = new AbortController()
    let runs = this.byOwner.get(ownerId)
    if (!runs) {
      runs = new Set()
      this.byOwner.set(ownerId, runs)
    }
    runs.add(controller)
    return {
      signal: controller.signal,
      release: () => {
        const current = this.byOwner.get(ownerId)
        if (!current) return
        current.delete(controller)
        if (current.size === 0) this.byOwner.delete(ownerId)
      }
    }
  }

  /** Cancel every in-flight run of a window (closed / navigated away / reloaded). */
  cancelOwner(ownerId: number): void {
    const runs = this.byOwner.get(ownerId)
    if (!runs) return
    this.byOwner.delete(ownerId)
    for (const controller of runs) controller.abort()
  }

  /** Number of in-flight runs (of one window, or of all). */
  count(ownerId?: number): number {
    if (ownerId !== undefined) return this.byOwner.get(ownerId)?.size ?? 0
    let total = 0
    for (const runs of this.byOwner.values()) total += runs.size
    return total
  }
}
