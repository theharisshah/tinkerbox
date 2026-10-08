import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMMANDS } from '@shared/ipc'
import { COMMAND_META } from '@shared/shortcuts'
import { setBridge } from '@/api'
import { commandList, executeCommand, handleKeydown, isCommandId } from '@/commands'
import { registerEditor } from '@/editorBridge'
import { useSettingsStore } from '@/stores/settings'
import { useTabsStore } from '@/stores/tabs'
import { useUiStore } from '@/stores/ui'
import { parseAccelerator } from '@/utils/accelerator'
import { platform } from '@/utils/platform'
import { fakeBridge, fakeEditor, okResult, type FakeBridge } from './helpers'

let fake: FakeBridge
const cleanups: Array<() => void> = []

beforeEach(async () => {
  fake = fakeBridge({ 'run:start': (request) => okResult(request) })
  setBridge(fake.bridge)
  setActivePinia(createPinia())
  await useSettingsStore().load()
  await useSettingsStore().update({ welcomeTab: false, prettifyOnRun: false })
  await useTabsStore().init()
})

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
  useTabsStore().dispose()
  setBridge(null)
})

function keyEvent(accel: string): KeyboardEvent {
  const parsed = parseAccelerator(accel, platform)!
  let prevented = false
  const key = parsed.key.length === 1 ? parsed.key : parsed.key === 'Escape' ? 'Escape' : parsed.key
  return {
    key,
    code: /^[A-Z]$/.test(key) ? `Key${key}` : key,
    metaKey: parsed.meta,
    ctrlKey: parsed.ctrl,
    altKey: parsed.alt,
    shiftKey: parsed.shift,
    isComposing: false,
    target: null,
    get defaultPrevented() {
      return prevented
    },
    preventDefault() {
      prevented = true
    },
    stopPropagation() {}
  } as unknown as KeyboardEvent
}

describe('command registry', () => {
  it('lists every command with metadata and effective shortcuts', () => {
    const list = commandList()
    expect(list.map((c) => c.id)).toEqual([...COMMANDS])
    const run = list.find((c) => c.id === 'run')!
    expect(run.title).toBe(COMMAND_META.run.title)
    expect(run.shortcut).toBe('CmdOrCtrl+R')
    expect(run.shortcutLabel).not.toBe('')
    expect(isCommandId('run')).toBe(true)
    expect(isCommandId('nope')).toBe(false)
  })

  it('reflects shortcut overrides', async () => {
    await useSettingsStore().setShortcut('run', 'CmdOrCtrl+Enter')
    expect(commandList().find((c) => c.id === 'run')!.shortcut).toBe('CmdOrCtrl+Enter')
    await useSettingsStore().setShortcut('run', null)
    expect(commandList().find((c) => c.id === 'run')!.shortcut).toBe('CmdOrCtrl+R')
  })

  it('executes every command without throwing', async () => {
    const ui = useUiStore()
    for (const id of COMMANDS) {
      await executeCommand(id)
      ui.closeAllModals()
    }
    const errors = ui.toasts.filter((t) => t.level === 'error')
    expect(errors.map((t) => t.message)).toEqual([])
  })
})

describe('command behaviour', () => {
  it('runs the active tab and toggles output modes / queries', async () => {
    const tabs = useTabsStore()
    await executeCommand('run')
    expect(fake.callsTo('run:start')).toHaveLength(1)
    await executeCommand('toggleCliMode')
    expect(tabs.activeTab?.outputMode).toBe('cli')
    await executeCommand('outputDetail')
    expect(tabs.activeTab?.outputMode).toBe('detail')
    await executeCommand('toggleQueries')
    expect(tabs.activeTab?.showQueries).toBe(true)
  })

  it('toggles modals and closes the top modal on closeTab', async () => {
    const ui = useUiStore()
    const tabs = useTabsStore()
    const count = tabs.tabs.length
    await executeCommand('showHistory')
    expect(ui.modal).toBe('history')
    await executeCommand('closeTab')
    expect(ui.modal).toBeNull()
    expect(tabs.tabs).toHaveLength(count)
    await executeCommand('commandPalette')
    expect(ui.modal).toBe('palette')
  })

  it('toggles fullscreen through the window, which also knows native fullscreen', async () => {
    await executeCommand('toggleFullscreen')
    expect(fake.callsTo('window:toggleFullscreen')).toHaveLength(1)
    expect(useUiStore().toasts.filter((t) => t.level === 'error')).toEqual([])
  })

  it('renames and closes only what the tab strip allows', async () => {
    const ui = useUiStore()
    const tabs = useTabsStore()
    const enabled = (id: string): boolean | undefined => commandList().find((c) => c.id === id)?.enabled
    expect(enabled('renameTab')).toBe(true)
    await executeCommand('renameTab')
    expect(ui.renamingTabId).toBe(tabs.activeTabId)
    ui.startRename(null)
    // Only Get started is left: no rename (“> Rename Tab” in Open Anything) and nothing to close.
    await tabs.closeTab(tabs.activeTabId, { force: true })
    expect(tabs.activeTab?.kind).toBe('welcome')
    expect(enabled('renameTab')).toBe(false)
    expect(enabled('closeTab')).toBe(false)
    await executeCommand('renameTab')
    expect(ui.renamingTabId).toBeNull()
  })

  it('zooms the editor and output fonts', async () => {
    const settings = useSettingsStore()
    await executeCommand('zoomIn')
    expect(settings.settings.editorFontSize).toBe(17)
    expect(settings.settings.outputFontSize).toBe(15)
    await executeCommand('resetZoom')
    expect(settings.settings.editorFontSize).toBe(16)
  })

  it('adds magic comments and snippets through the editor bridge', async () => {
    const tabs = useTabsStore()
    const ui = useUiStore()
    const { editor, state } = fakeEditor('$a = 1;\n$b = 2;', { text: '$b = 2;', startLine: 2, endLine: 2 })
    state.cursorLine = 2
    cleanups.push(registerEditor(tabs.activeTabId!, editor))
    await executeCommand('addMagicComment')
    expect(state.code).toBe('$a = 1;\n$b = 2; //?')
    await executeCommand('addSelectionToSnippets')
    expect(ui.modal).toBe('snippetSave')
    expect(ui.modalProps).toMatchObject({ code: '$b = 2;' })
  })

  it('handles renderer-only shortcuts from the keyboard', async () => {
    const tabs = useTabsStore()
    const settings = useSettingsStore()
    const { editor, state } = fakeEditor('1;')
    cleanups.push(registerEditor(tabs.activeTabId!, editor))
    const escape = keyEvent('Escape')
    expect(handleKeydown(escape)).toBe(true)
    expect(escape.defaultPrevented).toBe(true)
    expect(state.focused).toBe(1)

    // Menu commands are left to the native menu.
    expect(handleKeydown(keyEvent('CmdOrCtrl+R'))).toBe(false)

    await settings.update({ autoHideOutput: true })
    handleKeydown(keyEvent('Escape'))
    await Promise.resolve()
    expect(settings.settings.showOutput).toBe(false)
  })

  it('ignores plain keys while a modal is open', () => {
    const ui = useUiStore()
    void ui.openModal('history', {})
    expect(handleKeydown(keyEvent('Escape'))).toBe(false)
  })
})
