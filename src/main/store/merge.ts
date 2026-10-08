import { clamp, isFiniteNumber, isPlainObject } from './common'

/**
 * Schema-by-example deep merge.
 *
 * The defaults object (`template`) decides which keys exist and which primitive type each value must have.
 * Used both to load files written by older/newer versions (forward compatibility: missing keys get defaults,
 * unknown keys are dropped, values of the wrong type fall back) and to apply DeepPartial patches coming from
 * the semi-trusted renderer (invalid values are ignored, the current value is kept).
 */
export interface MergeRules {
  /** Dotted path → allowed string values. */
  enums?: Record<string, readonly string[]>
  /** Dotted path → numeric range; out-of-range values are clamped. */
  ranges?: Record<string, { min: number; max: number; integer?: boolean }>
  /**
   * Dotted paths holding a free-form `Record<string, string>` (e.g. shortcut overrides). Patches merge key by
   * key; a `null` / `undefined` value removes the key.
   */
  records?: Record<string, { maxKeys: number; maxValueLength: number; allowKey?: (key: string) => boolean }>
  /** Max length for any string value (default 10 000). */
  maxStringLength?: number
  /** Per-path string length overrides. */
  stringLengths?: Record<string, number>
}

export function mergeTyped<T>(template: T, base: T, patch: unknown, rules: MergeRules): T {
  return mergeNode(template, base, patch, rules, '') as T
}

function mergeNode(template: unknown, base: unknown, patch: unknown, rules: MergeRules, path: string): unknown {
  const record = rules.records?.[path]
  if (record) return mergeRecord(base, patch, record)

  if (isPlainObject(template)) {
    const baseObj = isPlainObject(base) ? base : template
    if (!isPlainObject(patch)) return baseObj
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(template)) {
      const childPath = path ? `${path}.${key}` : key
      out[key] = Object.prototype.hasOwnProperty.call(patch, key)
        ? mergeNode(template[key], baseObj[key], patch[key], rules, childPath)
        : mergeNode(template[key], baseObj[key], undefined, rules, childPath)
    }
    return out
  }

  if (patch === undefined) return base === undefined ? template : base

  if (Array.isArray(template)) return Array.isArray(patch) ? patch : base

  switch (typeof template) {
    case 'string': {
      if (typeof patch !== 'string') return base
      const allowed = rules.enums?.[path]
      if (allowed && !allowed.includes(patch)) return base
      const max = rules.stringLengths?.[path] ?? rules.maxStringLength ?? 10_000
      return patch.length > max ? patch.slice(0, max) : patch
    }
    case 'number': {
      if (!isFiniteNumber(patch)) return base
      const range = rules.ranges?.[path]
      if (!range) return patch
      const value = range.integer ? Math.round(patch) : patch
      return clamp(value, range.min, range.max)
    }
    case 'boolean':
      return typeof patch === 'boolean' ? patch : base
    default:
      return base
  }
}

function mergeRecord(
  base: unknown,
  patch: unknown,
  rule: { maxKeys: number; maxValueLength: number; allowKey?: (key: string) => boolean }
): Record<string, string> {
  const out: Record<string, string> = {}
  if (isPlainObject(base)) {
    for (const [k, v] of Object.entries(base)) if (typeof v === 'string') out[k] = v
  }
  if (!isPlainObject(patch)) return out
  for (const [key, value] of Object.entries(patch)) {
    if (rule.allowKey && !rule.allowKey(key)) continue
    if (value === null || value === undefined) {
      delete out[key]
    } else if (typeof value === 'string') {
      if (!(key in out) && Object.keys(out).length >= rule.maxKeys) continue
      out[key] = value.slice(0, rule.maxValueLength)
    }
  }
  return out
}
