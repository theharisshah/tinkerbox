import { describe, expect, it } from 'vitest'
import type { UsageStats } from '@shared/types'
import {
  PERSONAS,
  buildSlides,
  countOf,
  driverName,
  formatCount,
  formatHour,
  formatLongDuration,
  formatPercent,
  hourRange,
  hourTick,
  hoursShare,
  peakHour,
  pickPersona,
  rankEntries,
  runsPerDay,
  shortClassName,
  slideBackground,
  successRate,
  totalExceptions
} from '@/components/modals/wrapped/wrappedUtils'

function stats(patch: Partial<UsageStats> = {}): UsageStats {
  return {
    year: 2026,
    runs: 0,
    failedRuns: 0,
    exceptions: {},
    queries: 0,
    magicComments: 0,
    totalRunMs: 0,
    hours: new Array<number>(24).fill(0),
    projects: {},
    drivers: {},
    longestRunMs: 0,
    ...patch
  }
}

/** `runs` spread evenly over the working day (9..17) unless `at` puts them in specific hours. */
function hours(at: Record<number, number>): number[] {
  const list = new Array<number>(24).fill(0)
  for (const [h, n] of Object.entries(at)) list[Number(h)] = n
  return list
}

describe('formatting', () => {
  it('formats counts and percentages', () => {
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCount(NaN)).toBe('0')
    expect(formatPercent(0.425)).toBe('43%')
    expect(formatPercent(0.0425)).toBe('4.3%')
    expect(formatPercent(1)).toBe('100%')
    expect(formatPercent(0)).toBe('0%')
  })

  it('puts the noun in the right number', () => {
    expect(countOf(1, 'run')).toBe('1 run')
    expect(countOf(0, 'run')).toBe('0 runs')
    expect(countOf(1204, 'run')).toBe('1,204 runs')
    expect(countOf(2, 'query', 'queries')).toBe('2 queries')
    expect(pickPersona(stats({ runs: 1 })).evidence).toBe('1 run, nicely spread across the board')
  })

  it('formats long durations', () => {
    expect(formatLongDuration(0)).toBe('0s')
    expect(formatLongDuration(850)).toBe('850ms')
    expect(formatLongDuration(42_500)).toBe('42.5s')
    expect(formatLongDuration(725_000)).toBe('12m 05s')
    expect(formatLongDuration(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m')
    expect(formatLongDuration(214 * 3_600_000)).toBe('214h')
  })

  it('formats hours', () => {
    expect(formatHour(0)).toBe('12 AM')
    expect(formatHour(9)).toBe('9 AM')
    expect(formatHour(12)).toBe('12 PM')
    expect(formatHour(23)).toBe('11 PM')
    expect(hourRange(15)).toBe('3 PM – 4 PM')
    expect(hourRange(23)).toBe('11 PM – 12 AM')
    expect([0, 6, 12, 18].map(hourTick)).toEqual(['12a', '6a', '12p', '6p'])
  })

  it('finds the peak hour', () => {
    expect(peakHour(hours({ 9: 3, 15: 7, 16: 7 }))).toBe(15)
    expect(peakHour(new Array(24).fill(0))).toBe(-1)
  })

  it('ranks counter maps', () => {
    expect(rankEntries({ b: 2, a: 2, c: 6, zero: 0 })).toEqual([
      { name: 'c', count: 6, share: 0.6 },
      { name: 'a', count: 2, share: 0.2 },
      { name: 'b', count: 2, share: 0.2 }
    ])
    expect(rankEntries({ a: 1, b: 2 }, 1).map((e) => e.name)).toEqual(['b'])
    expect(rankEntries(undefined)).toEqual([])
  })

  it('derives totals and names', () => {
    const s = stats({ runs: 10, failedRuns: 3, exceptions: { 'App\\Boom': 2, Error: 1 } })
    expect(totalExceptions(s)).toBe(3)
    expect(successRate(s)).toBeCloseTo(0.7)
    expect(successRate(stats())).toBe(0)
    expect(shortClassName('Illuminate\\Database\\QueryException')).toBe('QueryException')
    expect(shortClassName('Exception')).toBe('Exception')
    expect(driverName('laravel')).toBe('Laravel')
    expect(driverName('none')).toBe('Plain PHP')
    expect(driverName('bedrock')).toBe('Bedrock')
    expect(driverName('acme-shop')).toBe('Acme Shop')
    expect(driverName('AcmeShopDriver')).toBe('AcmeShop')
    expect(driverName('')).toBe('PHP')
    expect(driverName('mystery')).toBe('Mystery')
  })

  it('computes runs per day since the first run', () => {
    const first = new Date(2026, 0, 1).getTime()
    const s = stats({ runs: 100, firstRunAt: first })
    expect(runsPerDay(s, new Date(2026, 0, 11).getTime())).toBe(10)
    // Past years end on Dec 31st.
    expect(runsPerDay(s, new Date(2030, 0, 1).getTime())).toBeCloseTo(100 / 365)
    expect(runsPerDay(stats({ runs: 5 }))).toBeNull()
  })

  it('shares of hours', () => {
    const s = stats({ runs: 10, hours: hours({ 23: 4, 10: 6 }) })
    expect(hoursShare(s, [22, 23, 0])).toBeCloseTo(0.4)
  })
})

describe('personas', () => {
  it('falls back to the balanced persona', () => {
    expect(pickPersona(stats()).persona.id).toBe('steady-tinkerer')
    expect(pickPersona(stats({ runs: 100, hours: hours({ 10: 50, 14: 50 }), queries: 20 })).persona.id).toBe('steady-tinkerer')
  })

  it('detects heavy SQL use', () => {
    const pick = pickPersona(stats({ runs: 100, queries: 900, hours: hours({ 10: 100 }) }))
    expect(pick.persona.id).toBe('query-tuner')
    expect(pick.evidence).toContain('900 queries')
    expect(pick.score).toBeGreaterThanOrEqual(1)
  })

  it('needs a minimum volume before a trait counts', () => {
    // 4 queries in 1 run is a high rate but too little data.
    expect(pickPersona(stats({ runs: 1, queries: 4 })).persona.id).toBe('steady-tinkerer')
  })

  it('detects frequent exceptions', () => {
    const pick = pickPersona(stats({ runs: 100, exceptions: { 'App\\Boom': 40, TypeError: 20 }, hours: hours({ 11: 100 }) }))
    expect(pick.persona.id).toBe('stacktrace-archaeologist')
    expect(pick.evidence).toBe('60% of your runs ended in an exception')
  })

  it('detects late-night and early sessions', () => {
    expect(pickPersona(stats({ runs: 100, hours: hours({ 23: 30, 1: 20, 14: 50 }) })).persona.id).toBe('midnight-compiler')
    expect(pickPersona(stats({ runs: 100, hours: hours({ 6: 40, 7: 20, 14: 40 }) })).persona.id).toBe('dawn-patroller')
  })

  it('detects magic-comment fans', () => {
    expect(pickPersona(stats({ runs: 100, magicComments: 250, hours: hours({ 10: 100 }) })).persona.id).toBe('inline-oracle')
  })

  it('detects project hopping', () => {
    const projects = { a: 20, b: 20, c: 20, d: 20, e: 20, f: 20, g: 20 }
    expect(pickPersona(stats({ runs: 140, projects, hours: hours({ 10: 140 }) })).persona.id).toBe('codebase-nomad')
  })

  it('picks the strongest trait when several apply', () => {
    // Night share 0.5 (score ≈ 1.67) vs. 4 queries per run (score ≈ 1.33).
    const pick = pickPersona(stats({ runs: 100, queries: 400, hours: hours({ 23: 50, 10: 50 }) }))
    expect(pick.persona.id).toBe('midnight-compiler')
  })

  it('uses original persona names', () => {
    const names = Object.values(PERSONAS).map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
    for (const p of Object.values(PERSONAS)) {
      expect(p.name).toMatch(/^The /)
      expect(p.tagline.length).toBeGreaterThan(5)
      expect(p.description.length).toBeGreaterThan(20)
    }
  })
})

describe('slides', () => {
  it('has no slides without runs', () => {
    expect(buildSlides(stats())).toEqual([])
    expect(buildSlides(null)).toEqual([])
  })

  it('builds the story in order', () => {
    const s = stats({ runs: 3, totalRunMs: 900, projects: { shop: 3 }, hours: hours({ 9: 3 }) })
    expect(buildSlides(s)).toEqual(['intro', 'runs', 'time', 'project', 'hours', 'exceptions', 'queries', 'magic', 'longest', 'persona'])
  })

  it('skips slides without data', () => {
    const s = stats({ runs: 3 })
    expect(buildSlides(s)).not.toContain('project')
    expect(buildSlides(s)).not.toContain('hours')
    expect(buildSlides(s)[0]).toBe('intro')
    expect(buildSlides(s).at(-1)).toBe('persona')
  })

  it('paints backgrounds from theme tokens only', () => {
    for (const id of buildSlides(stats({ runs: 1, projects: { a: 1 }, hours: hours({ 1: 1 }) }))) {
      const bg = slideBackground(id)
      expect(bg).toContain('var(--tw-')
      expect(bg).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    }
  })
})
