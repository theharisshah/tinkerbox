import { randomUUID } from 'node:crypto'
import type { DumpNode, HistoryEntry, RunRequest, RunResult } from '../../shared/types'
import { cloneJson, consoleLogger, isFiniteNumber, isPlainObject, truncate, type Logger, type NoticeSink } from './common'
import { JsonStore } from './jsonStore'

interface HistoryData {
  entries: HistoryEntry[]
}

/**
 * Code larger than this is not stored in history: a handful of huge scripts would otherwise bloat history.json
 * (it is rewritten on every run) and slow down the History modal.
 */
export const MAX_HISTORY_CODE = 512 * 1024

/** VarDumper-like one-line preview of a dumped value. */
export function previewDump(node: DumpNode | null | undefined, max = 120): string {
  return truncate(previewNode(node, 0), max)
}

function previewNode(node: DumpNode | null | undefined, depth: number): string {
  if (!node) return 'null'
  switch (node.t) {
    case 'null':
      return 'null'
    case 'bool':
      return node.v ? 'true' : 'false'
    case 'int':
    case 'float':
      return node.v
    case 'string':
      return JSON.stringify(node.binary ? node.v : truncate(node.v, 100))
    case 'array': {
      if (node.count === 0) return '[]'
      if (depth > 0) return `array:${node.count} [...]`
      const parts = node.items.slice(0, 5).map((item) => {
        const value = previewNode(item.v, depth + 1)
        return typeof item.k === 'number' ? value : `${JSON.stringify(item.k)} => ${value}`
      })
      if (parts.length === 0) return `array:${node.count} [...]`
      return `[${parts.join(', ')}${node.count > parts.length ? ', …' : ''}]`
    }
    case 'object': {
      const summary =
        node.summary ?? (node.kind === 'collection' && node.count !== undefined ? `count: ${node.count}` : undefined)
      return summary ? `${node.class} {#${node.id} ${summary}}` : `${node.class} {#${node.id}}`
    }
    case 'ref':
      return `${node.class} {#${node.id}}`
    case 'enum':
      return `${node.class}::${node.case}`
    case 'closure':
      return `Closure${node.signature}`
    case 'resource':
      return `resource(${node.type})`
    case 'max-depth':
      return node.class ? `${node.class} {…}` : `${node.type} …`
    default:
      return '…'
  }
}

/** One-line summary of a run for the History list. */
export function runPreview(result: RunResult): string {
  if (result.cancelled) return 'Cancelled'
  if (result.timedOut) return 'Timed out'
  if (result.error) return truncate(result.error.replace(/\s+/g, ' '), 200)
  if (result.exception) {
    return truncate(`${result.exception.class}: ${result.exception.message}`.replace(/\s+/g, ' '), 200)
  }
  if (result.hasReturnValue && result.returnValue) return previewDump(result.returnValue, 200)
  for (const event of result.events) {
    if (event.kind === 'echo' && event.text.trim() !== '') return truncate(event.text.trim().replace(/\s+/g, ' '), 200)
    if (event.kind === 'dump') return previewDump(event.value, 200)
  }
  const raw = result.rawOutput.trim()
  return raw ? truncate(raw.replace(/\s+/g, ' '), 200) : ''
}

export function historyEntryFromRun(
  request: Pick<RunRequest, 'code'>,
  result: RunResult,
  connectionName: string,
  id: string = randomUUID()
): HistoryEntry {
  return {
    id,
    code: request.code,
    connectionId: result.connectionId,
    connectionName,
    ranAt: result.finishedAt,
    durationMs: Math.round(result.totalMs),
    ok: result.ok,
    preview: runPreview(result)
  }
}

function sanitizeEntry(input: unknown): HistoryEntry | null {
  if (!isPlainObject(input)) return null
  if (typeof input.id !== 'string' || typeof input.code !== 'string') return null
  return {
    id: input.id,
    code: input.code,
    connectionId: typeof input.connectionId === 'string' ? input.connectionId : '',
    connectionName: typeof input.connectionName === 'string' ? input.connectionName : '',
    ranAt: isFiniteNumber(input.ranAt) ? input.ranAt : 0,
    durationMs: isFiniteNumber(input.durationMs) ? input.durationMs : 0,
    ok: input.ok !== false,
    preview: typeof input.preview === 'string' ? input.preview : ''
  }
}

/** history.json — newest first, capped at `historyLimit`. */
export class HistoryStore {
  private readonly store: JsonStore<HistoryData>
  private limit: number

  constructor(
    file: string,
    limit: number,
    opts: { onNotice?: NoticeSink; logger?: Logger; debounceMs?: number } = {}
  ) {
    this.limit = Math.max(0, Math.floor(limit))
    this.store = new JsonStore<HistoryData>({
      file,
      label: 'History',
      defaults: () => ({ entries: [] }),
      normalize: (raw) => {
        if (!isPlainObject(raw) || !Array.isArray(raw.entries)) throw new Error('history.json must contain "entries"')
        const entries: HistoryEntry[] = []
        for (const item of raw.entries) {
          const entry = sanitizeEntry(item)
          if (entry) entries.push(entry)
        }
        entries.sort((a, b) => b.ranAt - a.ranAt)
        return { entries: entries.slice(0, this.limit) }
      },
      debounceMs: opts.debounceMs ?? 500,
      onNotice: opts.onNotice,
      logger: opts.logger ?? consoleLogger
    })
  }

  list(): HistoryEntry[] {
    return cloneJson(this.store.value.entries)
  }

  /**
   * Add a run. Re-running the same code on the same connection moves the existing entry to the top instead of
   * adding a duplicate. Returns false when the entry was not stored (history disabled or code too large).
   */
  add(entry: HistoryEntry): boolean {
    if (this.limit === 0 || entry.code.trim() === '' || entry.code.length > MAX_HISTORY_CODE) return false
    const current = this.store.value.entries
    const rest =
      current.length > 0 && current[0].code === entry.code && current[0].connectionId === entry.connectionId
        ? current.slice(1)
        : current
    this.store.set({ entries: [entry, ...rest].slice(0, this.limit) })
    return true
  }

  delete(id: string): boolean {
    const entries = this.store.value.entries
    if (!entries.some((e) => e.id === id)) return false
    this.store.set({ entries: entries.filter((e) => e.id !== id) })
    return true
  }

  clear(): void {
    this.store.set({ entries: [] })
  }

  /** Apply a new `historyLimit` (trims immediately when lowered). */
  setLimit(limit: number): void {
    this.limit = Math.max(0, Math.floor(limit))
    const entries = this.store.value.entries
    if (entries.length > this.limit) this.store.set({ entries: entries.slice(0, this.limit) })
  }

  flushSync(): boolean {
    return this.store.flushSync()
  }

  dispose(): void {
    this.store.dispose()
  }
}
