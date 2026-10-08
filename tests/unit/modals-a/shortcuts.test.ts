import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMMANDS } from '@shared/ipc'
import { setBridge } from '@/api'
import {
  acceleratorSignature,
  captureShortcut,
  commandsUsing,
  effectiveShortcuts,
  filterShortcutRows,
  findShortcutConflicts,
  groupShortcutRows,
  overrideValue,
  reservedShortcut,
  resetAllShortcutsPatch,
  sameAccelerator,
  SHORTCUT_GROUPS,
  shortcutRows
} from '@/components/modals/settings/shortcuts'
import { useSettingsStore } from '@/stores/settings'
import type { KeyboardEventLike } from '@/utils/accelerator'
import { fakeBridge } from '../renderer/helpers'

function key(k: string, mods: Partial<Pick<KeyboardEventLike, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {}, code?: string): KeyboardEventLike {
  const inferred = code ?? (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : k)
  return { key: k, code: inferred, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
}

describe('shortcut capture', () => {
  it('turns key presses into portable accelerators on macOS', () => {
    expect(captureShortcut(key('p', { metaKey: true, shiftKey: true }), 'darwin')).toEqual({ action: 'set', accelerator: 'CmdOrCtrl+Shift+P' })
    expect(captureShortcut(key('k', { ctrlKey: true }), 'darwin')).toEqual({ action: 'set', accelerator: 'Ctrl+K' })
    expect(captureShortcut(key('ArrowUp', { metaKey: true, altKey: true }), 'darwin')).toEqual({ action: 'set', accelerator: 'CmdOrCtrl+Alt+Up' })
    // Option changes the produced character: the physical key wins.
    expect(captureShortcut(key('π', { metaKey: true, altKey: true }, 'KeyP'), 'darwin')).toEqual({ action: 'set', accelerator: 'CmdOrCtrl+Alt+P' })
    expect(captureShortcut(key('.', { ctrlKey: true }, 'Period'), 'darwin')).toEqual({ action: 'set', accelerator: 'Ctrl+.' })
  })

  it('maps Ctrl to CmdOrCtrl on Windows and Linux', () => {
    expect(captureShortcut(key('u', { ctrlKey: true }), 'win32')).toEqual({ action: 'set', accelerator: 'CmdOrCtrl+U' })
    expect(captureShortcut(key('i', { ctrlKey: true, shiftKey: true }), 'linux')).toEqual({ action: 'set', accelerator: 'CmdOrCtrl+Shift+I' })
  })

  it('refuses basic editing / window keys, on every platform', () => {
    for (const k of ['a', 'c', 'v', 'x', 'z']) {
      expect(captureShortcut(key(k, { metaKey: true }), 'darwin')).toMatchObject({ action: 'invalid' })
      expect(captureShortcut(key(k, { ctrlKey: true }), 'win32')).toMatchObject({ action: 'invalid' })
    }
    expect(captureShortcut(key('z', { metaKey: true, shiftKey: true }), 'darwin')).toMatchObject({ action: 'invalid', reason: expect.stringContaining('Redo') })
    expect(captureShortcut(key('q', { metaKey: true }), 'darwin')).toMatchObject({ action: 'invalid', reason: expect.stringContaining('Quit') })
    // Ctrl+Y is Redo on Windows (and why History defaults to Ctrl+I there); ⌘Y is free on macOS.
    expect(captureShortcut(key('y', { ctrlKey: true }), 'win32')).toMatchObject({ action: 'invalid' })
    expect(captureShortcut(key('y', { metaKey: true }), 'darwin')).toEqual({ action: 'set', accelerator: 'CmdOrCtrl+Y' })
    // Editor-only actions are allowed (the Shortcuts page warns instead).
    expect(captureShortcut(key('F3'), 'darwin')).toEqual({ action: 'set', accelerator: 'F3' })
  })

  it('knows the editor actions an app shortcut would take over', () => {
    expect(reservedShortcut('F3', 'darwin')).toMatchObject({ action: 'Find Next', blocked: false })
    expect(reservedShortcut('Shift+F8', 'linux')).toMatchObject({ action: 'Go to Previous Problem', blocked: false })
    expect(reservedShortcut('Cmd+A', 'darwin')).toMatchObject({ action: 'Select All', blocked: true })
    expect(reservedShortcut('CmdOrCtrl+Shift+P', 'darwin')).toBeNull()
    expect(reservedShortcut('', 'darwin')).toBeNull()
  })

  it('cancels on Escape and clears on Backspace / Delete', () => {
    expect(captureShortcut(key('Escape'), 'darwin')).toEqual({ action: 'cancel' })
    expect(captureShortcut(key('Backspace'), 'darwin')).toEqual({ action: 'clear' })
    expect(captureShortcut(key('Delete'), 'win32')).toEqual({ action: 'clear' })
    // With a modifier they are regular keys.
    expect(captureShortcut(key('Backspace', { metaKey: true }), 'darwin')).toEqual({ action: 'set', accelerator: 'CmdOrCtrl+Backspace' })
    expect(captureShortcut(key('Escape', { metaKey: true, shiftKey: true }), 'darwin')).toEqual({ action: 'set', accelerator: 'CmdOrCtrl+Shift+Escape' })
  })

  it('waits while only modifiers are held', () => {
    expect(captureShortcut(key('Meta', { metaKey: true }, 'MetaLeft'), 'darwin')).toEqual({ action: 'pending', modifiers: ['⌘'] })
    expect(captureShortcut(key('Shift', { ctrlKey: true, shiftKey: true }, 'ShiftLeft'), 'win32')).toEqual({ action: 'pending', modifiers: ['Ctrl', 'Shift'] })
  })

  it('rejects plain or Shift-only letters but accepts function keys', () => {
    const plain = captureShortcut(key('a'), 'darwin')
    expect(plain.action).toBe('invalid')
    expect(captureShortcut(key('A', { shiftKey: true }), 'darwin').action).toBe('invalid')
    expect(captureShortcut(key('F5', {}, 'F5'), 'darwin')).toEqual({ action: 'set', accelerator: 'F5' })
    expect(captureShortcut(key('F12', { shiftKey: true }, 'F12'), 'win32')).toEqual({ action: 'set', accelerator: 'Shift+F12' })
  })
})

describe('shortcut conflicts', () => {
  it('treats CmdOrCtrl and the platform modifier as the same keys', () => {
    expect(acceleratorSignature('CmdOrCtrl+Shift+P', 'darwin')).toBe(acceleratorSignature('Shift+Cmd+P', 'darwin'))
    expect(sameAccelerator('CmdOrCtrl+R', 'Ctrl+R', 'win32')).toBe(true)
    expect(sameAccelerator('CmdOrCtrl+R', 'Ctrl+R', 'darwin')).toBe(false)
    expect(acceleratorSignature('', 'darwin')).toBeNull()
  })

  it('has no conflicts with the default shortcuts on any platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(findShortcutConflicts(effectiveShortcuts(platform), platform).size).toBe(0)
    }
  })

  it('flags commands that share keys after an override', () => {
    const overrides = { prettify: 'CmdOrCtrl+R' }
    const conflicts = findShortcutConflicts(effectiveShortcuts('darwin', overrides), 'darwin')
    expect(conflicts.get('prettify')).toEqual(['run'])
    expect(conflicts.get('run')).toEqual(['prettify'])
    expect(conflicts.has('newTab')).toBe(false)
    expect(commandsUsing('Cmd+R', effectiveShortcuts('darwin', overrides), 'darwin', 'prettify')).toEqual(['run'])
  })

  it('ignores removed shortcuts', () => {
    const shortcuts = effectiveShortcuts('darwin', { run: '', prettify: '' })
    expect(shortcuts.run).toBe('')
    expect(findShortcutConflicts(shortcuts, 'darwin').size).toBe(0)
  })

  it('stores null instead of an override equal to the default', () => {
    expect(overrideValue('run', 'CmdOrCtrl+R', 'darwin')).toBeNull()
    expect(overrideValue('run', 'Cmd+R', 'darwin')).toBeNull()
    expect(overrideValue('run', 'CmdOrCtrl+E', 'darwin')).toBe('CmdOrCtrl+E')
    expect(overrideValue('run', '', 'darwin')).toBe('')
    // cancelRun has no default: clearing it needs no override.
    expect(overrideValue('cancelRun', '', 'darwin')).toBeNull()
    // History differs per platform (⌘Y vs Ctrl+I).
    expect(overrideValue('showHistory', 'Ctrl+I', 'win32')).toBeNull()
    expect(overrideValue('showHistory', 'Ctrl+I', 'darwin')).toBe('Ctrl+I')
  })

  it('builds a reset-all patch for every override', () => {
    expect(resetAllShortcutsPatch({ run: 'CmdOrCtrl+E', prettify: '' })).toEqual({ shortcuts: { run: null, prettify: null } })
  })
})

describe('shortcut rows', () => {
  it('lists every command with effective, default and overridden state', () => {
    const rows = shortcutRows('darwin', { run: 'CmdOrCtrl+E', toggleLayout: 'Ctrl+.' })
    expect(rows.map((r) => r.id)).toEqual([...COMMANDS])
    const run = rows.find((r) => r.id === 'run')!
    expect(run).toMatchObject({ accelerator: 'CmdOrCtrl+E', defaultAccelerator: 'CmdOrCtrl+R', overridden: true, conflicts: [] })
    // An override that equals the default does not count as changed.
    expect(rows.find((r) => r.id === 'toggleLayout')!.overridden).toBe(false)
  })

  it('groups rows in menu order and searches titles and keys', () => {
    const rows = shortcutRows('darwin')
    const all = groupShortcutRows(rows, '', 'darwin')
    expect(all.map((g) => g.group)).toEqual([...SHORTCUT_GROUPS])
    expect(all.reduce((n, g) => n + g.rows.length, 0)).toBe(COMMANDS.length)

    const byTitle = groupShortcutRows(rows, 'snippets', 'darwin')
    const ids = byTitle.flatMap((g) => g.rows.map((r) => r.id))
    expect(ids).toContain('showSnippets')
    expect(ids).toContain('addToSnippets')

    expect(filterShortcutRows(rows, '⇧⌘P', 'darwin').map((r) => r.id)).toEqual(['commandPalette'])
    expect(groupShortcutRows(rows, '⇧⌘P', 'darwin')).toEqual([{ group: 'Panels', rows: [rows.find((r) => r.id === 'commandPalette')] }])
    const win = shortcutRows('win32')
    expect(filterShortcutRows(win, 'ctrl shift p', 'win32').map((r) => r.id)).toEqual(['commandPalette'])
    expect(filterShortcutRows(win, 'Ctrl+I', 'win32').map((r) => r.id)[0]).toBe('showHistory')

    expect(groupShortcutRows(rows, 'zzzzqqq', 'darwin')).toEqual([])
  })
})

describe('saving captured shortcuts', () => {
  beforeEach(async () => {
    setBridge(fakeBridge().bridge)
    setActivePinia(createPinia())
    await useSettingsStore().load()
  })

  afterEach(() => setBridge(null))

  it('persists overrides and returns to the default with null', async () => {
    const settings = useSettingsStore()
    const captured = captureShortcut(key('e', { metaKey: true }), 'darwin')
    expect(captured.action).toBe('set')
    if (captured.action !== 'set') return
    await settings.setShortcut('run', overrideValue('run', captured.accelerator, 'darwin'))
    expect(settings.settings.shortcuts.run).toBe('CmdOrCtrl+E')
    expect(shortcutRows('darwin', settings.settings.shortcuts).find((r) => r.id === 'run')!.overridden).toBe(true)

    await settings.setShortcut('run', overrideValue('run', 'CmdOrCtrl+R', 'darwin'))
    expect(settings.settings.shortcuts.run).toBeUndefined()

    await settings.setShortcut('prettify', 'CmdOrCtrl+E')
    await settings.setShortcut('zoomIn', '')
    await settings.update(resetAllShortcutsPatch(settings.settings.shortcuts) as never)
    expect(settings.settings.shortcuts).toEqual({})
  })
})
