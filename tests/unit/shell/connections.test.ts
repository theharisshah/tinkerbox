import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/defaults'
import type { Settings } from '../../../src/shared/types'
import { createConnectionResolver } from '../../../src/main/ipc/connectionResolver'
import { ConnectionsStore, localConnectionId, sanitizeConnection } from '../../../src/main/store/connections'
import { silentLogger, tempDirs } from './helpers'

const tmp = tempDirs()
afterEach(() => tmp.cleanup())

function makeStore(opts: { platform?: NodeJS.Platform; file?: string; clock?: { t: number } } = {}) {
  const file = opts.file ?? join(tmp.make(), 'connections.json')
  const clock = opts.clock ?? { t: 1000 }
  const store = new ConnectionsStore(file, {
    logger: silentLogger,
    platform: opts.platform ?? 'linux',
    now: () => clock.t
  })
  return { store, file, clock }
}

describe('ConnectionsStore.openLocal', () => {
  it('creates a project connection named after the folder with a deterministic id', () => {
    const { store } = makeStore()
    const conn = store.openLocal('/home/me/code/my-app')
    expect(conn).toEqual({
      id: localConnectionId('/home/me/code/my-app', 'linux'),
      name: 'my-app',
      type: 'local',
      path: '/home/me/code/my-app',
      createdAt: 1000,
      lastUsedAt: 1000
    })
  })

  it('reuses the existing connection for the same folder (trailing slash, ..) and bumps lastUsedAt', () => {
    const { store, clock } = makeStore()
    const first = store.openLocal('/srv/app')
    clock.t = 2000
    const again = store.openLocal('/srv/app/')
    clock.t = 3000
    const viaDots = store.openLocal('/srv/other/../app')
    expect(again.id).toBe(first.id)
    expect(viaDots.id).toBe(first.id)
    expect(viaDots.lastUsedAt).toBe(3000)
    expect(viaDots.createdAt).toBe(1000)
    expect(store.list()).toHaveLength(1)
  })

  it('treats paths case-insensitively on macOS and case-sensitively on Linux', () => {
    const mac = makeStore({ platform: 'darwin' }).store
    mac.openLocal('/Users/me/Sites/App')
    mac.openLocal('/users/me/sites/app')
    expect(mac.list()).toHaveLength(1)

    const linux = makeStore({ platform: 'linux' }).store
    linux.openLocal('/home/me/App')
    linux.openLocal('/home/me/app')
    expect(linux.list()).toHaveLength(2)
  })

  it('keeps user settings of an existing project when it is opened again', () => {
    const { store } = makeStore()
    const conn = store.openLocal('/srv/app')
    store.save({ ...conn, phpBinary: 'php83', debug: true })
    const reopened = store.openLocal('/srv/app')
    expect(reopened.phpBinary).toBe('php83')
    expect(reopened.debug).toBe(true)
  })

  it('rejects relative paths', () => {
    const { store } = makeStore()
    expect(() => store.openLocal('relative/dir')).toThrow(TypeError)
  })
})

describe('ConnectionsStore recents', () => {
  it('lists most recently used first; touch() reorders; unknown ids are ignored', () => {
    const { store, clock } = makeStore()
    const a = store.openLocal('/p/a')
    clock.t = 2000
    store.openLocal('/p/b')
    clock.t = 3000
    store.touch(a.id)
    store.touch('sandbox')
    expect(store.list().map((c) => c.name)).toEqual(['a', 'b'])
    expect(store.recentFolders(1).map((c) => c.name)).toEqual(['a'])
  })

  it('clearRecents() removes plain folders but keeps projects with settings (without lastUsedAt)', () => {
    const { store } = makeStore()
    store.openLocal('/p/plain')
    const tuned = store.openLocal('/p/tuned')
    store.save({ ...tuned, phpBinary: '/opt/php/8.2/bin/php' })
    store.clearRecents()
    const list = store.list()
    expect(list.map((c) => c.name)).toEqual(['tuned'])
    expect(list[0].lastUsedAt).toBeUndefined()
    expect(list[0].phpBinary).toBe('/opt/php/8.2/bin/php')
    expect(store.recentFolders()).toEqual([])
  })

  it('clearRecents(keep) keeps folders that open tabs or snippets still reference', () => {
    const { store } = makeStore()
    const open = store.openLocal('/p/open-in-a-tab')
    store.openLocal('/p/forgotten')
    store.clearRecents([open.id, 'unknown-id'])
    expect(store.list().map((c) => c.name)).toEqual(['open-in-a-tab'])
    expect(store.list()[0].lastUsedAt).toBeUndefined()
    expect(store.recentFolders()).toEqual([])
  })

  it('notifies listeners with the full snapshot', () => {
    const { store } = makeStore()
    const seen: number[] = []
    store.onChange((data) => seen.push(data.connections.length))
    store.openLocal('/p/a')
    store.openLocal('/p/b')
    store.clearRecents()
    expect(seen).toEqual([1, 2, 0])
  })
})

describe('ConnectionsStore persistence & validation', () => {
  it('saves, updates (keeping createdAt), deletes and reloads', () => {
    const { store, file, clock } = makeStore()
    const saved = store.save({ id: 'p1', type: 'local', name: 'Custom', path: '/srv/x/', createdAt: 5 })
    expect(saved.path).toBe('/srv/x')
    clock.t = 9999
    store.save({ ...saved, name: 'Renamed', createdAt: 77 })
    expect(store.get('p1')).toMatchObject({ name: 'Renamed', createdAt: 5 })
    store.save({ id: 'p2', type: 'local', name: '', path: '/srv/y', createdAt: 1 })
    expect(store.delete('p2')).toBe(true)
    expect(store.delete('p2')).toBe(false)
    store.flushSync()
    const reloaded = makeStore({ file }).store
    expect(reloaded.list()).toEqual([{ id: 'p1', type: 'local', name: 'Renamed', path: '/srv/x', createdAt: 5 }])
  })

  it('rejects unsupported connection types and relative paths', () => {
    expect(() => sanitizeConnection({ type: 'ssh', host: 'example.com' })).toThrow(TypeError)
    expect(() => sanitizeConnection({ type: 'local', path: 'not/absolute' })).toThrow(TypeError)
    expect(() => sanitizeConnection(null)).toThrow(TypeError)
  })

  it('drops invalid / unsupported entries on load instead of failing', () => {
    const file = join(tmp.make(), 'connections.json')
    writeFileSync(
      file,
      JSON.stringify({
        connections: [
          { id: 'ok', type: 'local', name: 'ok', path: '/ok', createdAt: 1 },
          { id: 'remote', type: 'ssh', host: 'h', path: '/var/www' },
          { id: 'ok', type: 'local', name: 'duplicate id', path: '/dup', createdAt: 1 },
          'garbage'
        ],
        groups: [{ id: 'g', name: 'legacy' }]
      })
    )
    const { store } = makeStore({ file })
    expect(store.list().map((c) => c.id)).toEqual(['ok'])
    store.touch('ok')
    store.flushSync()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      connections: [{ id: 'ok', type: 'local', name: 'ok', path: '/ok', createdAt: 1, lastUsedAt: 1000 }]
    })
  })

  it('findLocalByPath matches normalized paths', () => {
    const { store } = makeStore()
    const conn = store.openLocal('/srv/app')
    expect(store.findLocalByPath('/srv/app/')?.id).toBe(conn.id)
    expect(store.findLocalByPath('/srv/other')).toBeUndefined()
  })
})

describe('connection resolver (ExecutionContext.resolveConnection)', () => {
  function resolverWith(opts: { defaultDir?: string; sandboxInstalled?: boolean; dirs?: string[] } = {}) {
    const { store } = makeStore()
    const settings: Settings = { ...DEFAULT_SETTINGS, defaultWorkingDirectory: opts.defaultDir ?? '' }
    const resolve = createConnectionResolver({
      connections: store,
      settings: () => settings,
      sandbox: () => ({ installed: opts.sandboxInstalled ?? false, path: '/data/sandbox' }),
      isDirectory: (p) => (opts.dirs ?? []).includes(p),
      platform: 'linux',
      homeDir: '/home/me'
    })
    return { resolve, store }
  }

  it("resolves 'scratch' to plain PHP", () => {
    const { resolve } = resolverWith()
    expect(resolve('scratch')).toMatchObject({ id: 'scratch', name: 'PHP', path: '' })
  })

  it("resolves 'sandbox' to the sandbox path when installed, plain PHP otherwise", () => {
    expect(resolverWith({ sandboxInstalled: true }).resolve('sandbox')).toMatchObject({ id: 'sandbox', name: 'Default', path: '/data/sandbox' })
    expect(resolverWith({ sandboxInstalled: false }).resolve('sandbox')).toMatchObject({ id: 'sandbox', path: '' })
  })

  it('resolves null via Default Working Directory → sandbox → scratch', () => {
    expect(resolverWith({ defaultDir: '/work/app', dirs: ['/work/app'] }).resolve(null)).toMatchObject({
      id: localConnectionId('/work/app', 'linux'),
      name: 'app',
      path: '/work/app'
    })
    // Configured directory missing → sandbox (installed) → scratch.
    expect(resolverWith({ defaultDir: '/gone', sandboxInstalled: true }).resolve(null).id).toBe('sandbox')
    expect(resolverWith({ defaultDir: '/gone' }).resolve(null).id).toBe('scratch')
  })

  it('expands ~ in the Default Working Directory (runs go to the project, not to plain PHP in the temp dir)', () => {
    expect(resolverWith({ defaultDir: '~/tildeproj', dirs: ['/home/me/tildeproj'] }).resolve(null)).toMatchObject({
      id: localConnectionId('/home/me/tildeproj', 'linux'),
      name: 'tildeproj',
      path: '/home/me/tildeproj'
    })
    expect(resolverWith({ defaultDir: '~', dirs: ['/home/me'] }).resolve(null)).toMatchObject({ path: '/home/me' })
    // A stored project for the expanded path is used with its settings.
    const { resolve, store } = resolverWith({ defaultDir: ' ~/tildeproj ', dirs: ['/home/me/tildeproj'] })
    const conn = store.openLocal('/home/me/tildeproj')
    store.save({ ...conn, phpBinary: 'php83' })
    expect(resolve(null)).toMatchObject({ id: conn.id, phpBinary: 'php83' })
  })

  it('uses the stored project (with its settings) for the Default Working Directory', () => {
    const { resolve, store } = resolverWith({ defaultDir: '/work/app', dirs: ['/work/app'] })
    const conn = store.openLocal('/work/app')
    store.save({ ...conn, phpBinary: 'php82' })
    expect(resolve(null)).toMatchObject({ id: conn.id, phpBinary: 'php82' })
  })

  it('applies stored overrides (PHP binary / Xdebug) to the implicit sandbox connection', () => {
    const { resolve, store } = resolverWith({ sandboxInstalled: true })
    store.save({ id: 'sandbox', type: 'local', name: 'Default', path: '', phpBinary: 'php84', debug: true, createdAt: 0 })
    expect(resolve('sandbox')).toMatchObject({ id: 'sandbox', path: '/data/sandbox', phpBinary: 'php84', debug: true })
  })

  it('returns stored projects and throws for unknown ids', () => {
    const { resolve, store } = resolverWith()
    const conn = store.openLocal('/p/a')
    expect(resolve(conn.id)).toEqual(conn)
    expect(() => resolve('missing')).toThrow(/no longer available/)
  })
})
