import { isAbsolute } from 'node:path'
import { isFiniteNumber, isPlainObject } from '../store/common'

/**
 * Minimal argument validation for IPC handlers. The renderer is semi-trusted (it renders HTML from user projects
 * in previews), so every handler checks types and sizes before touching the filesystem or spawning processes.
 * Failures throw TypeError with a readable message.
 */

export function str(value: unknown, name: string, maxLength = 10_000): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  if (value.length > maxLength) throw new TypeError(`${name} is too long (max ${maxLength} characters)`)
  return value
}

export function nonEmptyStr(value: unknown, name: string, maxLength = 10_000): string {
  const s = str(value, name, maxLength)
  if (s.trim() === '') throw new TypeError(`${name} must not be empty`)
  return s
}

export function optStr(value: unknown, name: string, maxLength = 10_000): string | undefined {
  return value === undefined || value === null ? undefined : str(value, name, maxLength)
}

/** A connection id or null (default connection). */
export function connectionIdOrNull(value: unknown, name = 'connectionId'): string | null {
  if (value === null || value === undefined) return null
  return nonEmptyStr(value, name, 200)
}

export function absPath(value: unknown, name = 'path'): string {
  const p = nonEmptyStr(value, name, 4096)
  if (p.includes('\0')) throw new TypeError(`${name} is not a valid path`)
  if (!isAbsolute(p)) throw new TypeError(`${name} must be an absolute path`)
  return p
}

export function int(value: unknown, name: string, min: number, max: number): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) throw new TypeError(`${name} must be an integer`)
  if (value < min || value > max) throw new TypeError(`${name} must be between ${min} and ${max}`)
  return value
}

export function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

export function obj(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`)
  return value
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

/** Dialog file filters: [{ name, extensions[] }]. */
export function fileFilters(value: unknown): Array<{ name: string; extensions: string[] }> | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 20) throw new TypeError('filters must be an array')
  return value.map((f, i) => {
    const filter = obj(f, `filters[${i}]`)
    const extensions = filter.extensions
    if (!Array.isArray(extensions) || extensions.length > 50) throw new TypeError(`filters[${i}].extensions must be an array`)
    return {
      name: str(filter.name, `filters[${i}].name`, 200),
      extensions: extensions.map((e, j) => {
        const ext = str(e, `filters[${i}].extensions[${j}]`, 20)
        if (!/^(\*|[A-Za-z0-9_-]+)$/.test(ext)) throw new TypeError(`Invalid file extension "${ext}"`)
        return ext
      })
    }
  })
}
