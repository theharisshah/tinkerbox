import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/defaults'
import { SECRET_MASK, type Settings } from '../../../src/shared/types'
import { maskSecret, SecretBox, unavailableCipher } from '../../../src/main/store/secrets'
import { normalizeSettings, SettingsStore } from '../../../src/main/store/settings'
import { fakeCipher, noticeCollector, silentLogger, tempDirs } from './helpers'

const tmp = tempDirs()
afterEach(() => tmp.cleanup())

function makeStore(opts: { cipher?: ReturnType<typeof fakeCipher>; file?: string } = {}) {
  const file = opts.file ?? join(tmp.make(), 'settings.json')
  const collector = noticeCollector()
  const box = new SecretBox(opts.cipher ?? fakeCipher(), collector.sink, silentLogger)
  const store = new SettingsStore(file, box, { onNotice: collector.sink, logger: silentLogger })
  return { store, file, notices: collector.notices }
}

function readDisk(file: string): Settings {
  return JSON.parse(readFileSync(file, 'utf8')) as Settings
}

describe('normalizeSettings (load-time deep merge with DEFAULT_SETTINGS)', () => {
  it('fills missing keys from the defaults (forward compatibility)', () => {
    const s = normalizeSettings({ theme: 'dracula', github: {} })
    expect(s.theme).toBe('dracula')
    expect(s.editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize)
    expect(s.github).toEqual({ token: '' })
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })

  it('drops unknown keys and replaces values of the wrong type with defaults', () => {
    const s = normalizeSettings({
      futureSetting: true,
      editorFontSize: 'huge',
      minimap: 'yes',
      github: { token: 42, extra: 'x' },
      ai: { apiKey: 'from an older build' }
    }) as Settings & Record<string, unknown>
    expect(s.futureSetting).toBeUndefined()
    expect(s.ai).toBeUndefined()
    expect(s.editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize)
    expect(s.minimap).toBe(DEFAULT_SETTINGS.minimap)
    expect(s.github).toEqual({ token: '' })
  })

  it('validates enums and clamps numeric ranges', () => {
    const s = normalizeSettings({ layout: 'diagonal', outputType: 'realtime', splitRatio: 5, tabSize: 2.6, historyLimit: -3 })
    expect(s.layout).toBe('vertical')
    expect(s.outputType).toBe('realtime')
    expect(s.splitRatio).toBe(0.85)
    expect(s.tabSize).toBe(3)
    expect(s.historyLimit).toBe(0)
  })

  it('keeps shortcut overrides for known commands only', () => {
    const s = normalizeSettings({ shortcuts: { run: 'CmdOrCtrl+E', notACommand: 'X', prettify: 7 } })
    expect(s.shortcuts).toEqual({ run: 'CmdOrCtrl+E' })
  })

  it('rejects a non-object document (treated as corrupted by the store)', () => {
    expect(() => normalizeSettings([])).toThrow()
    expect(() => normalizeSettings('x')).toThrow()
  })
})

describe('SettingsStore', () => {
  it('returns defaults when nothing is stored', () => {
    const { store } = makeStore()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(store.getMasked()).toEqual(DEFAULT_SETTINGS)
  })

  it('applies DeepPartial patches with a deep merge and ignores invalid values', () => {
    const { store } = makeStore()
    const result = store.update({
      theme: 'nord',
      editorFontSize: 18,
      layout: 'sideways',
      maxDepth: 'deep',
      notASetting: 1
    })
    expect(result.theme).toBe('nord')
    expect(result.editorFontSize).toBe(18)
    expect(result.layout).toBe(DEFAULT_SETTINGS.layout)
    expect(result.maxDepth).toBe(DEFAULT_SETTINGS.maxDepth)
    expect((result as unknown as Record<string, unknown>).notASetting).toBeUndefined()
    expect(store.get().theme).toBe('nord')
  })

  it('merges shortcut overrides key by key; null removes an override', () => {
    const { store } = makeStore()
    store.update({ shortcuts: { run: 'CmdOrCtrl+E' } })
    store.update({ shortcuts: { prettify: 'CmdOrCtrl+Shift+F' } })
    expect(store.get().shortcuts).toEqual({ run: 'CmdOrCtrl+E', prettify: 'CmdOrCtrl+Shift+F' })
    store.update({ shortcuts: { run: null } } as never)
    expect(store.get().shortcuts).toEqual({ prettify: 'CmdOrCtrl+Shift+F' })
    // '' is a valid override (shortcut disabled)
    store.update({ shortcuts: { prettify: '' } })
    expect(store.get().shortcuts).toEqual({ prettify: '' })
  })

  it('encrypts secrets at rest and only exposes SECRET_MASK to the renderer', () => {
    const { store, file } = makeStore()
    const masked = store.update({ github: { token: 'ghp_secret123' } })
    expect(masked.github.token).toBe(SECRET_MASK)
    expect(store.get().github.token).toBe('ghp_secret123')
    store.flushSync()
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('ghp_secret123')
    expect(readDisk(file).github.token.startsWith('tw-enc:v1:')).toBe(true)
  })

  it('keeps the stored secret when SECRET_MASK is saved back, clears it with an empty string', () => {
    const { store } = makeStore()
    store.update({ github: { token: 'ghp_original' } })
    // The renderer echoes the masked settings back with an unrelated change.
    const masked = store.getMasked()
    store.update({ ...masked, theme: 'github' })
    expect(store.get().github.token).toBe('ghp_original')
    expect(store.get().theme).toBe('github')

    store.update({ github: { token: 'ghp_replaced' } })
    expect(store.get().github.token).toBe('ghp_replaced')

    store.update({ github: { token: '' } })
    expect(store.get().github.token).toBe('')
    expect(store.getMasked().github.token).toBe('')
  })

  it('persists and reloads (secrets survive a restart)', () => {
    const cipher = fakeCipher()
    const { store, file } = makeStore({ cipher })
    store.update({ github: { token: 'ghp_persist' }, editorFontSize: 20 })
    store.flushSync()
    const { store: reloaded } = makeStore({ cipher, file })
    expect(reloaded.get().github.token).toBe('ghp_persist')
    expect(reloaded.get().editorFontSize).toBe(20)
  })

  it('falls back to plain storage with a single warning when encryption is unavailable', () => {
    const { store, file, notices } = makeStore({ cipher: { ...unavailableCipher } as ReturnType<typeof fakeCipher> })
    store.update({ github: { token: 'plain-token' } })
    store.update({ github: { token: 'plain-token-2' } })
    expect(store.get().github.token).toBe('plain-token-2')
    store.flushSync()
    expect(readDisk(file).github.token).toBe('tw-plain:plain-token-2')
    expect(notices.filter((n) => n.message.includes('unencrypted'))).toHaveLength(1)
  })

  it('warns once when only weak (basic_text) encryption is available', () => {
    const { store, notices } = makeStore({ cipher: fakeCipher({ weak: true }) })
    store.update({ github: { token: 'a' } })
    store.update({ github: { token: 'b' } })
    expect(notices.filter((n) => n.message.includes('weak'))).toHaveLength(1)
  })

  it('returns an empty secret and warns when stored data cannot be decrypted', () => {
    const file = join(tmp.make(), 'settings.json')
    writeFileSync(file, JSON.stringify({ github: { token: 'tw-enc:v1:AAAA' } }))
    const { store, notices } = makeStore({ cipher: fakeCipher({ failDecrypt: true }), file })
    expect(store.get().github.token).toBe('')
    expect(store.getMasked().github.token).toBe(SECRET_MASK)
    expect(notices.some((n) => n.message.includes('could not be decrypted'))).toBe(true)
  })

  it('reads hand-edited plain secrets and encrypts them on the next save', () => {
    const file = join(tmp.make(), 'settings.json')
    writeFileSync(file, JSON.stringify({ github: { token: 'typed-by-hand' } }))
    const { store } = makeStore({ file })
    expect(store.get().github.token).toBe('typed-by-hand')
    store.update({ github: { token: 'typed-by-hand' } })
    store.flushSync()
    expect(readDisk(file).github.token.startsWith('tw-enc:v1:')).toBe(true)
  })

  it('notifies listeners with decrypted next/previous settings', () => {
    const { store } = makeStore()
    const seen: Array<[string, string]> = []
    store.onChange((next, prev) => seen.push([prev.github.token, next.github.token]))
    store.update({ github: { token: 'one' } })
    store.update({ github: { token: SECRET_MASK } })
    expect(seen).toEqual([
      ['', 'one'],
      ['one', 'one']
    ])
  })

  it('reset() restores DEFAULT_SETTINGS including secrets', () => {
    const { store } = makeStore()
    store.update({ theme: 'nord', github: { token: 'x' } })
    expect(store.reset()).toEqual(DEFAULT_SETTINGS)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('returns a frozen snapshot from get() so main-process callers cannot mutate the cache', () => {
    const { store } = makeStore()
    const s = store.get()
    expect(Object.isFrozen(s)).toBe(true)
    expect(Object.isFrozen(s.github)).toBe(true)
  })

  it('recovers from a corrupted settings.json with a notice', () => {
    const file = join(tmp.make(), 'settings.json')
    writeFileSync(file, '{"theme": "nord",,}')
    const { store, notices } = makeStore({ file })
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(notices.some((n) => n.message.startsWith('Settings file was corrupted'))).toBe(true)
  })

  it('rejects non-object patches', () => {
    const { store } = makeStore()
    expect(() => store.update(null)).toThrow(TypeError)
    expect(() => store.update([1])).toThrow(TypeError)
  })
})

describe('maskSecret', () => {
  it('masks non-empty values only', () => {
    expect(maskSecret('x')).toBe(SECRET_MASK)
    expect(maskSecret('')).toBe('')
    expect(maskSecret(undefined)).toBe('')
  })
})
