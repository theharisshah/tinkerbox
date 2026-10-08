import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../../../src/shared/types'
import { historyEntryFromRun, HistoryStore, MAX_HISTORY_CODE, previewDump, runPreview } from '../../../src/main/store/history'
import { runResult, silentLogger, tempDirs } from './helpers'

const tmp = tempDirs()
afterEach(() => tmp.cleanup())

function entry(i: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `h${i}`,
    code: `echo ${i};`,
    connectionId: 'sandbox',
    connectionName: 'Default',
    ranAt: 1000 + i,
    durationMs: 10,
    ok: true,
    preview: String(i),
    ...overrides
  }
}

describe('HistoryStore', () => {
  it('keeps entries newest first and caps them at historyLimit', () => {
    const store = new HistoryStore(join(tmp.make(), 'history.json'), 3, { logger: silentLogger })
    for (let i = 1; i <= 5; i++) store.add(entry(i))
    expect(store.list().map((e) => e.id)).toEqual(['h5', 'h4', 'h3'])
  })

  it('moves a re-run of the same code on the same connection to the top instead of duplicating it', () => {
    const store = new HistoryStore(join(tmp.make(), 'history.json'), 10, { logger: silentLogger })
    store.add(entry(1, { code: 'User::count()' }))
    store.add(entry(2, { code: 'User::count()' }))
    store.add(entry(3, { code: 'User::count()', connectionId: 'other' }))
    expect(store.list().map((e) => e.id)).toEqual(['h3', 'h2'])
  })

  it('does not store empty code, oversized code or anything when the limit is 0', () => {
    const store = new HistoryStore(join(tmp.make(), 'history.json'), 10, { logger: silentLogger })
    expect(store.add(entry(1, { code: '   ' }))).toBe(false)
    expect(store.add(entry(2, { code: 'x'.repeat(MAX_HISTORY_CODE + 1) }))).toBe(false)
    store.setLimit(0)
    expect(store.add(entry(3))).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('setLimit trims immediately; delete and clear work; data survives a reload', () => {
    const file = join(tmp.make(), 'history.json')
    const store = new HistoryStore(file, 10, { logger: silentLogger })
    for (let i = 1; i <= 6; i++) store.add(entry(i))
    store.setLimit(4)
    expect(store.list()).toHaveLength(4)
    expect(store.delete('h5')).toBe(true)
    expect(store.delete('nope')).toBe(false)
    store.flushSync()
    const reloaded = new HistoryStore(file, 2, { logger: silentLogger })
    // The cap of the new limit is applied on load.
    expect(reloaded.list().map((e) => e.id)).toEqual(['h6', 'h4'])
    reloaded.clear()
    expect(reloaded.list()).toEqual([])
  })
})

describe('history previews', () => {
  it('previews dumped values VarDumper-style on one line', () => {
    expect(previewDump({ t: 'string', v: 'hello', len: 5 })).toBe('"hello"')
    expect(previewDump({ t: 'int', v: '42' })).toBe('42')
    expect(previewDump({ t: 'bool', v: false })).toBe('false')
    expect(previewDump(null)).toBe('null')
    expect(
      previewDump({
        t: 'array',
        count: 3,
        items: [
          { k: 0, v: { t: 'int', v: '1' } },
          { k: 1, v: { t: 'int', v: '2' } },
          { k: 2, v: { t: 'array', count: 2, items: [] } }
        ]
      })
    ).toBe('[1, 2, array:2 [...]]')
    expect(previewDump({ t: 'array', count: 1, items: [{ k: 'name', v: { t: 'string', v: 'Ada', len: 3 } }] })).toBe('["name" => "Ada"]')
    expect(previewDump({ t: 'object', class: 'App\\Models\\User', id: 12, kind: 'model', summary: '#1', props: [] })).toBe(
      'App\\Models\\User {#12 #1}'
    )
    expect(previewDump({ t: 'enum', class: 'Status', case: 'Active', value: 'active' })).toBe('Status::Active')
    expect(previewDump({ t: 'string', v: 'x'.repeat(500), len: 500 }, 20)).toHaveLength(20)
  })

  it('summarizes a run: exception > error > return value > first output', () => {
    expect(runPreview(runResult({ cancelled: true }))).toBe('Cancelled')
    expect(runPreview(runResult({ ok: false, error: 'PHP binary not found:\n php99' }))).toBe('PHP binary not found: php99')
    expect(
      runPreview(
        runResult({
          ok: false,
          exception: { class: 'RuntimeException', message: 'Boom', code: '0', file: 'x', line: 1, trace: [] }
        })
      )
    ).toBe('RuntimeException: Boom')
    expect(runPreview(runResult({ hasReturnValue: true, returnValue: { t: 'int', v: '3' } }))).toBe('3')
    expect(runPreview(runResult({ events: [{ seq: 1, kind: 'echo', text: '  hi\nthere ' }] }))).toBe('hi there')
  })

  it('builds a history entry from a run result', () => {
    const e = historyEntryFromRun({ code: '1 + 2' }, runResult({ hasReturnValue: true, returnValue: { t: 'int', v: '3' } }), 'Default', 'id1')
    expect(e).toEqual({
      id: 'id1',
      code: '1 + 2',
      connectionId: 'sandbox',
      connectionName: 'Default',
      ranAt: 5000,
      durationMs: 123,
      ok: true,
      preview: '3'
    })
  })
})
