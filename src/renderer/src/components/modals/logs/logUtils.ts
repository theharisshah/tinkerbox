import type { LogEntry, LogFile } from '@shared/types'

/**
 * Pure helpers of the Log Viewer (levels, filtering, search highlighting, stack traces, file grouping). Kept out
 * of the component so they are unit-testable (tests/unit/modals-b/logs.test.ts).
 */

/** PSR-3 / Monolog levels, least to most severe. */
export const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const
export type KnownLogLevel = (typeof LOG_LEVELS)[number]

const LEVEL_ALIASES: Record<string, KnownLogLevel> = {
  trace: 'debug',
  verbose: 'debug',
  dbg: 'debug',
  information: 'info',
  informational: 'info',
  warn: 'warning',
  err: 'error',
  severe: 'error',
  fatal: 'critical',
  crit: 'critical',
  panic: 'emergency',
  emerg: 'emergency'
}

/** Lower-cased level with common aliases folded into the PSR-3 names ('' → 'info'). */
export function normalizeLevel(level: string | null | undefined): string {
  const raw = (level ?? '').trim().toLowerCase()
  if (!raw) return 'info'
  return LEVEL_ALIASES[raw] ?? raw
}

/** Severity rank (0 = debug … 7 = emergency); unknown levels sort after the known ones. */
export function levelRank(level: string): number {
  const i = (LOG_LEVELS as readonly string[]).indexOf(normalizeLevel(level))
  return i === -1 ? LOG_LEVELS.length : i
}

export interface LevelCount {
  level: string
  count: number
}

/** Count entries per (normalized) level, ordered by severity (most severe first), unknown levels last (A→Z). */
export function countLevels(entries: readonly LogEntry[]): LevelCount[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const level = normalizeLevel(entry.level)
    counts.set(level, (counts.get(level) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([level, count]) => ({ level, count }))
    .sort((a, b) => {
      const ra = levelRank(a.level)
      const rb = levelRank(b.level)
      if (ra !== rb) {
        if (ra === LOG_LEVELS.length) return 1
        if (rb === LOG_LEVELS.length) return -1
        return rb - ra
      }
      return a.level.localeCompare(b.level)
    })
}

/** Label of the level filter button: "All Levels", "Error", "Error, Warning" or "3 levels". */
export function levelFilterLabel(selected: ReadonlySet<string> | readonly string[]): string {
  const list = [...selected]
  if (list.length === 0) return 'All Levels'
  if (list.length <= 2) {
    return list
      .sort((a, b) => levelRank(b) - levelRank(a))
      .map(capitalize)
      .join(', ')
  }
  return `${list.length} levels`
}

export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

export interface LogFilter {
  /** Normalized levels to keep; empty = all levels. */
  levels?: ReadonlySet<string> | readonly string[]
  /** Case-insensitive substring searched in message, context, stack, datetime, env and level. */
  query?: string
}

/** Whether an entry contains the (already lower-cased, trimmed) query. */
export function entryMatches(entry: LogEntry, needle: string): boolean {
  if (!needle) return true
  const fields = [entry.message, entry.context, entry.stack, entry.datetime, entry.env, entry.level]
  return fields.some((f) => !!f && f.toLowerCase().includes(needle))
}

/** Entries matching the level selection and the search query (input order kept). */
export function filterEntries(entries: readonly LogEntry[], filter: LogFilter = {}): LogEntry[] {
  const levels = new Set([...(filter.levels ?? [])].map(normalizeLevel))
  const needle = (filter.query ?? '').trim().toLowerCase()
  if (levels.size === 0 && !needle) return entries.slice()
  return entries.filter((e) => (levels.size === 0 || levels.has(normalizeLevel(e.level))) && entryMatches(e, needle))
}

export interface TextPart {
  text: string
  match: boolean
}

/** Split text into plain and matching parts (case-insensitive) for highlighting search hits. */
export function highlightParts(text: string, query: string): TextPart[] {
  const needle = query.trim().toLowerCase()
  if (!needle || !text) return text ? [{ text, match: false }] : []
  const parts: TextPart[] = []
  const haystack = text.toLowerCase()
  let from = 0
  while (from <= text.length) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    if (at > from) parts.push({ text: text.slice(from, at), match: false })
    parts.push({ text: text.slice(at, at + needle.length), match: true })
    from = at + needle.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false })
  return parts
}

/** Number of (non-overlapping, case-insensitive) occurrences of `query` in `text`. */
export function countMatches(text: string, query: string): number {
  return highlightParts(text, query).filter((p) => p.match).length
}

/** First non-empty line of a message (untruncated; the list row clips it with CSS). */
export function messageHeadline(message: string): string {
  const line = message.split(/\r?\n/).find((l) => l.trim() !== '')
  return (line ?? '').trim()
}

/** Whether expanding the entry reveals more than the headline. */
export function hasDetails(entry: LogEntry): boolean {
  return !!entry.context || !!entry.stack || messageHeadline(entry.message) !== entry.message.trim()
}

/** Pretty-print JSON context; non-JSON text is returned trimmed as is. */
export function prettyContext(context: string | undefined | null): string {
  const raw = (context ?? '').trim()
  if (!raw) return ''
  if (raw[0] !== '{' && raw[0] !== '[') return raw
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // Monolog prints context + extra as two JSON values ("{…} {…}"): pretty-print each part when possible.
    const split = splitJsonValues(raw)
    if (split.length > 1) {
      try {
        return split.map((part) => JSON.stringify(JSON.parse(part), null, 2)).join('\n')
      } catch {
        return raw
      }
    }
    return raw
  }
}

/** Split concatenated top-level JSON values ("{…} […]") by bracket depth (strings respected). */
function splitJsonValues(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0 && start !== -1) {
        parts.push(text.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) return [text]
    }
  }
  return depth === 0 ? parts : [text]
}

export interface StackGroup {
  /** Consecutive frames inside vendor/ (collapsed by default). */
  vendor: boolean
  lines: string[]
}

/** A stack line pointing into a vendor/ directory. */
export function isVendorFrame(line: string): boolean {
  return /[\\/]vendor[\\/]/.test(line)
}

/**
 * Split a stack trace into groups of consecutive app / vendor frames. The `[stacktrace]` marker and empty lines
 * are dropped; non-frame lines (e.g. "Next Exception …", "{main}") stay in app groups.
 */
export function groupStack(stack: string | undefined | null): StackGroup[] {
  const groups: StackGroup[] = []
  for (const rawLine of (stack ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim() || line.trim() === '[stacktrace]') continue
    const vendor = isVendorFrame(line)
    const last = groups[groups.length - 1]
    if (last && last.vendor === vendor) last.lines.push(line)
    else groups.push({ vendor, lines: [line] })
  }
  return groups
}

/** Plain-text representation of an entry for "Copy entry". */
export function entryToText(entry: LogEntry): string {
  const head = [entry.datetime ? `[${entry.datetime}]` : '', `${entry.env ? `${entry.env}.` : ''}${normalizeLevel(entry.level).toUpperCase()}:`]
    .filter(Boolean)
    .join(' ')
  const parts = [`${head} ${entry.message}`.trim()]
  const context = prettyContext(entry.context)
  if (context) parts.push(context)
  if (entry.stack) parts.push(entry.stack.trim())
  return parts.join('\n')
}

/**
 * Stable keys for entries (kept across polling refreshes so expanded rows stay expanded): datetime + level +
 * message start, suffixed with an occurrence counter for duplicates.
 */
export function entryKeys(entries: readonly LogEntry[]): string[] {
  const seen = new Map<string, number>()
  return entries.map((e) => {
    const base = `${e.datetime}|${normalizeLevel(e.level)}|${e.message.slice(0, 160)}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}#${n}`
  })
}

export interface LogFileGroup {
  /** Directory relative to the root ('' = the root itself). */
  dir: string
  label: string
  files: LogFile[]
}

/** Files grouped by directory: the root first ("LOGS ROOT"), then sub-directories A→Z. Input order kept per group. */
export function groupLogFiles(files: readonly LogFile[]): LogFileGroup[] {
  const map = new Map<string, LogFile[]>()
  for (const file of files) {
    const dir = (file.dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    let list = map.get(dir)
    if (!list) map.set(dir, (list = []))
    list.push(file)
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })))
    .map(([dir, list]) => ({ dir, label: dir === '' ? 'LOGS ROOT' : dir.toUpperCase(), files: list }))
}

/**
 * File to open first: the remembered one (when still listed), else `laravel.log` in the root, else the most
 * recently modified file.
 */
export function pickDefaultFile(files: readonly LogFile[], remembered?: string | null): LogFile | null {
  if (files.length === 0) return null
  if (remembered) {
    const match = files.find((f) => f.path === remembered)
    if (match) return match
  }
  const laravel = files.find((f) => f.path === 'laravel.log')
  if (laravel) return laravel
  return files.reduce((best, f) => (f.modifiedAt > best.modifiedAt ? f : best), files[0])
}

/** Files above this size show a "reading a big file" hint while loading. */
export const BIG_LOG_BYTES = 2 * 1024 * 1024

export const POLLING_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Off' },
  { value: 2000, label: '2s' },
  { value: 5000, label: '5s' },
  { value: 10_000, label: '10s' },
  { value: 30_000, label: '30s' }
]

export const LIMIT_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 500, label: 'Last 500' },
  { value: 1000, label: 'Last 1000' }
]

/** Tailwind classes of a level badge (theme tokens only). */
export function levelBadgeClass(level: string): string {
  switch (normalizeLevel(level)) {
    case 'debug':
      return 'bg-fg/8 text-muted'
    case 'info':
      return 'bg-code-class/14 text-code-class'
    case 'notice':
      return 'bg-success/14 text-success'
    case 'warning':
      return 'bg-warning/16 text-warning'
    case 'error':
      return 'bg-danger/14 text-danger'
    case 'critical':
      return 'bg-danger/20 text-danger ring-1 ring-inset ring-danger/50'
    case 'alert':
      return 'bg-code-property/16 text-code-property ring-1 ring-inset ring-code-property/50'
    case 'emergency':
      // Same treatment as the design system's danger button (filled, white text).
      return 'bg-danger text-white ring-2 ring-danger/30'
    default:
      return 'bg-fg/8 text-muted'
  }
}

/** Small colored dot used in the level filter menu. */
export function levelDotClass(level: string): string {
  switch (normalizeLevel(level)) {
    case 'debug':
      return 'bg-muted'
    case 'info':
      return 'bg-code-class'
    case 'notice':
      return 'bg-success'
    case 'warning':
      return 'bg-warning'
    case 'error':
    case 'critical':
    case 'emergency':
      return 'bg-danger'
    case 'alert':
      return 'bg-code-property'
    default:
      return 'bg-muted'
  }
}

/** Viewer preferences remembered for the session (polling interval, entry limit, last file per project). */
export const logViewerMemory: { polling: number; limit: number; files: Map<string, string> } = {
  polling: 0,
  limit: 500,
  files: new Map()
}
