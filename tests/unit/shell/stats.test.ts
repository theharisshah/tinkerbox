import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accumulateRun, emptyStats, StatsStore } from '../../../src/main/store/stats'
import { runResult, silentLogger, tempDirs } from './helpers'

const tmp = tempDirs()
afterEach(() => tmp.cleanup())

/** Local-time timestamp helper (stats bucket by the user's local hour). */
function at(year: number, month: number, day: number, hour: number): number {
  return new Date(year, month - 1, day, hour, 15).getTime()
}

describe('stats aggregation', () => {
  it('accumulates runs, failures, exceptions, queries, magic comments, hours, projects and drivers', () => {
    let s = emptyStats(2026)
    s = accumulateRun(
      s,
      runResult({
        totalMs: 100,
        events: [
          { seq: 1, kind: 'query', sql: 'select 1', bindings: [], rawSql: 'select 1', timeMs: 1, connection: 'sqlite' },
          { seq: 2, kind: 'query', sql: 'select 2', bindings: [], rawSql: 'select 2', timeMs: 1, connection: 'sqlite' },
          { seq: 3, kind: 'echo', text: 'x' }
        ],
        magic: [{ line: 1, type: 'value', preview: '1', value: null, hits: 1 }]
      }),
      'my-app',
      at(2026, 3, 1, 9)
    )
    s = accumulateRun(
      s,
      runResult({
        ok: false,
        totalMs: 250,
        driver: null,
        exception: { class: 'TypeError', message: 'x', code: '0', file: 'f', line: 1, trace: [] }
      }),
      'PHP',
      at(2026, 2, 1, 9)
    )
    s = accumulateRun(s, runResult({ ok: false, totalMs: 40, exception: { class: 'TypeError', message: 'y', code: '0', file: 'f', line: 1, trace: [] } }), 'my-app', at(2026, 3, 2, 23))

    expect(s.runs).toBe(3)
    expect(s.failedRuns).toBe(2)
    expect(s.exceptions).toEqual({ TypeError: 2 })
    expect(s.queries).toBe(2)
    expect(s.magicComments).toBe(1)
    expect(s.totalRunMs).toBe(390)
    expect(s.longestRunMs).toBe(250)
    expect(s.hours[9]).toBe(2)
    expect(s.hours[23]).toBe(1)
    expect(s.hours.reduce((a, b) => a + b, 0)).toBe(3)
    expect(s.projects).toEqual({ 'my-app': 2, PHP: 1 })
    expect(s.drivers).toEqual({ laravel: 2, none: 1 })
    expect(s.firstRunAt).toBe(at(2026, 2, 1, 9))
  })

  it('ignores cancelled runs and does not mutate its input', () => {
    const base = emptyStats(2026)
    expect(accumulateRun(base, runResult({ cancelled: true }), 'x', Date.now())).toBe(base)
    const next = accumulateRun(base, runResult(), 'x', at(2026, 1, 1, 1))
    expect(base.runs).toBe(0)
    expect(next.runs).toBe(1)
  })

  it('folds counters beyond the key limit into "Other"', () => {
    let s = emptyStats(2026)
    for (let i = 0; i < 205; i++) s = accumulateRun(s, runResult(), `project-${i}`, at(2026, 1, 1, 1))
    expect(Object.keys(s.projects)).toHaveLength(201)
    expect(s.projects.Other).toBe(5)
  })
})

describe('StatsStore', () => {
  it('keeps one entry per year, returns empty stats for other years and persists', () => {
    const file = join(tmp.make(), 'stats.json')
    const store = new StatsStore(file, { logger: silentLogger })
    store.record(runResult(), 'a', at(2025, 12, 31, 22))
    store.record(runResult(), 'a', at(2026, 1, 1, 8))
    store.record(runResult(), 'b', at(2026, 1, 2, 8))
    store.record(runResult({ cancelled: true }), 'b', at(2026, 1, 2, 8))
    store.flushSync()

    const reloaded = new StatsStore(file, { logger: silentLogger })
    expect(reloaded.get(2025).runs).toBe(1)
    expect(reloaded.get(2026)).toMatchObject({ year: 2026, runs: 2, projects: { a: 1, b: 1 } })
    expect(reloaded.get(2019)).toEqual(emptyStats(2019))
  })
})
