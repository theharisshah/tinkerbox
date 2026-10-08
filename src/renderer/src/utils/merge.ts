/** JSON-ish helpers shared by the stores. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep clone of JSON data (strips Vue proxies before IPC: structured clone rejects reactive proxies). */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/**
 * Apply a settings-style DeepPartial patch the way the main process does: plain objects merge recursively, arrays
 * and scalars replace, and `null` inside a nested object removes that key (used for shortcut overrides).
 */
export function deepMerge<T>(target: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(target)) return target
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = out[key]
    if (isPlainObject(value) && isPlainObject(current)) {
      const merged = deepMerge(current, value) as Record<string, unknown>
      for (const [k, v] of Object.entries(value)) if (v === null) delete merged[k]
      out[key] = merged
    } else if (value === null && isPlainObject(current)) {
      continue
    } else {
      out[key] = value
    }
  }
  return out as T
}
