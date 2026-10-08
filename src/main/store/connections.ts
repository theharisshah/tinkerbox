import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, resolve as resolvePath } from 'node:path'
import type { Connection, LocalConnection } from '../../shared/types'
import {
  cloneJson,
  consoleLogger,
  isFiniteNumber,
  isPlainObject,
  optionalString,
  type Logger,
  type NoticeSink
} from './common'
import { JsonStore } from './jsonStore'

/**
 * connections.json — local project folders (= recent folders), keyed by path.
 *
 * This build is local-only (see the scope banner in docs/ARCHITECTURE.md); remote connection types will be added
 * as new `Connection` variants later. Unknown variants found on disk are dropped on load.
 */
export interface ConnectionsData {
  connections: Connection[]
}

const MAX_CONNECTIONS = 5000

/** Canonical form of a local project path used for de-duplication (no trailing separator, `..` resolved). */
export function normalizeLocalPath(path: string, platform: NodeJS.Platform = process.platform): string {
  // path.resolve() normalizes `..`/`.` segments and strips trailing separators (except for a root).
  const p = resolvePath(path)
  return platform === 'win32' ? p.replace(/\//g, '\\') : p
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  // Windows and (by default) macOS file systems are case-insensitive.
  return platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Deterministic id for a project folder so history / snippets stay attached when it is opened again. */
export function localConnectionId(path: string, platform: NodeJS.Platform = process.platform): string {
  const key = platform === 'win32' || platform === 'darwin' ? path.toLowerCase() : path
  return 'local-' + createHash('sha1').update(key).digest('hex').slice(0, 16)
}

/** Validate a connection (from disk or from the renderer). Throws a TypeError describing the problem. */
export function sanitizeConnection(input: unknown, now = Date.now()): Connection {
  if (!isPlainObject(input)) throw new TypeError('Connection must be an object')
  if (input.type !== 'local') throw new TypeError('Only local project connections are supported')
  const path = typeof input.path === 'string' ? input.path.slice(0, 4096) : ''
  if (path !== '' && !isAbsolute(path)) throw new TypeError('Project path must be absolute')
  const conn: LocalConnection = {
    id: typeof input.id === 'string' && input.id.trim() !== '' ? input.id.slice(0, 200) : randomUUID(),
    name: (typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '') || basename(path) || 'PHP',
    type: 'local',
    path,
    createdAt: isFiniteNumber(input.createdAt) ? input.createdAt : now
  }
  const phpBinary = optionalString(input.phpBinary, 4096)
  if (phpBinary !== undefined) conn.phpBinary = phpBinary
  const driver = optionalString(input.driver, 200)
  if (driver !== undefined) conn.driver = driver
  const color = optionalString(input.color, 100)
  if (color !== undefined) conn.color = color
  if (isFiniteNumber(input.lastUsedAt)) conn.lastUsedAt = input.lastUsedAt
  if (input.debug === true) conn.debug = true
  return conn
}

/** A project "has settings" when it is more than a plain recent folder (kept when recents are cleared). */
export function hasCustomSettings(conn: Connection): boolean {
  return !!conn.phpBinary || !!conn.driver || !!conn.color || !!conn.debug
}

/** Most recently used first; never-used entries last (newest first). */
function byRecency(a: Connection, b: Connection): number {
  const ua = a.lastUsedAt ?? -1
  const ub = b.lastUsedAt ?? -1
  return ub - ua || b.createdAt - a.createdAt
}

export function normalizeConnectionsData(raw: unknown, logger: Logger = consoleLogger): ConnectionsData {
  if (!isPlainObject(raw)) throw new Error('connections.json must contain a JSON object')
  const connections: Connection[] = []
  const ids = new Set<string>()
  for (const item of Array.isArray(raw.connections) ? raw.connections.slice(0, MAX_CONNECTIONS) : []) {
    try {
      const conn = sanitizeConnection(item, 0)
      if (ids.has(conn.id)) continue
      ids.add(conn.id)
      connections.push(conn)
    } catch (err) {
      // One unusable entry (or a connection type this build does not support) must not take the list down.
      logger.warn('Dropping unsupported connection from connections.json:', err)
    }
  }
  return { connections }
}

export type ConnectionsListener = (data: ConnectionsData) => void

export class ConnectionsStore {
  private readonly store: JsonStore<ConnectionsData>
  private readonly listeners = new Set<ConnectionsListener>()

  constructor(
    file: string,
    private readonly opts: {
      onNotice?: NoticeSink
      logger?: Logger
      debounceMs?: number
      platform?: NodeJS.Platform
      now?: () => number
    } = {}
  ) {
    const logger = opts.logger ?? consoleLogger
    this.store = new JsonStore<ConnectionsData>({
      file,
      label: 'Connections',
      defaults: () => ({ connections: [] }),
      normalize: (raw) => normalizeConnectionsData(raw, logger),
      pretty: true,
      debounceMs: opts.debounceMs,
      onNotice: opts.onNotice,
      logger
    })
  }

  private get platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** All project connections, most recently used first. */
  list(): Connection[] {
    return cloneJson(this.store.value.connections).sort(byRecency)
  }

  get(id: string): Connection | undefined {
    const conn = this.store.value.connections.find((c) => c.id === id)
    return conn ? cloneJson(conn) : undefined
  }

  findLocalByPath(path: string): Connection | undefined {
    const wanted = normalizeLocalPath(path, this.platform)
    const found = this.store.value.connections.find((c) => c.path !== '' && samePath(c.path, wanted, this.platform))
    return found ? cloneJson(found) : undefined
  }

  /** Create or update by id. Returns the saved connection. */
  save(input: unknown): Connection {
    const conn = sanitizeConnection(input, this.now())
    const data = this.store.value
    const existing = data.connections.find((c) => c.id === conn.id)
    if (existing) conn.createdAt = existing.createdAt
    else if (data.connections.length >= MAX_CONNECTIONS) throw new Error(`Too many projects (max ${MAX_CONNECTIONS})`)
    if (conn.path !== '') conn.path = normalizeLocalPath(conn.path, this.platform)
    const connections = existing
      ? data.connections.map((c) => (c.id === conn.id ? conn : c))
      : [...data.connections, conn]
    this.commit({ connections })
    return cloneJson(conn)
  }

  delete(id: string): boolean {
    const data = this.store.value
    if (!data.connections.some((c) => c.id === id)) return false
    this.commit({ connections: data.connections.filter((c) => c.id !== id) })
    return true
  }

  /**
   * Open (or reuse) the project connection for a directory and mark it used now. The path must be absolute;
   * callers check that the directory exists.
   */
  openLocal(path: string): Connection {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Project path must be absolute')
    const normalized = normalizeLocalPath(path, this.platform)
    const now = this.now()
    const data = this.store.value
    const existing = data.connections.find((c) => c.path !== '' && samePath(c.path, normalized, this.platform))
    if (existing) {
      const updated: Connection = { ...existing, lastUsedAt: now }
      this.commit({ connections: data.connections.map((c) => (c.id === existing.id ? updated : c)) })
      return cloneJson(updated)
    }
    let id = localConnectionId(normalized, this.platform)
    if (data.connections.some((c) => c.id === id)) id = randomUUID()
    const conn: Connection = {
      id,
      name: basename(normalized) || normalized,
      type: 'local',
      path: normalized,
      createdAt: now,
      lastUsedAt: now
    }
    this.commit({ connections: [...data.connections, conn] })
    return cloneJson(conn)
  }

  /** Mark a stored connection as used now. Unknown / implicit ids (sandbox, scratch) are ignored. */
  touch(id: string): void {
    const data = this.store.value
    if (!data.connections.some((c) => c.id === id)) return
    const now = this.now()
    this.commit({ connections: data.connections.map((c) => (c.id === id ? { ...c, lastUsedAt: now } : c)) })
  }

  /**
   * Clear the recent folders: plain recent folders are removed; projects with their own settings (PHP binary,
   * driver, color, Xdebug) are kept so those settings survive, but drop out of the recents (lastUsedAt cleared).
   */
  /**
   * Empty the recent-folder list. Plain folders are forgotten, except those in `keep` (connections that open tabs or
   * snippets still reference — deleting them would turn those tabs into "Unknown project"). Kept entries and
   * projects with custom settings stay without `lastUsedAt`, so they no longer count as recent.
   */
  clearRecents(keep: Iterable<string> = []): void {
    const keepIds = new Set(keep)
    const connections: Connection[] = []
    for (const c of this.store.value.connections) {
      if (!hasCustomSettings(c) && !keepIds.has(c.id)) continue
      const copy = { ...c }
      delete copy.lastUsedAt
      connections.push(copy)
    }
    this.commit({ connections })
  }

  /** Recently used project folders (lastUsedAt set, non-empty path), newest first. */
  recentFolders(limit = 10): Connection[] {
    return this.store.value.connections
      .filter((c) => c.path !== '' && c.lastUsedAt !== undefined)
      .sort(byRecency)
      .slice(0, limit)
      .map((c) => cloneJson(c))
  }

  snapshot(): ConnectionsData {
    return { connections: this.list() }
  }

  onChange(listener: ConnectionsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  flushSync(): boolean {
    return this.store.flushSync()
  }

  dispose(): void {
    this.store.dispose()
  }

  private commit(data: ConnectionsData): void {
    this.store.set(data)
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
