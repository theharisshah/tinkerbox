/**
 * Small helpers shared by the persistence layer. Nothing in src/main/store imports
 * Electron at runtime so the stores can be unit-tested with vitest in plain Node.
 */

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Non-fatal notice surfaced to the renderer through the 'app:notice' event. */
export interface StoreNotice {
  level: 'info' | 'warning' | 'error'
  message: string
}

export type NoticeSink = (notice: StoreNotice) => void

export const consoleLogger: Logger = {
  info: (...args) => console.info('[tinkerbox]', ...args),
  warn: (...args) => console.warn('[tinkerbox]', ...args),
  error: (...args) => console.error('[tinkerbox]', ...args)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Deep clone of JSON-compatible data (stores only hold JSON data). */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/** Recursively freezes an object graph so callers cannot mutate cached store state by accident. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Truncate to `max` characters, adding an ellipsis when shortened. */
export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Optional string field: returns undefined when missing/empty or of the wrong type. */
export function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return value.slice(0, maxLength)
}
