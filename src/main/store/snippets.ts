import { randomUUID } from 'node:crypto'
import type { Snippet } from '../../shared/types'
import { cloneJson, consoleLogger, isFiniteNumber, isPlainObject, optionalString, type Logger, type NoticeSink } from './common'
import { JsonStore } from './jsonStore'

interface SnippetsData {
  snippets: Snippet[]
}

const MAX_SNIPPETS = 10_000
const MAX_CODE = 1_000_000

/** Validate a user snippet. Throws a TypeError for unusable input. */
export function sanitizeSnippet(input: unknown, now = Date.now()): Snippet {
  if (!isPlainObject(input)) throw new TypeError('Snippet must be an object')
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 300) : ''
  if (name === '') throw new TypeError('Snippet needs a name')
  if (typeof input.code !== 'string') throw new TypeError('Snippet needs code')
  if (input.code.length > MAX_CODE) throw new TypeError('Snippet code is too large (max 1 MB)')
  const snippet: Snippet = {
    id: typeof input.id === 'string' && input.id.trim() !== '' ? input.id.slice(0, 200) : randomUUID(),
    name,
    code: input.code,
    connectionId: typeof input.connectionId === 'string' ? input.connectionId.slice(0, 200) : '',
    source: 'user',
    createdAt: isFiniteNumber(input.createdAt) ? input.createdAt : now,
    updatedAt: isFiniteNumber(input.updatedAt) ? input.updatedAt : now
  }
  const description = optionalString(input.description, 5000)
  if (description !== undefined) snippet.description = description
  return snippet
}

function normalizeSnippetsData(raw: unknown, logger: Logger): SnippetsData {
  // Accept a bare array too (hand-edited files / older exports).
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) ? raw.snippets : undefined
  if (!Array.isArray(list)) throw new Error('snippets.json must contain a "snippets" array')
  const snippets: Snippet[] = []
  const ids = new Set<string>()
  for (const item of list.slice(0, MAX_SNIPPETS)) {
    try {
      const s = sanitizeSnippet(item, 0)
      if (ids.has(s.id)) s.id = randomUUID()
      ids.add(s.id)
      snippets.push(s)
    } catch (err) {
      logger.warn('Dropping invalid snippet from snippets.json:', err)
    }
  }
  return { snippets }
}

/**
 * Parse a snippets export. Accepts Tinkerbox exports (`{ app, version, snippets }`), bare arrays and the field
 * names common in other tools' exports (`label`/`title` for the name, `content` for the code).
 */
export function parseSnippetExport(text: string): unknown[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`The file is not valid JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  const list = Array.isArray(data) ? data : isPlainObject(data) && Array.isArray(data.snippets) ? data.snippets : null
  if (!list) throw new Error('The file does not contain a list of snippets')
  return list.map((item) => {
    if (!isPlainObject(item)) return item
    return {
      ...item,
      name: item.name ?? item.label ?? item.title,
      code: item.code ?? item.content
    }
  })
}

/** snippets.json — user snippets ('project' snippets are read from the project by the execution module). */
export class SnippetsStore {
  private readonly store: JsonStore<SnippetsData>

  constructor(
    file: string,
    private readonly opts: { onNotice?: NoticeSink; logger?: Logger; debounceMs?: number; now?: () => number } = {}
  ) {
    const logger = opts.logger ?? consoleLogger
    this.store = new JsonStore<SnippetsData>({
      file,
      label: 'Snippets',
      defaults: () => ({ snippets: [] }),
      normalize: (raw) => normalizeSnippetsData(raw, logger),
      pretty: true,
      debounceMs: opts.debounceMs,
      onNotice: opts.onNotice,
      logger
    })
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  list(): Snippet[] {
    return cloneJson(this.store.value.snippets)
  }

  /** Create or update a user snippet (by id). `source` is always 'user'. */
  save(input: unknown): Snippet {
    const now = this.now()
    const snippet = sanitizeSnippet(input, now)
    const list = this.store.value.snippets
    const existing = list.find((s) => s.id === snippet.id)
    if (existing) {
      snippet.createdAt = existing.createdAt
    } else if (list.length >= MAX_SNIPPETS) {
      throw new Error(`Too many snippets (max ${MAX_SNIPPETS})`)
    }
    snippet.updatedAt = now
    const snippets = existing ? list.map((s) => (s.id === snippet.id ? snippet : s)) : [...list, snippet]
    this.store.set({ snippets })
    return cloneJson(snippet)
  }

  delete(id: string): boolean {
    const list = this.store.value.snippets
    if (!list.some((s) => s.id === id)) return false
    this.store.set({ snippets: list.filter((s) => s.id !== id) })
    return true
  }

  /**
   * Merge imported snippets. Snippets identical to an existing one (same name and code) are skipped; colliding ids
   * get a new id. Returns the number of snippets added.
   */
  importMany(items: unknown[]): number {
    const now = this.now()
    const list = [...this.store.value.snippets]
    const ids = new Set(list.map((s) => s.id))
    const signatures = new Set(list.map((s) => `${s.name}\u0000${s.code}`))
    let added = 0
    for (const item of items) {
      let snippet: Snippet
      try {
        snippet = sanitizeSnippet(item, now)
      } catch (err) {
        ;(this.opts.logger ?? consoleLogger).warn('Skipping invalid imported snippet:', err)
        continue
      }
      const signature = `${snippet.name}\u0000${snippet.code}`
      if (signatures.has(signature)) continue
      if (list.length >= MAX_SNIPPETS) break
      if (ids.has(snippet.id)) snippet.id = randomUUID()
      ids.add(snippet.id)
      signatures.add(signature)
      list.push(snippet)
      added++
    }
    if (added > 0) this.store.set({ snippets: list })
    return added
  }

  /** JSON document written by "Export snippets". */
  exportJson(): string {
    return JSON.stringify(
      { app: 'tinkerbox', version: 1, exportedAt: new Date(this.now()).toISOString(), snippets: this.list() },
      null,
      2
    )
  }

  flushSync(): boolean {
    return this.store.flushSync()
  }

  dispose(): void {
    this.store.dispose()
  }
}
