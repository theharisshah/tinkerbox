import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import {
  codePreviewLine,
  filterHistory,
  groupHistory,
  historyProjects,
  selectionAfterRemoval,
  stepIndex
} from '@/components/modals/history/history'

const NOW = new Date(2026, 9, 8, 15, 30).getTime()

function at(daysAgo: number, hour: number, minute = 0): number {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

function entry(id: string, ranAt: number, patch: Partial<HistoryEntry> = {}): HistoryEntry {
  return { id, code: `echo '${id}';`, connectionId: 'sandbox', connectionName: 'Default', ranAt, durationMs: 12, ok: true, preview: '', ...patch }
}

const entries: HistoryEntry[] = [
  entry('a', at(0, 14), { code: 'User::count()', connectionId: 'p1', connectionName: 'acme-shop', preview: '42' }),
  entry('b', at(0, 9), { code: '<?php\n\n$orders = Order::latest()->get();', connectionId: 'p2', connectionName: 'blog' }),
  entry('c', at(1, 23, 59), { code: 'throw new Exception("boom");', ok: false, preview: 'Exception: boom' }),
  entry('d', at(1, 0, 5), { code: 'collect([1, 2])->sum()', connectionId: 'p1', connectionName: 'acme-shop' }),
  entry('e', at(3, 12), { code: 'now()->toDateString()' }),
  entry('f', at(400, 12), { code: 'phpinfo();', connectionId: 'scratch', connectionName: 'PHP' })
]

describe('history day grouping', () => {
  it('groups entries into TODAY, YESTERDAY and dated days', () => {
    const groups = groupHistory(entries, NOW)
    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'YESTERDAY', 'MONDAY, OCTOBER 5', 'WEDNESDAY, SEPTEMBER 3, 2025'])
    expect(groups.map((g) => g.items.map((e) => e.id))).toEqual([['a', 'b'], ['c', 'd'], ['e'], ['f']])
  })

  it('groups filtered entries the same way', () => {
    const groups = groupHistory(filterHistory(entries, { connectionId: 'p1', query: '' }), NOW)
    expect(groups.map((g) => [g.label, g.items.map((e) => e.id)])).toEqual([
      ['TODAY', ['a']],
      ['YESTERDAY', ['d']]
    ])
  })
})

describe('history filtering', () => {
  it('filters by project and keeps the newest first', () => {
    const shuffled = [entries[3], entries[0], entries[5], entries[1], entries[2], entries[4]]
    expect(filterHistory(shuffled, { connectionId: null, query: '' }).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(filterHistory(entries, { connectionId: 'p1', query: '' }).map((e) => e.id)).toEqual(['a', 'd'])
    expect(filterHistory(entries, { connectionId: 'missing', query: '' })).toEqual([])
  })

  it('fuzzy searches code, project names and results without reordering', () => {
    expect(filterHistory(entries, { connectionId: null, query: 'Order::latest' }).map((e) => e.id)).toEqual(['b'])
    expect(filterHistory(entries, { connectionId: null, query: 'acme' }).map((e) => e.id)).toEqual(['a', 'd'])
    expect(filterHistory(entries, { connectionId: null, query: 'boom' }).map((e) => e.id)).toEqual(['c'])
    // Typo tolerant.
    expect(filterHistory(entries, { connectionId: null, query: 'phpinof' }).map((e) => e.id)).toEqual(['f'])
    // Literal hits win over scattered subsequence matches in long code ("count" in User::count() vs c-o-u-n-t).
    const noisy = [...entries, entry('g', at(0, 15), { code: "config(['custom' => ['output' => 'nested']]);" })]
    expect(filterHistory(noisy, { connectionId: null, query: 'count' }).map((e) => e.id)).toEqual(['a'])
    expect(filterHistory(noisy, { connectionId: null, query: 'cstmout' }).map((e) => e.id)).toEqual(['g'])
    // Combined with the project filter.
    expect(filterHistory(entries, { connectionId: 'p1', query: 'sum' }).map((e) => e.id)).toEqual(['d'])
  })

  it('lists the projects of the history with counts', () => {
    expect(historyProjects(entries)).toEqual([
      { id: 'p1', name: 'acme-shop', count: 2 },
      { id: 'p2', name: 'blog', count: 1 },
      { id: 'sandbox', name: 'Default', count: 2 },
      { id: 'scratch', name: 'PHP', count: 1 }
    ])
  })
})

describe('history list helpers', () => {
  it('previews the first meaningful line', () => {
    expect(codePreviewLine('<?php\n\n   $orders = Order::latest()->get();\nmore')).toBe('$orders = Order::latest()->get();')
    expect(codePreviewLine('')).toBe('')
    expect(codePreviewLine('x'.repeat(200), 20)).toHaveLength(20)
  })

  it('moves the selection without wrapping', () => {
    expect(stepIndex(-1, 1, 3)).toBe(0)
    expect(stepIndex(-1, -1, 3)).toBe(2)
    expect(stepIndex(0, -1, 3)).toBe(0)
    expect(stepIndex(2, 1, 3)).toBe(2)
    expect(stepIndex(0, 10, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(-1)
  })

  it('selects a neighbour after deleting an entry', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(selectionAfterRemoval(list, 'a')).toBe('b')
    expect(selectionAfterRemoval(list, 'c')).toBe('b')
    expect(selectionAfterRemoval([{ id: 'a' }], 'a')).toBeNull()
  })
})
