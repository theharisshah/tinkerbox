import type { MenuItemConstructorOptions } from 'electron'
import type { CommandId } from '../shared/ipc'
import { acceleratorFor, COMMAND_META } from '../shared/shortcuts'

/**
 * Native application menu, built from COMMAND_META + acceleratorFor() so it always matches the Shortcuts
 * settings. This module is pure (only Electron *types*): index.ts turns the template into a Menu.
 *
 * Notes:
 * - There is deliberately no reload / forceReload role: CmdOrCtrl+R runs code.
 * - DevTools live under Help with Alt+CmdOrCtrl+I so they never collide with command shortcuts.
 * - Menu accelerators only fire for key events the page did not handle (preventDefault) itself.
 */

export interface MenuActions {
  /** Forward a renderer command ('menu:command'). */
  command(id: CommandId): void
  openRecent(path: string): void
  clearRecent(): void
  installCli(): void
  openThemesFolder(): void
  openDataFolder(): void
}

export interface MenuOptions {
  platform: NodeJS.Platform
  shortcuts: Partial<Record<string, string>>
  appName: string
  recentFolders: Array<{ path: string; name: string }>
  actions: MenuActions
}

export const DEVTOOLS_ACCELERATOR = 'Alt+CmdOrCtrl+I'

const MODIFIERS = new Set(
  ['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta']
)
/** Modifiers that make an accelerator safe for a menu (Shift alone would swallow typed characters). */
const STRONG_MODIFIERS = new Set(['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'super', 'meta'])
const NAMED_KEYS = new Set(
  [
    'plus', 'space', 'tab', 'capslock', 'numlock', 'scrolllock', 'backspace', 'delete', 'insert', 'return', 'enter',
    'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'escape', 'esc', 'volumeup', 'volumedown',
    'volumemute', 'medianexttrack', 'mediaprevioustrack', 'mediastop', 'mediaplaypause', 'printscreen',
    'numdec', 'numadd', 'numsub', 'nummult', 'numdiv'
  ]
)
const PUNCTUATION = new Set([...')!@#$%^&*(:;+=<,_->.?/~`{]|[}"\'\\'])

function isKey(part: string): boolean {
  const lower = part.toLowerCase()
  if (/^[a-z0-9]$/i.test(part)) return true
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return true
  if (/^num[0-9]$/.test(lower)) return true
  if (part.length === 1 && PUNCTUATION.has(part)) return true
  return NAMED_KEYS.has(lower)
}

/** Parse an Electron accelerator; null when it is not valid. */
function parseAccelerator(accelerator: string): { modifiers: string[]; key: string } | null {
  if (typeof accelerator !== 'string' || accelerator === '' || accelerator.length > 100) return null
  // "CmdOrCtrl++" is not valid Electron syntax (use "Plus"), but a trailing "+" key is handled gracefully.
  const parts = accelerator.endsWith('++') ? [...accelerator.slice(0, -2).split('+'), '+'] : accelerator.split('+')
  if (parts.some((p) => p === '')) return null
  const key = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1).map((m) => m.toLowerCase())
  if (!isKey(key)) return null
  if (modifiers.some((m) => !MODIFIERS.has(m))) return null
  if (new Set(modifiers).size !== modifiers.length) return null
  return { modifiers, key }
}

export function isValidAccelerator(accelerator: string): boolean {
  return parseAccelerator(accelerator) !== null
}

/**
 * Whether an accelerator may be bound in the native menu: valid, and either uses a non-Shift modifier or is a
 * function key (a plain letter / Escape in the menu would steal keys from the editor).
 */
export function isMenuSafeAccelerator(accelerator: string): boolean {
  const parsed = parseAccelerator(accelerator)
  if (!parsed) return false
  if (parsed.modifiers.some((m) => STRONG_MODIFIERS.has(m))) return true
  return /^f([1-9]|1[0-9]|2[0-4])$/i.test(parsed.key)
}

/** Menu item id used for command items (`command:<id>`). */
export function commandItemId(id: CommandId): string {
  return `command:${id}`
}

export function buildMenuTemplate(opts: MenuOptions): MenuItemConstructorOptions[] {
  const isMac = opts.platform === 'darwin'
  const { actions } = opts
  const sep: MenuItemConstructorOptions = { type: 'separator' }

  const cmd = (id: CommandId, label?: string): MenuItemConstructorOptions => {
    const accelerator = acceleratorFor(id, opts.platform, opts.shortcuts)
    const item: MenuItemConstructorOptions = {
      id: commandItemId(id),
      label: label ?? COMMAND_META[id].title,
      click: () => actions.command(id)
    }
    if (accelerator && isMenuSafeAccelerator(accelerator)) item.accelerator = accelerator
    return item
  }

  const recentItems: MenuItemConstructorOptions[] = opts.recentFolders.map((folder) => ({
    label: folder.name === folder.path ? folder.path : `${folder.name} — ${folder.path}`,
    click: () => actions.openRecent(folder.path)
  }))
  const openRecent: MenuItemConstructorOptions = {
    id: 'openRecent',
    label: 'Open Recent',
    submenu: [
      ...(recentItems.length ? recentItems : [{ label: 'No Recent Folders', enabled: false }]),
      sep,
      { id: 'clearRecent', label: 'Clear Recent Folders', enabled: recentItems.length > 0, click: () => actions.clearRecent() }
    ]
  }

  const appMenu: MenuItemConstructorOptions = {
    label: opts.appName,
    submenu: [
      { role: 'about', label: `About ${opts.appName}` },
      sep,
      cmd('openSettings'),
      cmd('showWrapped'),
      sep,
      { role: 'services' },
      sep,
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      sep,
      { role: 'quit' }
    ]
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      cmd('newTab'),
      cmd('duplicateTab'),
      cmd('reopenClosedTab'),
      sep,
      cmd('openFolder'),
      openRecent,
      cmd('openSandbox'),
      cmd('openFile'),
      sep,
      cmd('saveFile'),
      cmd('saveFileAs'),
      cmd('saveOutput'),
      cmd('watchFile'),
      sep,
      cmd('openProjectInEditor'),
      cmd('shareGist'),
      sep,
      cmd('closeTab'),
      ...(isMac ? [] : [sep, cmd('openSettings'), sep, { role: 'quit', label: 'Exit' } as MenuItemConstructorOptions])
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions] : []),
      { role: 'delete' },
      { role: 'selectAll' },
      sep,
      cmd('prettify'),
      cmd('addToSnippets'),
      sep,
      cmd('commandPalette')
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      cmd('toggleSidebar'),
      cmd('toggleToolbar'),
      cmd('toggleOutput'),
      cmd('toggleLayout'),
      cmd('zenMode'),
      sep,
      cmd('outputDetail'),
      cmd('outputCli'),
      cmd('toggleCliMode'),
      cmd('copyResult'),
      sep,
      cmd('zoomIn'),
      cmd('zoomOut'),
      cmd('resetZoom'),
      sep,
      cmd('toggleAlwaysOnTop'),
      cmd('toggleFullscreen')
    ]
  }

  const runMenu: MenuItemConstructorOptions = {
    label: 'Run',
    submenu: [
      cmd('run'),
      cmd('runSelection'),
      cmd('cancelRun'),
      sep,
      cmd('toggleAutoRun'),
      cmd('toggleQueries'),
      cmd('toggleDebugging'),
      sep,
      cmd('phpSettings'),
      cmd('showPanels')
    ]
  }

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    role: 'window',
    submenu: [
      { role: 'minimize' },
      ...(isMac ? [{ role: 'zoom' } as MenuItemConstructorOptions] : []),
      sep,
      cmd('nextTab'),
      cmd('previousTab'),
      sep,
      cmd('showHistory'),
      cmd('showSnippets'),
      cmd('showLogs'),
      ...(isMac ? [sep, { role: 'front' } as MenuItemConstructorOptions] : [])
    ]
  }

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    role: 'help',
    submenu: [
      cmd('showWelcome', 'Get Started'),
      ...(isMac ? [] : [cmd('showWrapped')]),
      sep,
      { id: 'installCli', label: 'Install Command Line Tool…', click: () => actions.installCli() },
      { id: 'openThemesFolder', label: 'Open Custom Themes Folder', click: () => actions.openThemesFolder() },
      { id: 'openDataFolder', label: 'Open Data Folder', click: () => actions.openDataFolder() },
      sep,
      { role: 'toggleDevTools', accelerator: DEVTOOLS_ACCELERATOR },
      ...(isMac ? [] : [sep, { role: 'about', label: `About ${opts.appName}` } as MenuItemConstructorOptions])
    ]
  }

  return [...(isMac ? [appMenu] : []), fileMenu, editMenu, viewMenu, runMenu, windowMenu, helpMenu]
}

/** macOS dock menu: recent folders + quick actions. */
export function buildDockMenuTemplate(opts: Pick<MenuOptions, 'recentFolders' | 'actions'>): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = opts.recentFolders.slice(0, 10).map((folder) => ({
    label: folder.name,
    toolTip: folder.path,
    click: () => opts.actions.openRecent(folder.path)
  }))
  if (items.length) items.push({ type: 'separator' })
  items.push(
    { label: COMMAND_META.newTab.title, click: () => opts.actions.command('newTab') },
    { label: COMMAND_META.openFolder.title, click: () => opts.actions.command('openFolder') }
  )
  return items
}

/** Every command id bound in a template (for tests / diagnostics). */
export function collectCommandItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  const walk = (items: MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      if (typeof item.id === 'string' && item.id.startsWith('command:')) out.push(item)
      if (Array.isArray(item.submenu)) walk(item.submenu)
    }
  }
  walk(template)
  return out
}
