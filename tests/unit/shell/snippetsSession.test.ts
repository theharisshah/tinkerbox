import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sanitizeSession, SessionStore } from '../../../src/main/store/session'
import { parseSnippetExport, SnippetsStore } from '../../../src/main/store/snippets'
import { silentLogger, tempDirs } from './helpers'

const tmp = tempDirs()
afterEach(() => tmp.cleanup())

describe('SnippetsStore', () => {
  it('creates, updates (keeping createdAt) and deletes user snippets', () => {
    const clock = { t: 100 }
    const store = new SnippetsStore(join(tmp.make(), 'snippets.json'), { logger: silentLogger, now: () => clock.t })
    const created = store.save({ name: ' Count users ', code: 'User::count()', connectionId: '', source: 'project' })
    expect(created).toMatchObject({ name: 'Count users', source: 'user', createdAt: 100, updatedAt: 100 })
    clock.t = 200
    const updated = store.save({ ...created, description: 'All of them', createdAt: 1 })
    expect(updated).toMatchObject({ id: created.id, createdAt: 100, updatedAt: 200, description: 'All of them' })
    expect(store.list()).toHaveLength(1)
    expect(store.delete(created.id)).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('validates input', () => {
    const store = new SnippetsStore(join(tmp.make(), 'snippets.json'), { logger: silentLogger })
    expect(() => store.save({ name: '', code: 'x' })).toThrow(TypeError)
    expect(() => store.save({ name: 'x' })).toThrow(TypeError)
    expect(() => store.save('nope')).toThrow(TypeError)
  })

  it('exports and re-imports, skipping duplicates and renaming colliding ids', () => {
    const file = join(tmp.make(), 'snippets.json')
    const store = new SnippetsStore(file, { logger: silentLogger })
    store.save({ id: 's1', name: 'One', code: '1' })
    const exported = store.exportJson()
    expect(JSON.parse(exported)).toMatchObject({ app: 'tinkerbox', version: 1, snippets: [{ id: 's1', name: 'One' }] })

    // Same snippet again → skipped. Same id but different content → imported with a new id.
    const exportedList = JSON.parse(exported).snippets as unknown[]
    const imported = store.importMany(
      parseSnippetExport(
        JSON.stringify([
          ...exportedList,
          { id: 's1', name: 'Other', code: '2' },
          { label: 'From another app', content: 'now()' },
          { name: '' }
        ])
      )
    )
    expect(imported).toBe(2)
    const names = store.list().map((s) => s.name)
    expect(names).toEqual(['One', 'Other', 'From another app'])
    expect(new Set(store.list().map((s) => s.id)).size).toBe(3)
    store.flushSync()
    expect(JSON.parse(readFileSync(file, 'utf8')).snippets).toHaveLength(3)
  })

  it('reports unreadable export files clearly', () => {
    expect(() => parseSnippetExport('{nope')).toThrow(/not valid JSON/)
    expect(() => parseSnippetExport('{"x": 1}')).toThrow(/list of snippets/)
    expect(parseSnippetExport('[{"name":"a","code":"b"}]')).toHaveLength(1)
  })
})

describe('SessionStore', () => {
  const tab = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: 'code',
    title: id,
    code: `// ${id}`,
    connectionId: null,
    outputMode: 'detail',
    showQueries: false,
    ...extra
  })

  it('round-trips a session', () => {
    const file = join(tmp.make(), 'session.json')
    const store = new SessionStore(file, { logger: silentLogger })
    expect(store.load()).toBeNull()
    const state = { tabs: [tab('a', { filePath: '/x/a.php', customTitle: 'Mine', dirty: true }), tab('b')], activeTabId: 'b' }
    store.save(state)
    store.flushSync()
    expect(new SessionStore(file, { logger: silentLogger }).load()).toEqual(state)
  })

  it('drops invalid tabs and fixes a dangling activeTabId', () => {
    const s = sanitizeSession({
      tabs: [tab('a'), { id: 'bad' }, tab('a'), tab('w', { kind: 'welcome', outputMode: 'weird', connectionId: 5 })],
      activeTabId: 'missing'
    })
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'w'])
    expect(s.tabs[1]).toMatchObject({ outputMode: 'detail', connectionId: null })
    expect(s.activeTabId).toBe('a')
    expect(() => sanitizeSession({})).toThrow(TypeError)
  })
})
