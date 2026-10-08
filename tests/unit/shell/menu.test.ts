import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { COMMANDS, type CommandId } from '../../../src/shared/ipc'
import { acceleratorFor, COMMAND_META } from '../../../src/shared/shortcuts'
import {
  buildDockMenuTemplate,
  buildMenuTemplate,
  collectCommandItems,
  commandItemId,
  DEVTOOLS_ACCELERATOR,
  isMenuSafeAccelerator,
  isValidAccelerator,
  type MenuActions
} from '../../../src/main/menu'

function actions(log: string[] = []): MenuActions {
  return {
    command: (id) => log.push(`command:${id}`),
    openRecent: (p) => log.push(`recent:${p}`),
    clearRecent: () => log.push('clearRecent'),
    installCli: () => log.push('installCli'),
    openThemesFolder: () => log.push('themes'),
    openDataFolder: () => log.push('data')
  }
}

function build(platform: NodeJS.Platform, shortcuts: Partial<Record<string, string>> = {}, log: string[] = []) {
  return buildMenuTemplate({
    platform,
    shortcuts,
    appName: 'Tinkerbox',
    recentFolders: [
      { path: '/p/app', name: 'app' },
      { path: '/p/api', name: 'api' }
    ],
    actions: actions(log)
  })
}

function allItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  const walk = (items: MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      out.push(item)
      if (Array.isArray(item.submenu)) walk(item.submenu)
    }
  }
  walk(template)
  return out
}

const MENU_COMMANDS = COMMANDS.filter((id) => COMMAND_META[id].menu)
const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32', 'linux']

describe('native menu template', () => {
  it.each(PLATFORMS)('contains every menu command exactly once on %s and no renderer-only commands', (platform) => {
    const ids = collectCommandItems(build(platform)).map((item) => item.id)
    for (const id of MENU_COMMANDS) {
      expect(ids.filter((x) => x === commandItemId(id)), id).toHaveLength(1)
    }
    for (const id of COMMANDS.filter((c) => !COMMAND_META[c].menu)) {
      expect(ids, id).not.toContain(commandItemId(id))
    }
    expect(ids).toHaveLength(MENU_COMMANDS.length)
  })

  it.each(PLATFORMS)('uses acceleratorFor() for every command on %s', (platform) => {
    const items = collectCommandItems(build(platform))
    for (const item of items) {
      const id = String(item.id).slice('command:'.length) as CommandId
      const expected = acceleratorFor(id, platform, {})
      expect(item.accelerator ?? '', id).toBe(expected)
    }
    const history = items.find((i) => i.id === commandItemId('showHistory'))
    expect(history?.accelerator).toBe(platform === 'darwin' ? 'CmdOrCtrl+Y' : 'Ctrl+I')
  })

  it.each(PLATFORMS)('has no reload roles and binds CmdOrCtrl+R only to Run on %s', (platform) => {
    const items = allItems(build(platform))
    const roles = items.map((i) => i.role).filter(Boolean)
    expect(roles).not.toContain('reload')
    expect(roles).not.toContain('forceReload')
    const cmdR = items.filter((i) => typeof i.accelerator === 'string' && /^(CmdOrCtrl|CommandOrControl|Cmd|Ctrl)\+R$/i.test(i.accelerator))
    expect(cmdR.map((i) => i.id)).toEqual([commandItemId('run')])
    const devtools = items.find((i) => i.role === 'toggleDevTools')
    expect(devtools?.accelerator).toBe(DEVTOOLS_ACCELERATOR)
    // No other item uses the DevTools accelerator.
    expect(items.filter((i) => i.accelerator === DEVTOOLS_ACCELERATOR)).toHaveLength(1)
  })

  it('honors user overrides, drops invalid / unsafe ones and supports removing a shortcut', () => {
    const items = collectCommandItems(
      build('darwin', { run: 'CmdOrCtrl+E', prettify: '', showLogs: 'Cmd+Banana', showSnippets: 'K', saveFile: 'F5' })
    )
    const byId = (id: CommandId) => items.find((i) => i.id === commandItemId(id))
    expect(byId('run')?.accelerator).toBe('CmdOrCtrl+E')
    expect(byId('prettify')?.accelerator).toBeUndefined()
    expect(byId('showLogs')?.accelerator).toBeUndefined()
    expect(byId('showSnippets')?.accelerator).toBeUndefined()
    expect(byId('saveFile')?.accelerator).toBe('F5')
  })

  it('macOS gets the app menu with Settings / Services / Quit; Windows/Linux get Settings + Exit in File', () => {
    const mac = build('darwin')
    expect(mac.map((m) => m.label)).toEqual(['Tinkerbox', 'File', 'Edit', 'View', 'Run', 'Window', 'Help'])
    const appRoles = (mac[0].submenu as MenuItemConstructorOptions[]).map((i) => i.role).filter(Boolean)
    expect(appRoles).toEqual(expect.arrayContaining(['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']))

    const win = build('win32')
    expect(win.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Run', 'Window', 'Help'])
    const fileItems = win[0].submenu as MenuItemConstructorOptions[]
    expect(fileItems.some((i) => i.id === commandItemId('openSettings'))).toBe(true)
    expect(fileItems.some((i) => i.role === 'quit')).toBe(true)
  })

  it('Edit menu keeps the standard editing roles', () => {
    const edit = build('linux').find((m) => m.label === 'Edit')
    const roles = (edit?.submenu as MenuItemConstructorOptions[]).map((i) => i.role).filter(Boolean)
    expect(roles).toEqual(expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']))
  })

  it('clicking items forwards commands and actions', () => {
    const log: string[] = []
    const template = build('darwin', {}, log)
    const items = allItems(template)
    const click = (pred: (i: MenuItemConstructorOptions) => boolean): void => {
      const item = items.find(pred)
      ;(item?.click as unknown as () => void)()
    }
    click((i) => i.id === commandItemId('run'))
    click((i) => i.label === 'app — /p/app')
    click((i) => i.id === 'clearRecent')
    click((i) => i.id === 'installCli')
    expect(log).toEqual(['command:run', 'recent:/p/app', 'clearRecent', 'installCli'])
  })

  it('shows a disabled placeholder when there are no recent folders', () => {
    const template = buildMenuTemplate({ platform: 'linux', shortcuts: {}, appName: 'Tinkerbox', recentFolders: [], actions: actions() })
    const recent = allItems(template).find((i) => i.id === 'openRecent')
    const sub = recent?.submenu as MenuItemConstructorOptions[]
    expect(sub[0]).toMatchObject({ label: 'No Recent Folders', enabled: false })
    expect(sub.find((i) => i.id === 'clearRecent')?.enabled).toBe(false)
  })

  it('builds the macOS dock menu from recent folders', () => {
    const log: string[] = []
    const dock = buildDockMenuTemplate({ recentFolders: [{ path: '/p/app', name: 'app' }], actions: actions(log) })
    expect(dock.map((i) => i.label ?? i.type)).toEqual(['app', 'separator', 'New Tab', 'Open Local Project…'])
    ;(dock[0].click as unknown as () => void)()
    ;(dock[2].click as unknown as () => void)()
    expect(log).toEqual(['recent:/p/app', 'command:newTab'])
  })
})

describe('accelerator validation', () => {
  it('accepts Electron accelerators', () => {
    for (const acc of ['CmdOrCtrl+R', 'CmdOrCtrl+Shift+P', 'Ctrl+.', 'CmdOrCtrl+\\', 'CmdOrCtrl+=', 'CmdOrCtrl+-', 'Alt+CmdOrCtrl+I', 'F5', 'Ctrl+Tab', 'CmdOrCtrl+Ctrl+Alt+Space', 'Shift+Escape', 'CmdOrCtrl+Plus', 'num5']) {
      expect(isValidAccelerator(acc), acc).toBe(true)
    }
  })

  it('rejects malformed accelerators', () => {
    for (const acc of ['', 'Cmd+', '+R', 'Cmd+Cmd+R', 'Hyper+R', 'Cmd+Banana', 'R+Cmd', 'Ctrl++Shift']) {
      expect(isValidAccelerator(acc), acc).toBe(false)
    }
  })

  it('only allows modifier combos or function keys in menus', () => {
    expect(isMenuSafeAccelerator('CmdOrCtrl+K')).toBe(true)
    expect(isMenuSafeAccelerator('F12')).toBe(true)
    expect(isMenuSafeAccelerator('K')).toBe(false)
    expect(isMenuSafeAccelerator('Shift+K')).toBe(false)
    expect(isMenuSafeAccelerator('Escape')).toBe(false)
  })

  it('every default accelerator in COMMAND_META is valid', () => {
    for (const id of COMMANDS) {
      for (const platform of PLATFORMS) {
        const acc = acceleratorFor(id, platform)
        if (acc) expect(isValidAccelerator(acc), `${id} on ${platform}: ${acc}`).toBe(true)
      }
    }
  })
})
