import { DEFAULT_SETTINGS } from '@shared/defaults'
import { COMMANDS, type CommandId } from '@shared/ipc'
import { COMMAND_META, type CommandMeta } from '@shared/shortcuts'
import { api } from '../api'
import { appendMagicComment, getEditor } from '../editorBridge'
import { useConnectionsStore } from '../stores/connections'
import { useSettingsStore } from '../stores/settings'
import { useTabsStore } from '../stores/tabs'
import { useUiStore } from '../stores/ui'
import { formatAccelerator, matchesAccelerator } from '../utils/accelerator'
import { resultToText } from '../utils/dumpText'
import { platform } from '../utils/platform'

/**
 * Renderer implementation of every CommandId. Commands arrive from the native menu ('menu:command'), from the
 * renderer keyboard handler (commands with `menu: false`, or every command when running without Electron),
 * from the command palette and from UI buttons — always through `executeCommand()`.
 */

export interface CommandInfo extends CommandMeta {
  id: CommandId
  /** Effective accelerator (user override or default); '' = none. */
  shortcut: string
  /** Display form: "⇧⌘P" / "Ctrl+Shift+P"; '' = none. */
  shortcutLabel: string
  /** Whether the command can run right now (e.g. Stop needs a running script). */
  enabled: boolean
}

type Handler = () => void | Promise<unknown>

const ZOOM_MIN = 8
const ZOOM_MAX = 40

function stores() {
  return {
    ui: useUiStore(),
    tabs: useTabsStore(),
    settings: useSettingsStore(),
    connections: useConnectionsStore()
  }
}

function activeCodeTab() {
  const tab = useTabsStore().activeTab
  return tab && tab.kind === 'code' ? tab : null
}

/** Code of the active tab (from the editor when mounted). */
function activeCode(): string {
  const tab = activeCodeTab()
  if (!tab) return ''
  return getEditor(tab.id)?.getCode() ?? tab.code
}

function requireCodeTab(action: string) {
  const tab = activeCodeTab()
  if (!tab) useUiStore().toast({ message: `Open a code tab to ${action}.`, key: 'needs-code-tab' })
  return tab
}

async function zoom(delta: number | null): Promise<void> {
  const settings = useSettingsStore()
  const s = settings.settings
  if (delta === null) {
    await settings.update({ editorFontSize: DEFAULT_SETTINGS.editorFontSize, outputFontSize: DEFAULT_SETTINGS.outputFontSize })
    return
  }
  const clamp = (n: number, max: number): number => Math.min(max, Math.max(ZOOM_MIN, n))
  await settings.update({
    editorFontSize: clamp(s.editorFontSize + delta, ZOOM_MAX),
    outputFontSize: clamp(s.outputFontSize + delta, 32)
  })
}

/**
 * The window owns fullscreen: native fullscreen (green button, Window menu, ⌃⌘F) is invisible to the page's
 * Fullscreen API, so the main process toggles it. Only a page-level (HTML API) fullscreen is left from here.
 */
async function toggleFullscreen(): Promise<void> {
  try {
    if (typeof document !== 'undefined' && document.fullscreenElement) await document.exitFullscreen()
    else await api.invoke('window:toggleFullscreen')
  } catch (err) {
    useUiStore().error(err, 'Fullscreen is not available')
  }
}

const handlers: Record<CommandId, Handler> = {
  // Run --------------------------------------------------------------------------------------------------------
  run: () => useTabsStore().run(),
  runSelection: () => useTabsStore().run({ selectionOnly: true }),
  cancelRun: () => useTabsStore().cancel(),
  toggleAutoRun: async () => {
    const { settings, ui } = stores()
    const on = await settings.toggle('autoRun')
    ui.toast({
      level: on ? 'success' : 'info',
      key: 'auto-run',
      message: on ? 'Auto evaluate is on — code runs while you type.' : 'Auto evaluate is off.'
    })
  },
  toggleDebugging: async () => {
    const { ui, connections } = stores()
    const tab = requireCodeTab('toggle debugging')
    if (!tab) return
    try {
      const on = await connections.toggleDebug(tab.connectionId)
      ui.toast({
        level: on ? 'success' : 'info',
        key: 'debugging',
        title: on ? 'Debugging enabled' : 'Debugging disabled',
        message: on
          ? 'Runs start an Xdebug session — set breakpoints in your IDE and listen for connections.'
          : 'Code runs without Xdebug again.'
      })
    } catch (err) {
      ui.error(err, 'Could not toggle debugging')
    }
  },
  toggleQueries: () => {
    const { tabs, ui } = stores()
    const tab = requireCodeTab('inspect SQL queries')
    if (!tab) return
    const on = tabs.toggleQueries(tab.id)
    ui.toast({ key: 'queries', message: on ? 'SQL query inspection is on for this tab.' : 'SQL query inspection is off.' , timeout: 3000 })
  },

  // Tabs -------------------------------------------------------------------------------------------------------
  newTab: () => {
    useTabsStore().newTab()
  },
  closeTab: () => {
    const { ui, tabs } = stores()
    // ⌘W closes the top-most modal first, like a window would.
    if (ui.anyModalOpen) {
      ui.closeModal()
      return
    }
    return tabs.closeTab()
  },
  duplicateTab: () => {
    useTabsStore().duplicateTab()
  },
  reopenClosedTab: () => {
    const { tabs, ui } = stores()
    if (!tabs.reopenClosedTab()) ui.toast({ message: 'There are no closed tabs to reopen.', key: 'reopen', timeout: 3000 })
  },
  nextTab: () => useTabsStore().nextTab(),
  previousTab: () => useTabsStore().previousTab(),
  renameTab: () => {
    // Only code tabs have an editable title (like the tab's double-click and context menu).
    const tab = activeCodeTab()
    if (tab) useUiStore().startRename(tab.id)
  },
  showWelcome: () => {
    useTabsStore().openWelcome()
  },

  // Files / projects -------------------------------------------------------------------------------------------
  openFolder: async () => {
    const { connections, tabs } = stores()
    const conn = await connections.pickDirectory()
    if (conn) tabs.openProject(conn)
  },
  openFile: () => useTabsStore().openFile(),
  saveFile: async () => {
    if (requireCodeTab('save')) await useTabsStore().saveFile()
  },
  saveFileAs: async () => {
    if (requireCodeTab('save')) await useTabsStore().saveFile(undefined, { as: true })
  },
  saveOutput: async () => {
    const { tabs, ui } = stores()
    const result = tabs.activeResult
    if (!result) {
      ui.toast({ message: 'Run some code first — there is no output to save yet.', key: 'no-output' })
      return
    }
    try {
      const path = await api.invoke('file:save', resultToText(result), undefined, 'output.txt')
      if (path) ui.toast({ level: 'success', message: `Output saved to ${path}` })
    } catch (err) {
      ui.error(err, 'Could not save the output')
    }
  },
  watchFile: async () => {
    if (requireCodeTab('watch a file')) await useTabsStore().toggleWatch()
  },
  openSandbox: () => {
    useTabsStore().openSandbox()
  },
  openProjectInEditor: async () => {
    const { tabs, ui } = stores()
    const tab = tabs.activeTab
    try {
      await api.invoke('shell:openProjectInEditor', tab?.kind === 'code' ? tab.connectionId : null)
    } catch (err) {
      ui.error(err, 'Could not open the project')
    }
  },

  // Windows & panels -------------------------------------------------------------------------------------------
  commandPalette: () => useUiStore().toggleModal('palette', {}),
  phpSettings: () => {
    const { ui } = stores()
    void ui.openModal('php', { connectionId: activeCodeTab()?.connectionId ?? null })
  },
  showHistory: () => useUiStore().toggleModal('history', {}),
  showSnippets: () => useUiStore().toggleModal('snippets', { connectionId: activeCodeTab()?.connectionId ?? null }),
  showLogs: () => useUiStore().toggleModal('logs', { connectionId: activeCodeTab()?.connectionId ?? null }),
  showPanels: () => {
    void useUiStore().openModal('panels', { connectionId: activeCodeTab()?.connectionId ?? null })
  },
  openSettings: () => useUiStore().toggleModal('settings', {}),
  showWrapped: () => {
    void useUiStore().openModal('wrapped', {})
  },

  // Layout -----------------------------------------------------------------------------------------------------
  toggleLayout: () => useUiStore().toggleLayout(),
  toggleOutput: () => useUiStore().toggleOutput(),
  toggleToolbar: () => useUiStore().toggleSidebar(),
  toggleSidebar: () => useUiStore().toggleSidebar(),
  zenMode: () => {
    const ui = useUiStore()
    const on = ui.toggleZen()
    const label = formatAccelerator(useSettingsStore().accelerator('zenMode'), platform)
    if (on) ui.toast({ key: 'zen', timeout: 4000, message: `Zen mode${label ? ` — press ${label} to leave it` : ''}. Use Open Anything for everything else.` })
  },
  toggleFullscreen,
  toggleAlwaysOnTop: async () => {
    const { settings, ui } = stores()
    const on = await settings.toggle('alwaysOnTop')
    ui.toast({ key: 'always-on-top', timeout: 3000, message: on ? 'Tinkerbox stays on top of other windows.' : 'Always on top is off.' })
  },
  zoomIn: () => zoom(1),
  zoomOut: () => zoom(-1),
  resetZoom: () => zoom(null),

  // Output -----------------------------------------------------------------------------------------------------
  outputDetail: () => useTabsStore().setOutputMode(null, 'detail'),
  outputCli: () => useTabsStore().setOutputMode(null, 'cli'),
  toggleCliMode: () => {
    const tabs = useTabsStore()
    const tab = tabs.activeTab
    if (tab) tabs.setOutputMode(tab.id, tab.outputMode === 'cli' ? 'detail' : 'cli')
  },
  clearOutput: () => useTabsStore().clearOutput(),
  copyResult: async () => {
    const { tabs, ui } = stores()
    const result = tabs.activeResult
    if (!result) {
      ui.toast({ message: 'Run some code first — there is no result to copy yet.', key: 'no-output' })
      return
    }
    try {
      await api.copy(resultToText(result))
      ui.toast({ level: 'success', message: 'Result copied to the clipboard.', key: 'copied', timeout: 2500 })
    } catch (err) {
      ui.error(err, 'Could not copy the result')
    }
  },

  // Editor -----------------------------------------------------------------------------------------------------
  prettify: async () => {
    const { ui } = stores()
    const tab = requireCodeTab('prettify code')
    if (!tab) return
    const editor = getEditor(tab.id)
    if (!editor?.prettify) {
      ui.toast({ message: 'Prettify is not available in this editor.', key: 'prettify' })
      return
    }
    try {
      await editor.prettify()
    } catch (err) {
      ui.error(err, 'Could not prettify the code')
    }
  },
  addMagicComment: () => {
    const tab = requireCodeTab('add a magic comment')
    const editor = tab ? getEditor(tab.id) : null
    if (editor) appendMagicComment(editor)
  },
  addToSnippets: () => {
    const tab = requireCodeTab('save a snippet')
    if (!tab) return
    void useUiStore().openModal('snippetSave', { code: activeCode(), connectionId: tab.connectionId })
  },
  addSelectionToSnippets: () => {
    const { ui } = stores()
    const tab = requireCodeTab('save a snippet')
    if (!tab) return
    const selection = getEditor(tab.id)?.getSelection()
    if (!selection || selection.text.trim() === '') {
      ui.toast({ message: 'Select some code first.', key: 'no-selection', timeout: 3000 })
      return
    }
    void ui.openModal('snippetSave', { code: selection.text, connectionId: tab.connectionId })
  },
  focusEditor: () => {
    const { settings, ui } = stores()
    if (ui.zen) {
      ui.setZen(false)
      return
    }
    if (settings.settings.autoHideOutput && settings.settings.showOutput) void settings.set('showOutput', false)
    const tab = activeCodeTab()
    if (tab) getEditor(tab.id)?.focus()
  },
  shareGist: () => {
    const tab = requireCodeTab('share code')
    if (!tab) return
    void useUiStore().openModal('share', { code: activeCode(), connectionId: tab.connectionId })
  }
}

/** Whether a command can run right now. */
export function isCommandEnabled(id: CommandId): boolean {
  const tabs = useTabsStore()
  const tab = tabs.activeTab
  const isCode = tab?.kind === 'code'
  switch (id) {
    case 'cancelRun':
      return isCode && tabs.isRunning(tab?.id)
    case 'run':
    case 'runSelection':
    case 'toggleQueries':
    case 'toggleDebugging':
    case 'saveFile':
    case 'saveFileAs':
    case 'watchFile':
    case 'prettify':
    case 'addMagicComment':
    case 'addToSnippets':
    case 'addSelectionToSnippets':
    case 'shareGist':
    case 'renameTab':
      return isCode
    case 'closeTab':
      return tabs.canClose(tab?.id)
    case 'saveOutput':
    case 'copyResult':
    case 'clearOutput':
      return isCode && !!tabs.activeResult
    case 'reopenClosedTab':
      return tabs.closedTabs.length > 0
    default:
      return true
  }
}

/** Run a command. Errors are reported as toasts; never rejects. */
export async function executeCommand(id: CommandId): Promise<void> {
  const handler = handlers[id]
  if (!handler) {
    console.warn(`Unknown command: ${String(id)}`)
    return
  }
  try {
    await handler()
  } catch (err) {
    console.error(`Command ${id} failed`, err)
    useUiStore().error(err, COMMAND_META[id]?.title ?? id)
  }
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && (COMMANDS as readonly string[]).includes(value)
}

/** Effective accelerator of a command (honors settings.shortcuts). */
export function commandShortcut(id: CommandId): string {
  return useSettingsStore().accelerator(id)
}

/** Display label of a command's shortcut ("⇧⌘P" / "Ctrl+Shift+P"); '' when none. */
export function commandShortcutLabel(id: CommandId): string {
  return formatAccelerator(commandShortcut(id), platform)
}

/** Every command with its metadata and effective shortcut (command palette, Shortcuts settings). */
export function commandList(): CommandInfo[] {
  return COMMANDS.map((id) => {
    const shortcut = commandShortcut(id)
    return {
      ...COMMAND_META[id],
      id,
      shortcut,
      shortcutLabel: formatAccelerator(shortcut, platform),
      enabled: isCommandEnabled(id)
    }
  })
}

/** Commands handled by the renderer's keyboard listener (all of them when there is no native menu). */
function keyboardCommands(): CommandId[] {
  return api.isMock ? [...COMMANDS] : COMMANDS.filter((id) => COMMAND_META[id].menu === false)
}

function isTextField(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (target.closest('[data-editor], .monaco-editor')) return false
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
}

/** Keyboard handler for renderer-only shortcuts. Returns true when it handled the event. */
export function handleKeydown(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false
  const ui = useUiStore()
  const settings = useSettingsStore()
  for (const id of keyboardCommands()) {
    const accel = settings.accelerator(id)
    if (!accel || !matchesAccelerator(event, accel, platform)) continue
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey
    // Plain keys (Escape …) never fire while a dialog / menu is open or while typing in a form field.
    if (plain && (ui.anyModalOpen || ui.contextMenu || ui.popover || isTextField(event.target))) return false
    // While a modal is open only a few global commands go through.
    if (ui.anyModalOpen && !['closeTab', 'commandPalette', 'openSettings', 'showHistory', 'showSnippets', 'showLogs', 'zenMode', 'run'].includes(id)) {
      return false
    }
    event.preventDefault()
    event.stopPropagation()
    void executeCommand(id)
    return true
  }
  return false
}

let installed: (() => void) | null = null

/** Subscribe to 'menu:command' and install the keyboard listener. Returns the uninstall function. */
export function installCommands(): () => void {
  installed?.()
  const offMenu = api.on('menu:command', ({ command }) => {
    if (isCommandId(command)) void executeCommand(command)
  })
  const onKeydown = (event: KeyboardEvent): void => {
    handleKeydown(event)
  }
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown)
  installed = () => {
    offMenu()
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown)
    installed = null
  }
  return installed
}
