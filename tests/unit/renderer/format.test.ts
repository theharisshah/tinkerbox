import { describe, expect, it } from 'vitest'
import { dayLabel, firstLine, formatBytes, formatDuration, groupByDay, pluralize, relativeTime, truncate } from '@/utils/format'

describe('formatDuration', () => {
  it('formats milliseconds and seconds for the status bar', () => {
    expect(formatDuration(129.312)).toBe('129.31ms')
    expect(formatDuration(0.04)).toBe('0.04ms')
    expect(formatDuration(1259)).toBe('1.26s')
    expect(formatDuration(59_990)).toBe('59.99s')
    expect(formatDuration(143)).toBe('143ms')
  })

  it('formats minutes and hours', () => {
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatDuration(3_725_000)).toBe('1h 02m')
  })

  it('guards invalid input', () => {
    expect(formatDuration(Number.NaN)).toBe('0.00ms')
    expect(formatDuration(-5)).toBe('0.00ms')
  })
})

describe('formatBytes', () => {
  it('uses base-1024 units with two decimals', () => {
    expect(formatBytes(3.37 * 1024 * 1024)).toBe('3.37MB')
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(1536)).toBe('1.50KB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00GB')
    expect(formatBytes(0)).toBe('0B')
  })
})

describe('day grouping', () => {
  const now = new Date(2026, 9, 8, 15, 0, 0).getTime()
  const at = (d: number, h = 10): number => new Date(2026, 9, d, h, 0, 0).getTime()

  it('labels today, yesterday and older days', () => {
    expect(dayLabel(at(8, 1), now)).toBe('TODAY')
    expect(dayLabel(at(7, 23), now)).toBe('YESTERDAY')
    expect(dayLabel(at(5), now)).toBe('MONDAY, OCTOBER 5')
    expect(dayLabel(new Date(2025, 11, 31).getTime(), now)).toBe('WEDNESDAY, DECEMBER 31, 2025')
  })

  it('groups items by local day in first-seen order', () => {
    const items = [{ t: at(8, 14) }, { t: at(8, 9) }, { t: at(7) }, { t: at(1) }, { t: at(1, 8) }]
    const groups = groupByDay(items, (i) => i.t, now)
    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'YESTERDAY', 'THURSDAY, OCTOBER 1'])
    expect(groups.map((g) => g.items.length)).toEqual([2, 1, 2])
  })
})

describe('text helpers', () => {
  it('relativeTime', () => {
    const now = 1_000_000_000_000
    expect(relativeTime(now - 10_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 days ago')
  })

  it('truncate / firstLine / pluralize', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
    expect(firstLine('\n\n  $user = User::first();\nmore')).toBe('$user = User::first();')
    expect(pluralize(1, 'entry', 'entries')).toBe('1 entry')
    expect(pluralize(1500, 'entry', 'entries')).toBe('1,500 entries')
  })
})
