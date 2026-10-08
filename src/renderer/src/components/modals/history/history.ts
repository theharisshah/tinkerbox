import type { HistoryEntry } from '@shared/types'
import { groupByDay, truncate, type DayGroup } from '@/utils/format'
import { fuzzyFilter, preferSubstringMatches } from '@/utils/fuzzy'

/** Pure logic of the History modal: project filter, fuzzy search, day grouping and list navigation. */

export interface HistoryFilter {
  /** Connection id to keep; null = all projects. */
  connectionId: string | null
  query: string
}

export interface HistoryProject {
  id: string
  name: string
  count: number
}

/** Distinct projects of the entries (for the "All Projects" select), sorted by name. */
export function historyProjects(entries: readonly HistoryEntry[]): HistoryProject[] {
  const map = new Map<string, HistoryProject>()
  for (const e of entries) {
    const existing = map.get(e.connectionId)
    if (existing) existing.count++
    else map.set(e.connectionId, { id: e.connectionId, name: e.connectionName || e.connectionId || 'Unknown', count: 1 })
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
}

/**
 * Entries matching the project filter and the fuzzy query (code, project name, result preview). The chronological
 * order (newest first) is kept so the day grouping stays meaningful.
 */
export function filterHistory(entries: readonly HistoryEntry[], filter: HistoryFilter): HistoryEntry[] {
  const scoped = filter.connectionId === null ? [...entries] : entries.filter((e) => e.connectionId === filter.connectionId)
  const sorted = scoped.sort((a, b) => b.ranAt - a.ranAt)
  if (filter.query.trim() === '') return sorted
  const results = preferSubstringMatches(fuzzyFilter(sorted, filter.query, (e) => [e.code, e.connectionName, e.preview]), filter.query)
  const matched = new Set(results.map((r) => r.item))
  return sorted.filter((e) => matched.has(e))
}

/** Day groups (TODAY / YESTERDAY / "MONDAY, OCTOBER 5") of already filtered entries. */
export function groupHistory(entries: readonly HistoryEntry[], now: number = Date.now()): DayGroup<HistoryEntry>[] {
  return groupByDay(entries, (e) => e.ranAt, now)
}

/** One-line preview of the code: first meaningful line (skips `<?php` and blank lines). */
export function codePreviewLine(code: string, max = 140): string {
  const line = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !/^<\?php\b/i.test(l))
  return truncate(line ?? '', max)
}

/** Clamp a list index moved by `delta` (no wrap-around); -1 for an empty list. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1
  if (current < 0) return delta < 0 ? length - 1 : 0
  return Math.min(length - 1, Math.max(0, current + delta))
}

/** Entry to select after deleting `id` from `list`: the next one, else the previous one, else null. */
export function selectionAfterRemoval<T extends { id: string }>(list: readonly T[], id: string): string | null {
  const index = list.findIndex((e) => e.id === id)
  if (index < 0) return list[0]?.id ?? null
  return list[index + 1]?.id ?? list[index - 1]?.id ?? null
}
