import type { RunResult, UsageStats } from '../../shared/types'
import { cloneJson, consoleLogger, isFiniteNumber, isPlainObject, type Logger, type NoticeSink } from './common'
import { JsonStore } from './jsonStore'

interface StatsData {
  years: Record<string, UsageStats>
}

/** Keys kept per counter map (projects / drivers / exceptions); the rest is folded into "Other". */
const MAX_MAP_KEYS = 200
const OTHER = 'Other'

export function emptyStats(year: number): UsageStats {
  return {
    year,
    runs: 0,
    failedRuns: 0,
    exceptions: {},
    queries: 0,
    magicComments: 0,
    totalRunMs: 0,
    hours: new Array<number>(24).fill(0),
    projects: {},
    drivers: {},
    longestRunMs: 0
  }
}

function num(value: unknown): number {
  return isFiniteNumber(value) && value >= 0 ? value : 0
}

function counterMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isPlainObject(value)) return out
  for (const [k, v] of Object.entries(value)) if (isFiniteNumber(v) && v > 0) out[k] = v
  return out
}

function sanitizeStats(year: number, raw: unknown): UsageStats {
  const s = emptyStats(year)
  if (!isPlainObject(raw)) return s
  s.runs = num(raw.runs)
  s.failedRuns = num(raw.failedRuns)
  s.exceptions = counterMap(raw.exceptions)
  s.queries = num(raw.queries)
  s.magicComments = num(raw.magicComments)
  s.totalRunMs = num(raw.totalRunMs)
  if (Array.isArray(raw.hours) && raw.hours.length === 24) s.hours = raw.hours.map(num)
  s.projects = counterMap(raw.projects)
  s.drivers = counterMap(raw.drivers)
  s.longestRunMs = num(raw.longestRunMs)
  if (isFiniteNumber(raw.firstRunAt)) s.firstRunAt = raw.firstRunAt
  return s
}

function increment(map: Record<string, number>, key: string, by = 1): void {
  if (key in map || Object.keys(map).length < MAX_MAP_KEYS) map[key] = (map[key] ?? 0) + by
  else map[OTHER] = (map[OTHER] ?? 0) + by
}

/**
 * Add one finished run to a year's statistics (pure; returns a new object). Cancelled runs are not counted —
 * the user aborted them, they say nothing about how the code behaved.
 */
export function accumulateRun(stats: UsageStats, result: RunResult, connectionName: string, at: number): UsageStats {
  if (result.cancelled) return stats
  const next = cloneJson(stats)
  next.runs += 1
  if (!result.ok) next.failedRuns += 1
  if (result.exception) increment(next.exceptions, result.exception.class || 'Exception')
  next.queries += result.events.filter((e) => e.kind === 'query').length
  next.magicComments += result.magic.length
  const ms = isFiniteNumber(result.totalMs) ? Math.max(0, result.totalMs) : 0
  next.totalRunMs += ms
  next.longestRunMs = Math.max(next.longestRunMs, ms)
  next.hours[new Date(at).getHours()] += 1
  increment(next.projects, connectionName || 'PHP')
  increment(next.drivers, result.driver?.id || 'none')
  if (next.firstRunAt === undefined || at < next.firstRunAt) next.firstRunAt = at
  return next
}

/** stats.json — "Year in Review" usage statistics, one entry per calendar year. */
export class StatsStore {
  private readonly store: JsonStore<StatsData>

  constructor(file: string, opts: { onNotice?: NoticeSink; logger?: Logger; debounceMs?: number } = {}) {
    this.store = new JsonStore<StatsData>({
      file,
      label: 'Usage statistics',
      defaults: () => ({ years: {} }),
      normalize: (raw) => {
        if (!isPlainObject(raw) || !isPlainObject(raw.years)) throw new Error('stats.json must contain "years"')
        const years: Record<string, UsageStats> = {}
        for (const [key, value] of Object.entries(raw.years)) {
          const year = Number(key)
          if (Number.isInteger(year) && year > 1970 && year < 10000) years[String(year)] = sanitizeStats(year, value)
        }
        return { years }
      },
      debounceMs: opts.debounceMs ?? 1000,
      onNotice: opts.onNotice,
      logger: opts.logger ?? consoleLogger
    })
  }

  record(result: RunResult, connectionName: string, at: number = result.finishedAt || Date.now()): void {
    if (result.cancelled) return
    const year = new Date(at).getFullYear()
    const data = this.store.value
    const current = data.years[String(year)] ?? emptyStats(year)
    this.store.set({ years: { ...data.years, [String(year)]: accumulateRun(current, result, connectionName, at) } })
  }

  /** Statistics for a year (default: the current year); empty stats when nothing was recorded. */
  get(year: number = new Date().getFullYear()): UsageStats {
    const stats = this.store.value.years[String(year)]
    return stats ? cloneJson(stats) : emptyStats(year)
  }

  flushSync(): boolean {
    return this.store.flushSync()
  }

  dispose(): void {
    this.store.dispose()
  }
}
