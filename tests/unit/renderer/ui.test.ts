import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@/api'
import { useSettingsStore } from '@/stores/settings'
import { MODAL_NAMES, TOAST_TIMEOUT_MS, useUiStore } from '@/stores/ui'
import { fakeBridge } from './helpers'

beforeEach(async () => {
  setBridge(fakeBridge().bridge)
  setActivePinia(createPinia())
  await useSettingsStore().load()
})

afterEach(() => {
  setBridge(null)
  vi.useRealTimers()
})

describe('modals', () => {
  it('replaces by default and stacks on request', async () => {
    const ui = useUiStore()
    const history = ui.openModal('history', {})
    expect(ui.modal).toBe('history')
    void ui.openModal('settings', { page: 'appearance' })
    expect(ui.modals.map((m) => m.name)).toEqual(['settings'])
    expect(ui.modalProps).toEqual({ page: 'appearance' })
    expect(await history).toBeUndefined()
    void ui.openModal('themes', {}, { stack: true })
    expect(ui.modals.map((m) => m.name)).toEqual(['settings', 'themes'])
    ui.closeModal()
    expect(ui.modal).toBe('settings')
  })

  it('hands close results to the opener', async () => {
    const ui = useUiStore()
    const opened = ui.openModal('snippetSave', { code: '1;', connectionId: null })
    ui.closeModal('snippetSave', { saved: true })
    expect(await opened).toEqual({ saved: true })
  })

  it('confirm / prompt resolve with defaults when dismissed', async () => {
    const ui = useUiStore()
    void ui.openModal('settings', {})
    const confirmed = ui.confirm({ title: 'Sure?' })
    expect(ui.modals.map((m) => m.name)).toEqual(['settings', 'confirm'])
    ui.closeModal()
    expect(await confirmed).toBe(false)

    const yes = ui.confirm({ title: 'Sure?' })
    ui.closeModal(undefined, true)
    expect(await yes).toBe(true)

    const asked = ui.prompt({ title: 'Name', value: 'x' })
    expect(ui.modalProps).toMatchObject({ title: 'Name', prompt: { value: 'x' } })
    ui.closeModal(undefined, 'Tinkerbox')
    expect(await asked).toBe('Tinkerbox')

    const dismissed = ui.prompt({ title: 'Name' })
    ui.closeAllModals()
    expect(await dismissed).toBeNull()
  })

  it('toggles modals', () => {
    const ui = useUiStore()
    ui.toggleModal('history', {})
    expect(ui.modal).toBe('history')
    ui.toggleModal('history', {})
    expect(ui.modal).toBeNull()
  })

  it('knows every modal name', () => {
    expect(MODAL_NAMES).toHaveLength(15)
  })
})

describe('toasts', () => {
  it('auto-dismisses after 10 seconds, can be held and replaced by key', () => {
    vi.useFakeTimers()
    const ui = useUiStore()
    const id = ui.toast({ message: 'Hello' })
    expect(ui.toasts).toHaveLength(1)
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1)
    expect(ui.toasts).toHaveLength(1)
    vi.advanceTimersByTime(2)
    expect(ui.toasts).toHaveLength(0)

    const held = ui.toast({ message: 'Hold me' })
    ui.holdToast(held)
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 2)
    expect(ui.toasts.map((t) => t.id)).toEqual([held])
    ui.releaseToast(held, 1000)
    vi.advanceTimersByTime(1001)
    expect(ui.toasts).toHaveLength(0)

    ui.toast({ message: 'one', key: 'k' })
    ui.toast({ message: 'two', key: 'k' })
    expect(ui.toasts.map((t) => t.message)).toEqual(['two'])
    expect(id).not.toBe(held)
  })

  it('keeps at most five toasts and strips IPC prefixes from errors', () => {
    const ui = useUiStore()
    for (let i = 0; i < 7; i++) ui.toast({ message: `m${i}`, timeout: 0 })
    expect(ui.toasts.map((t) => t.message)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6'])
    ui.error(new Error("Error invoking remote method 'x': TypeError: boom"), 'Failed')
    expect(ui.toasts[ui.toasts.length - 1]).toMatchObject({ level: 'error', message: 'Failed: boom' })
  })
})

describe('modals with unsaved input', () => {
  it('keeps a dirty form open underneath when another panel opens', async () => {
    const ui = useUiStore()
    const save = ui.openModal('snippetSave', { code: 'echo 1;', connectionId: null })
    ui.setModalDirty('snippetSave', true)
    expect(ui.isModalDirty('snippetSave')).toBe(true)
    // ⌘B (toggleModal) / ⌘Y open on top instead of discarding the draft …
    ui.toggleModal('snippets', { connectionId: null })
    expect(ui.modals.map((m) => m.name)).toEqual(['snippetSave', 'snippets'])
    // … replacing each other above it …
    void ui.openModal('history', {})
    expect(ui.modals.map((m) => m.name)).toEqual(['snippetSave', 'history'])
    // … and toggling the panel again returns to the draft.
    ui.toggleModal('history', {})
    expect(ui.modals.map((m) => m.name)).toEqual(['snippetSave'])
    // Once the form is clean (or saved) it is replaced as usual.
    ui.setModalDirty('snippetSave', false)
    void ui.openModal('logs', { connectionId: null })
    expect(ui.modals.map((m) => m.name)).toEqual(['logs'])
    expect(await save).toBeUndefined()
  })

  it('forgets the dirty mark when the modal closes', () => {
    const ui = useUiStore()
    void ui.openModal('share', { code: 'echo 1;' })
    ui.setModalDirty('share', true)
    ui.closeModal()
    expect(ui.isModalDirty('share')).toBe(false)
    void ui.openModal('share', { code: 'echo 2;' })
    void ui.openModal('history', {})
    expect(ui.modals.map((m) => m.name)).toEqual(['history'])
  })
})

describe('layout helpers', () => {
  it('derives visibility from settings and zen mode', async () => {
    const ui = useUiStore()
    const settings = useSettingsStore()
    expect(ui.showSidebar).toBe(true)
    expect(ui.showOutput).toBe(true)
    ui.setZen(true)
    expect(ui.showSidebar).toBe(false)
    expect(ui.showOutput).toBe(false)
    expect(ui.showChrome).toBe(false)
    // In zen mode a pane toggle leaves zen mode and shows the pane — it never persists an invisible change.
    await ui.toggleOutput()
    expect(ui.zen).toBe(false)
    expect(settings.settings.showOutput).toBe(true)
    expect(ui.showOutput).toBe(true)
    ui.setZen(true)
    await ui.toggleSidebar()
    expect(ui.zen).toBe(false)
    expect(settings.settings.showToolbar).toBe(true)
    expect(ui.showSidebar).toBe(true)
    // Outside zen mode they toggle the settings.
    await ui.toggleSidebar()
    expect(settings.settings.showToolbar).toBe(false)
    await ui.toggleOutput()
    expect(settings.settings.showOutput).toBe(false)
    // A hidden pane toggled in zen mode leaves zen mode and comes back.
    ui.setZen(true)
    await ui.toggleSidebar()
    expect(ui.zen).toBe(false)
    expect(settings.settings.showToolbar).toBe(true)
    expect(await ui.toggleLayout()).toBe('horizontal')
    expect(settings.settings.layout).toBe('horizontal')
  })

  it('opens and closes the context menu', () => {
    const ui = useUiStore()
    ui.openContextMenu({ x: 10, y: 20 }, [{ label: 'A', action: () => undefined }, { type: 'separator' }])
    expect(ui.contextMenu).toMatchObject({ x: 10, y: 20 })
    ui.openPopover('recentFolders')
    expect(ui.contextMenu).toBeNull()
    expect(ui.popover).toBe('recentFolders')
  })
})
