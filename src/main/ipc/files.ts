import { lstatSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher, type Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { errorMessage, type Logger } from '../store/common'
import { writeFileAtomicSync } from '../store/jsonStore'
import { UserFacingError } from './typed'

/** file:read limit (AI @-mentions). */
export const MAX_READ_BYTES = 512 * 1024
/** Limit for .php files opened into an editor tab (file:open / OS open / watch). */
export const MAX_EDITOR_FILE_BYTES = 5 * 1024 * 1024

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`
}

/** Read a UTF-8 text file, refusing directories, binary files and files above `maxBytes`. */
export async function readTextFile(path: string, maxBytes: number): Promise<string> {
  let info
  try {
    info = await stat(path)
  } catch (err) {
    throw new UserFacingError(
      (err as NodeJS.ErrnoException).code === 'ENOENT' ? `File not found: ${path}` : `Cannot read ${path}: ${errorMessage(err)}`
    )
  }
  if (!info.isFile()) throw new UserFacingError(`${path} is not a file`)
  if (info.size > maxBytes) throw new UserFacingError(`${basename(path)} is larger than ${formatBytes(maxBytes)}`)
  const buffer = await readFile(path)
  if (buffer.subarray(0, 8000).includes(0)) throw new UserFacingError(`${basename(path)} is not a text file`)
  return buffer.toString('utf8')
}

function statOrNull(path: string, follow: boolean): Stats | null {
  try {
    return follow ? statSync(path) : lstatSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Save editor text to `path` the way the user expects of the file they opened:
 *  - a symlink is followed: the file it points to gets the text and the link stays a link;
 *  - a file with several hard links is rewritten in place, so every name sees the new content;
 *  - any other file is replaced atomically (temp file + rename) with its permissions kept, a new file is 0644;
 *  - directories, FIFOs, devices… and links to missing files are refused.
 * Returns the file that was written (the resolved path for a symlink).
 */
export function saveTextFile(path: string, text: string): string {
  let target = path
  let info = statOrNull(path, false)
  if (info?.isSymbolicLink()) {
    try {
      target = realpathSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new UserFacingError(`${path} is a link to a file that does not exist`)
      throw err
    }
    info = statOrNull(target, true)
  }
  if (info && !info.isFile()) throw new UserFacingError(`${path} is not a regular file`)
  if (info && info.nlink > 1) writeFileSync(target, text)
  else writeFileAtomicSync(target, text, info ? info.mode & 0o777 : 0o644)
  return target
}

export interface FileChange {
  tabId: string
  path: string
  content: string
}

interface Watch {
  path: string
  watcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | null
  lastContent: string | null
  lastSignature: string
}

/**
 * file:watch — one watcher per (window, tab). Watches the parent directory and filters by file name so atomic
 * saves (write temp + rename, as most editors do) keep being detected. Events are debounced and only emitted when
 * the content really changed (and not for content Tinkerbox itself just wrote).
 */
export class FileWatchers {
  private readonly watches = new Map<string, Watch>()
  private readonly debounceMs: number

  constructor(
    private readonly opts: {
      send(ownerId: number, change: FileChange): void
      logger: Logger
      debounceMs?: number
    }
  ) {
    this.debounceMs = opts.debounceMs ?? 150
  }

  private key(ownerId: number, tabId: string): string {
    return `${ownerId}\u0000${tabId}`
  }

  async watch(ownerId: number, tabId: string, path: string): Promise<void> {
    this.unwatch(ownerId, tabId)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new UserFacingError(`Cannot watch ${path}: not a file`)
    const initial = await readTextFile(path, MAX_EDITOR_FILE_BYTES)
    const name = basename(path)
    const key = this.key(ownerId, tabId)
    const entry: Watch = {
      path,
      watcher: watch(dirname(path), { persistent: false }, (_event, filename) => {
        // Some platforms omit the file name; then every event in the directory triggers a (cheap) re-check.
        if (filename && filename.toString() !== name) return
        this.schedule(key, ownerId, tabId)
      }),
      timer: null,
      lastContent: initial,
      lastSignature: `${info.mtimeMs}:${info.size}`
    }
    entry.watcher.on('error', (err) => {
      this.opts.logger.warn(`Stopped watching ${path}:`, err)
      this.unwatch(ownerId, tabId)
    })
    this.watches.set(key, entry)
  }

  unwatch(ownerId: number, tabId: string): void {
    const key = this.key(ownerId, tabId)
    const entry = this.watches.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.watcher.close()
    this.watches.delete(key)
  }

  /** Stop every watcher of a window (window closed / renderer reloaded). */
  unwatchOwner(ownerId: number): void {
    for (const key of [...this.watches.keys()]) {
      if (key.startsWith(`${ownerId}\u0000`)) this.unwatch(ownerId, key.slice(String(ownerId).length + 1))
    }
  }

  /** Record content Tinkerbox wrote itself so it is not reported back as an external change. */
  noteWritten(path: string, content: string): void {
    for (const entry of this.watches.values()) if (entry.path === path) entry.lastContent = content
  }

  disposeAll(): void {
    for (const entry of this.watches.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.watcher.close()
    }
    this.watches.clear()
  }

  get size(): number {
    return this.watches.size
  }

  private schedule(key: string, ownerId: number, tabId: string): void {
    const entry = this.watches.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.check(key, ownerId, tabId)
    }, this.debounceMs)
  }

  private async check(key: string, ownerId: number, tabId: string): Promise<void> {
    const entry = this.watches.get(key)
    if (!entry) return
    const info = await stat(entry.path).catch(() => null)
    // Deleted (or mid atomic-save): wait for the next event.
    if (!info?.isFile()) return
    const signature = `${info.mtimeMs}:${info.size}`
    if (signature === entry.lastSignature) return
    entry.lastSignature = signature
    let content: string
    try {
      content = await readTextFile(entry.path, MAX_EDITOR_FILE_BYTES)
    } catch (err) {
      this.opts.logger.warn(`Could not read watched file ${entry.path}:`, err)
      return
    }
    if (this.watches.get(key) !== entry || content === entry.lastContent) return
    entry.lastContent = content
    this.opts.send(ownerId, { tabId, path: entry.path, content })
  }
}
