import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, copyFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { consoleLogger, errorMessage, type Logger, type NoticeSink } from './common'

export interface JsonStoreOptions<T> {
  /** Absolute path of the JSON file. */
  file: string
  /** Human readable name used in notices ("Settings", "History"…). */
  label: string
  /** Fresh default value (called whenever defaults are needed, so it must not return a shared object). */
  defaults: () => T
  /**
   * Turns parsed JSON into a valid value (fill defaults, drop invalid entries). Throwing marks the file as
   * corrupted: it is backed up and the defaults are used.
   */
  normalize: (raw: unknown) => T
  /** Debounce for writes triggered by `set()` (ms). */
  debounceMs?: number
  /** Pretty-print the file (files users may want to read / edit by hand). */
  pretty?: boolean
  onNotice?: NoticeSink
  logger?: Logger
  /** Injectable clock for deterministic backup names in tests. */
  now?: () => number
}

/**
 * A JSON document persisted in the user data directory.
 *
 * - Reads synchronously once at construction (files are small; the main process needs them before the window).
 * - Writes are debounced and atomic: data goes to a temp file in the same directory, is fsync'ed and then renamed
 *   over the target, so a crash never leaves a half-written file behind.
 * - Writes are synchronous on purpose: an async write racing with the synchronous flush on quit could rename an
 *   older snapshot over a newer one.
 * - A file that cannot be parsed is renamed to `<name>.corrupt-<timestamp>.json`, the defaults are used and a
 *   notice is emitted so the renderer can tell the user.
 * - A file that exists but cannot be read (permissions, I/O error, locked) is never overwritten: the store runs
 *   with the defaults for this session and does not save, so the user's data is still there once the problem is
 *   fixed. Saving resumes if the file disappears in the meantime.
 */
export class JsonStore<T> {
  private data: T
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private writeErrorReported = false
  /** The file exists but could not be read: writing would replace the user's data with defaults. */
  private unreadable = false
  private readonly logger: Logger
  private readonly debounceMs: number

  constructor(private readonly opts: JsonStoreOptions<T>) {
    this.logger = opts.logger ?? consoleLogger
    this.debounceMs = opts.debounceMs ?? 300
    this.data = this.read()
  }

  get file(): string {
    return this.opts.file
  }

  get value(): T {
    return this.data
  }

  /** Replace the value and schedule a (debounced) write. */
  set(next: T): void {
    this.data = next
    this.dirty = true
    this.schedule()
  }

  /** Apply a mutation function to the current value and schedule a write. */
  update(fn: (current: T) => T): T {
    this.set(fn(this.data))
    return this.data
  }

  /** True while the store does not save because its existing file could not be read (see class docs). */
  get readOnly(): boolean {
    return this.unreadable
  }

  /** Write pending changes now (used on quit and in tests). Returns false when the write failed or was skipped. */
  flushSync(): boolean {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return true
    return this.write()
  }

  /** Cancel pending timers without writing (tests). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.write()
    }, this.debounceMs)
    // Never keep the process alive just for a pending write; flushSync() runs on quit.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) this.timer.unref()
  }

  private write(): boolean {
    if (this.unreadable) {
      if (!this.fileIsGone()) return false
      // The unreadable file was removed: nothing left to protect.
      this.unreadable = false
    }
    try {
      const json = this.opts.pretty ? JSON.stringify(this.data, null, 2) : JSON.stringify(this.data)
      writeFileAtomicSync(this.opts.file, json + '\n')
      this.dirty = false
      this.writeErrorReported = false
      return true
    } catch (err) {
      this.logger.error(`Could not write ${this.opts.file}:`, err)
      if (!this.writeErrorReported) {
        this.writeErrorReported = true
        this.opts.onNotice?.({ level: 'error', message: `${this.opts.label} could not be saved: ${errorMessage(err)}` })
      }
      return false
    }
  }

  private read(): T {
    let text: string
    try {
      text = readFileSync(this.opts.file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // ENOTDIR: a parent path component is a file — the document does not exist either.
      if (code === 'ENOENT' || code === 'ENOTDIR') return this.opts.defaults()
      // Unreadable (permissions…): keep the file untouched — also on later writes — run with defaults and tell the user.
      this.logger.error(`Could not read ${this.opts.file}:`, err)
      this.unreadable = true
      this.opts.onNotice?.({
        level: 'error',
        message:
          `${this.opts.label} could not be read (${errorMessage(err)}). Defaults are used for this session and ` +
          `changes are not saved, so ${this.opts.file} is left untouched.`
      })
      return this.opts.defaults()
    }

    if (text.trim() === '') return this.opts.defaults()

    try {
      return this.opts.normalize(JSON.parse(text))
    } catch (err) {
      const backup = this.backupCorrupted()
      this.logger.warn(`Corrupted ${this.opts.file} (${errorMessage(err)}); backup: ${backup ?? 'failed'}`)
      this.opts.onNotice?.({
        level: 'warning',
        message: backup
          ? `${this.opts.label} file was corrupted and has been reset. A backup was saved to ${backup}.`
          : `${this.opts.label} file was corrupted and has been reset.`
      })
      // Persist the defaults right away so the corrupted file is not read again.
      this.dirty = true
      const defaults = this.opts.defaults()
      this.data = defaults
      this.write()
      return defaults
    }
  }

  private fileIsGone(): boolean {
    try {
      lstatSync(this.opts.file)
      return false
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      return code === 'ENOENT' || code === 'ENOTDIR'
    }
  }

  private backupCorrupted(): string | null {
    const file = this.opts.file
    const ext = extname(file) || '.json'
    const stamp = (this.opts.now ?? Date.now)()
    const target = join(dirname(file), `${basename(file, ext)}.corrupt-${stamp}${ext}`)
    try {
      renameSync(file, target)
      return target
    } catch (renameErr) {
      try {
        copyFileSync(file, target)
        return target
      } catch (copyErr) {
        this.logger.error('Could not back up corrupted file', renameErr, copyErr)
        return null
      }
    }
  }
}

let tempCounter = 0

/** Write a file atomically: temp file in the same directory → fsync → rename over the target. */
export function writeFileAtomicSync(file: string, contents: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(tmp, 'w', mode)
    writeSync(fd, contents)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, file)
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // The original error is more useful than a close failure.
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      // Temp file may not exist (open failed) — nothing to clean up.
    }
    throw err
  }
}
