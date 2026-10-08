/** Display formatting helpers shared by the status bar, history, logs and output components. */

/** Execution time: "129.31ms" below one second, "1.26s" below a minute, "2m 05s" above. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0.00ms'
  // Whole milliseconds (history wall times) read better without ".00".
  if (ms < 1000) return Number.isInteger(ms) && ms > 0 ? `${ms}ms` : `${ms.toFixed(2)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Memory / file sizes (base 1024): "512B", "12.50KB", "3.37MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${Math.round(value)}B` : `${value.toFixed(2)}${BYTE_UNITS[unit]}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local wall-clock time "14:02:11". */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** Local date + time "2026-10-08 14:02:11". */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatTime(ts)}`
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Stable key of the local calendar day ("2026-10-08"). */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Day heading for grouped lists: "TODAY", "YESTERDAY" or e.g. "MONDAY, OCTOBER 6" (year added when different). */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const day = startOfDay(ts)
  const today = startOfDay(now)
  if (day === today) return 'TODAY'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (day === yesterday.getTime()) return 'YESTERDAY'
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d
    .toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' })
    })
    .toUpperCase()
}

export interface DayGroup<T> {
  key: string
  label: string
  items: T[]
}

/** Group items by local day (input order is kept inside each group; groups in first-seen order). */
export function groupByDay<T>(items: readonly T[], timestamp: (item: T) => number, now: number = Date.now()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  const byKey = new Map<string, DayGroup<T>>()
  for (const item of items) {
    const ts = timestamp(item)
    const key = dayKey(ts)
    let group = byKey.get(key)
    if (!group) {
      group = { key, label: dayLabel(ts, now), items: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", else the date. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < 45_000) return 'just now'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  return formatDateTime(ts).slice(0, 10)
}

/** Shorten text to `max` characters with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return max <= 1 ? '…' : text.slice(0, max - 1) + '…'
}

/** First non-empty line, trimmed and shortened. */
export function firstLine(text: string, max = 120): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  return truncate(line.trim(), max)
}

/** "1 entry" / "3 entries" style counts. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`
}
