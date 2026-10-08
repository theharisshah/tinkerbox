import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonStore, writeFileAtomicSync } from '../../../src/main/store/jsonStore'
import { noticeCollector, silentLogger, tempDirs } from './helpers'

interface Doc {
  count: number
  items: string[]
}

const tmp = tempDirs()
afterEach(() => {
  tmp.cleanup()
  vi.useRealTimers()
})

function makeStore(file: string, extra: Partial<ConstructorParameters<typeof JsonStore<Doc>>[0]> = {}) {
  return new JsonStore<Doc>({
    file,
    label: 'Doc',
    defaults: () => ({ count: 0, items: [] }),
    normalize: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
      const r = raw as Record<string, unknown>
      return { count: typeof r.count === 'number' ? r.count : 0, items: Array.isArray(r.items) ? (r.items as string[]) : [] }
    },
    logger: silentLogger,
    ...extra
  })
}

describe('writeFileAtomicSync', () => {
  it('writes the file, creates missing directories and leaves no temp files behind', () => {
    const dir = tmp.make()
    const file = join(dir, 'nested', 'deeper', 'data.json')
    writeFileAtomicSync(file, '{"a":1}')
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}')
    writeFileAtomicSync(file, '{"a":2}')
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}')
    expect(readdirSync(join(dir, 'nested', 'deeper'))).toEqual(['data.json'])
  })

  it('cleans up its temp file and keeps the old content when the rename fails', () => {
    const dir = tmp.make()
    // The target is a non-empty directory, so rename() over it fails.
    const target = join(dir, 'target.json')
    mkdirSync(target)
    writeFileSync(join(target, 'keep'), 'x')
    expect(() => writeFileAtomicSync(target, 'data')).toThrow()
    expect(readdirSync(dir)).toEqual(['target.json'])
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('x')
  })
})

describe('JsonStore', () => {
  it('uses defaults when the file does not exist and does not create it until something changes', () => {
    const dir = tmp.make()
    const store = makeStore(join(dir, 'doc.json'))
    expect(store.value).toEqual({ count: 0, items: [] })
    expect(store.flushSync()).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  })

  it('debounces writes and flushSync writes the latest value atomically', () => {
    vi.useFakeTimers()
    const dir = tmp.make()
    const file = join(dir, 'doc.json')
    const store = makeStore(file, { debounceMs: 200 })
    store.set({ count: 1, items: [] })
    store.set({ count: 2, items: [] })
    store.update((d) => ({ ...d, count: 3 }))
    vi.advanceTimersByTime(150)
    expect(readdirSync(dir)).toEqual([])
    vi.advanceTimersByTime(100)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ count: 3, items: [] })

    store.set({ count: 4, items: ['a'] })
    expect(store.flushSync()).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ count: 4, items: ['a'] })
    expect(readdirSync(dir)).toEqual(['doc.json'])
    store.dispose()
  })

  it('reads back what it wrote', () => {
    const dir = tmp.make()
    const file = join(dir, 'doc.json')
    const a = makeStore(file, { pretty: true })
    a.set({ count: 7, items: ['x', 'y'] })
    a.flushSync()
    expect(readFileSync(file, 'utf8')).toContain('\n  "count": 7')
    expect(makeStore(file).value).toEqual({ count: 7, items: ['x', 'y'] })
  })

  it('backs up a corrupted file, falls back to defaults, rewrites the file and emits a notice', () => {
    const dir = tmp.make()
    const file = join(dir, 'doc.json')
    writeFileSync(file, '{"count": 5, "items": [')
    const { notices, sink } = noticeCollector()
    const store = makeStore(file, { onNotice: sink, now: () => 1234 })

    expect(store.value).toEqual({ count: 0, items: [] })
    const backup = join(dir, 'doc.corrupt-1234.json')
    expect(readFileSync(backup, 'utf8')).toBe('{"count": 5, "items": [')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ count: 0, items: [] })
    expect(notices).toHaveLength(1)
    expect(notices[0].level).toBe('warning')
    expect(notices[0].message).toContain('Doc file was corrupted')
    expect(notices[0].message).toContain(backup)
  })

  it('treats valid JSON with the wrong shape as corrupted', () => {
    const dir = tmp.make()
    const file = join(dir, 'doc.json')
    writeFileSync(file, '[1,2,3]')
    const { notices, sink } = noticeCollector()
    const store = makeStore(file, { onNotice: sink, now: () => 42 })
    expect(store.value).toEqual({ count: 0, items: [] })
    expect(readdirSync(dir).sort()).toEqual(['doc.corrupt-42.json', 'doc.json'])
    expect(notices).toHaveLength(1)
  })

  it('treats an empty file as missing (no backup, no notice)', () => {
    const dir = tmp.make()
    const file = join(dir, 'doc.json')
    writeFileSync(file, '  \n')
    const { notices, sink } = noticeCollector()
    expect(makeStore(file, { onNotice: sink }).value).toEqual({ count: 0, items: [] })
    expect(notices).toEqual([])
    expect(readdirSync(dir)).toEqual(['doc.json'])
  })

  it('reports a write failure once and keeps the data dirty for a later retry', () => {
    const dir = tmp.make()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'file, not a directory')
    const { notices, sink } = noticeCollector()
    const store = makeStore(join(blocker, 'doc.json'), { onNotice: sink })
    store.set({ count: 1, items: [] })
    expect(store.flushSync()).toBe(false)
    store.set({ count: 2, items: [] })
    expect(store.flushSync()).toBe(false)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ level: 'error' })
    expect(notices[0].message).toContain('Doc could not be saved')
  })

  // chmod 000 does not stop root, and Windows has no POSIX modes.
  const canMakeUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0

  it.skipIf(!canMakeUnreadable)('never overwrites a file it could not read (EACCES) with defaults', () => {
    const dir = tmp.make()
    const file = join(dir, 'doc.json')
    const original = JSON.stringify({ count: 7, items: ['user', 'data'] })
    writeFileSync(file, original)
    chmodSync(file, 0o000)
    const { notices, sink } = noticeCollector()
    const store = makeStore(file, { onNotice: sink })
    try {
      expect(store.value).toEqual({ count: 0, items: [] })
      expect(store.readOnly).toBe(true)
      expect(notices).toHaveLength(1)
      expect(notices[0].message).toContain('could not be read')
      expect(notices[0].message).toContain('not saved')
      // The problem goes away mid-session (permissions fixed): the session's changes still must not clobber the file.
      chmodSync(file, 0o644)
      store.set({ count: 1, items: [] })
      expect(store.flushSync()).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(original)
      expect(readdirSync(dir)).toEqual(['doc.json'])
      // Only once the file is gone there is nothing left to protect.
      rmSync(file)
      expect(store.flushSync()).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ count: 1, items: [] })
      expect(store.readOnly).toBe(false)
    } finally {
      store.dispose()
    }
    // A later session reads the user's file normally again.
    writeFileSync(file, original)
    expect(makeStore(file).value).toEqual({ count: 7, items: ['user', 'data'] })
  })
})
