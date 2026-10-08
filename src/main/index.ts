/**
 * Tinkerbox main process entry: app lifecycle, single instance, stores, IPC, windows, native menus, deep links and
 * theme plumbing. Feature logic lives in the modules this file wires together.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  safeStorage,
  shell,
  webContents,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type WebContents
} from 'electron'
import log from 'electron-log/main'
import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { CommandId, EventChannel, EventChannels } from '../shared/ipc'
import type { AppInfo, CustomTheme, Settings } from '../shared/types'
import { installCli, readCliToken, refreshInstalledCli, type CliEnvironment } from './cli'
import { extractOpenTargets, needsOpenConfirmation, parseDeepLink, PROTOCOL, type OpenTarget } from './deeplinks'
import { registerIpc } from './ipc'
import { createConnectionResolver } from './ipc/connectionResolver'
import { referencedConnectionIds } from './ipc/core'
import { sendTo, type ShellContext } from './ipc/context'
import { FileWatchers, MAX_EDITOR_FILE_BYTES, readTextFile } from './ipc/files'
import { RunService } from './ipc/runs'
import { SandboxManager } from './ipc/sandbox'
import {
  disposeExecution,
  installSandbox,
  invalidateCaches,
  isSandboxAvailable,
  loadShellPath,
  runCode,
  sandboxPathSync,
  sandboxStatus
} from './ipc/services'
import { buildDockMenuTemplate, buildMenuTemplate } from './menu'
import { resolveAppPaths, userDataOverride, type AppPaths } from './paths'
import { errorMessage, type Logger, type StoreNotice } from './store/common'
import { normalizeLocalPath, ConnectionsStore } from './store/connections'
import { HistoryStore } from './store/history'
import { SecretBox, type SecretCipher } from './store/secrets'
import { SessionStore } from './store/session'
import { SettingsStore } from './store/settings'
import { SnippetsStore } from './store/snippets'
import { StatsStore } from './store/stats'
import { chromeColorsFor, effectiveThemeId, listCustomThemes } from './themes'
import { appUrls, applyChromeColors, createMainWindow, installSessionGuards, isAppUrl } from './windows'
import type { ExecutionContext } from './execution/types'

const logger: Logger = {
  info: (...args) => log.info(...args),
  warn: (...args) => log.warn(...args),
  error: (...args) => log.error(...args)
}

/** Delay between the renderer's first session:load and delivering queued open requests (lets it restore tabs). */
const READY_FLUSH_DELAY_MS = 250
/** Fallback when the renderer never calls session:load. */
const READY_FALLBACK_MS = 4000

// Isolated profile (`--user-data-dir=<dir>` or TINKERBOX_USER_DATA_DIR): must be applied before the single-instance
// lock, which is scoped to the user-data directory.
const isolatedUserData = userDataOverride(process.argv, process.env, process.cwd())
if (isolatedUserData) app.setPath('userData', isolatedUserData)

if (!app.requestSingleInstanceLock()) {
  // Another instance owns the user data; it receives our argv through 'second-instance'.
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  log.errorHandler.startCatching({ showDialog: false })
  if (process.platform === 'win32') app.setAppUserModelId('dev.tinkerbox.app')
  // An isolated profile (tests, side-by-side runs) must not take over the OS-wide tinkerbox:// handler.
  if (!isolatedUserData) registerProtocol()

  // Start loading the login-shell PATH right away; everything that spawns processes awaits it.
  const envReady = loadShellPath().catch((err: unknown) => logger.warn('Could not load the login shell PATH:', err))

  // Open requests that arrive before the app is ready (macOS delivers open-file/open-url before 'ready').
  const early: OpenTarget[] = extractOpenTargets(process.argv, { defaultApp: !!process.defaultApp, cwd: process.cwd() })
  let handleTarget: (target: OpenTarget) => void = (target) => early.push(target)

  app.on('open-file', (event, path) => {
    event.preventDefault()
    handleTarget({ path, source: 'argv' })
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const link = parseDeepLink(url)
    if (link) handleTarget({ ...link, source: 'url' })
    else logger.warn('Ignoring unsupported deep link', url)
  })

  // Defense in depth for any web contents (the main window installs stricter handlers itself).
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })

  void app.whenReady().then(() => {
    applyDevDockIcon()
    const shellApi = startShell(envReady)
    handleTarget = (target) => void shellApi.openTarget(target)
    for (const target of early.splice(0)) void shellApi.openTarget(target)
  })
}

/**
 * Packaged builds carry the Tinkerbox icon in the app bundle. During development the app runs inside the stock
 * Electron.app, so swap the Dock icon for ours (the Dock label stays "Electron" — it comes from that bundle).
 */
function applyDevDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build/icon.png'))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

function registerProtocol(): void {
  try {
    if (process.defaultApp) {
      // Unpackaged (`electron .`): the OS must start Electron with the app directory as first argument.
      if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL)
    }
  } catch (err) {
    logger.warn('Could not register the tinkerbox:// protocol', err)
  }
}

function electronCipher(): SecretCipher {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    isWeak: () => process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text',
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipherText) => safeStorage.decryptString(Buffer.from(cipherText, 'base64'))
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

type Delivery = { [E in EventChannel]: { channel: E; payload: EventChannels[E] } }[EventChannel]

/** Everything after `app.whenReady()`. Returns the hooks bootstrap() needs for deep links. */
function startShell(envReady: Promise<void>): { openTarget(target: OpenTarget): Promise<void> } {
  const paths: AppPaths = resolveAppPaths({
    userData: app.getPath('userData'),
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    processResourcesPath: process.resourcesPath
  })
  const urls = appUrls(__dirname)

  // ---------------------------------------------------------------------------------------------------------
  // Renderer delivery: events that must not get lost before the renderer listens (notices, open requests).
  // ---------------------------------------------------------------------------------------------------------
  let mainWindow: BrowserWindow | null = null
  const readyContents = new Set<number>()
  const queue: Delivery[] = []

  const readyWindow = (): BrowserWindow | null =>
    mainWindow && !mainWindow.isDestroyed() && readyContents.has(mainWindow.webContents.id) ? mainWindow : null

  const flushQueue = (): void => {
    const win = readyWindow()
    if (!win) return
    for (const item of queue.splice(0)) sendTo(win.webContents, item.channel, item.payload as never)
  }

  const deliver = (item: Delivery, options: { focus?: boolean } = {}): void => {
    if (options.focus) focusMainWindow()
    queue.push(item)
    flushQueue()
  }

  const notice = (level: StoreNotice['level'], message: string): void => {
    ;(level === 'error' ? logger.error : level === 'warning' ? logger.warn : logger.info)('[notice]', message)
    if (queue.filter((d) => d.channel === 'app:notice').length >= 20) return
    deliver({ channel: 'app:notice', payload: { level, message } })
  }
  const onNotice = (n: StoreNotice): void => notice(n.level, n.message)

  const broadcast = <E extends EventChannel>(channel: E, payload: EventChannels[E]): void => {
    for (const win of BrowserWindow.getAllWindows()) sendTo(win.webContents, channel, payload)
  }

  // ---------------------------------------------------------------------------------------------------------
  // Stores
  // ---------------------------------------------------------------------------------------------------------
  const box = new SecretBox(electronCipher(), onNotice, logger)
  const settings = new SettingsStore(paths.files.settings, box, { onNotice, logger })
  const connections = new ConnectionsStore(paths.files.connections, { onNotice, logger })
  const snippets = new SnippetsStore(paths.files.snippets, { onNotice, logger })
  const history = new HistoryStore(paths.files.history, settings.get().historyLimit, { onNotice, logger })
  const session = new SessionStore(paths.files.session, { onNotice, logger })
  const stats = new StatsStore(paths.files.stats, { onNotice, logger })
  const stores = [settings, connections, snippets, history, session, stats]
  const flushStores = (): void => {
    for (const store of stores) store.flushSync()
  }

  // ---------------------------------------------------------------------------------------------------------
  // Execution context (E1)
  // ---------------------------------------------------------------------------------------------------------
  const sandboxCtx = { resourcesPath: paths.resources, userDataPath: paths.userData, getSettings: () => settings.get() }
  const resolveConnection = createConnectionResolver({
    connections,
    settings: () => settings.get(),
    sandbox: () => ({ installed: isSandboxAvailable(sandboxCtx), path: sandboxPathSync(sandboxCtx) })
  })
  const exec: ExecutionContext = {
    getSettings: () => settings.get(),
    resolveConnection,
    resourcesPath: paths.resources,
    userDataPath: paths.userData
  }
  const sandbox = new SandboxManager({
    status: () => sandboxStatus(exec),
    install: (onLine) => installSandbox(exec, onLine),
    locate: () => ({ installed: isSandboxAvailable(sandboxCtx), path: sandboxPathSync(sandboxCtx) }),
    envReady
  })
  const runs = new RunService({
    execute: (request, onProgress, signal) => runCode(exec, request, onProgress, signal),
    resolveConnection,
    envReady,
    connections,
    history,
    stats,
    broadcast,
    logger
  })
  const watchers = new FileWatchers({
    send: (ownerId, change) => {
      const wc = webContents.fromId(ownerId)
      if (wc) sendTo(wc, 'file:changed', change)
    },
    logger
  })

  // ---------------------------------------------------------------------------------------------------------
  // Themes / window chrome
  // ---------------------------------------------------------------------------------------------------------
  let customThemes: CustomTheme[] = []
  const currentChrome = () => chromeColorsFor(effectiveThemeId(settings.get(), nativeTheme.shouldUseDarkColors), customThemes)
  const applyChrome = (): void => {
    const chrome = currentChrome()
    for (const win of BrowserWindow.getAllWindows()) applyChromeColors(win, chrome)
  }
  void listCustomThemes(paths.themes)
    .then(({ themes }) => {
      customThemes = themes
      if (settings.get().theme.startsWith('custom:')) applyChrome()
    })
    .catch((err) => logger.warn('Could not list custom themes:', err))

  // ---------------------------------------------------------------------------------------------------------
  // Menus
  // ---------------------------------------------------------------------------------------------------------
  let menuTimer: ReturnType<typeof setTimeout> | null = null
  const cliEnvironment = (): CliEnvironment => ({
    platform: process.platform,
    homeDir: homedir(),
    userDataPath: paths.userData,
    templatePath: paths.cliTemplate,
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    env: process.env
  })

  const runCliInstall = async (): Promise<void> => {
    const result = installCli(cliEnvironment())
    const options = {
      type: result.installed ? ('info' as const) : ('warning' as const),
      message: result.installed ? 'The tinkerbox command is installed' : 'The tinkerbox command could not be installed',
      detail: result.message,
      buttons: result.manualCommand ? ['OK', 'Copy Command'] : ['OK'],
      defaultId: 0
    }
    const answer = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)
    if (answer.response === 1 && result.manualCommand) clipboard.writeText(result.manualCommand)
  }

  const menuActions = {
    command: (id: CommandId) => deliver({ channel: 'menu:command', payload: { command: id } }, { focus: true }),
    openRecent: (path: string) => void openTarget({ path, source: 'argv' }),
    clearRecent: () => {
      connections.clearRecents(referencedConnectionIds({ session, snippets }))
      recentFoldersCleared()
    },
    installCli: () => void runCliInstall().catch((err) => notice('error', `CLI install failed: ${errorMessage(err)}`)),
    openThemesFolder: () =>
      void mkdir(paths.themes, { recursive: true })
        .then(() => shell.openPath(paths.themes))
        .then((failure) => failure && notice('error', `Could not open ${paths.themes}: ${failure}`))
        .catch((err) => notice('error', `Could not open the themes folder: ${errorMessage(err)}`)),
    openDataFolder: () =>
      void shell.openPath(paths.userData).then((failure) => failure && notice('error', `Could not open ${paths.userData}: ${failure}`))
  }

  const rebuildMenus = (): void => {
    if (menuTimer) clearTimeout(menuTimer)
    menuTimer = setTimeout(() => {
      menuTimer = null
      const recentFolders = connections.recentFolders(10).map((c) => ({ path: c.path, name: c.name }))
      const template = buildMenuTemplate({
        platform: process.platform,
        shortcuts: settings.get().shortcuts,
        appName: app.getName(),
        recentFolders,
        actions: menuActions
      })
      Menu.setApplicationMenu(Menu.buildFromTemplate(template))
      app.dock?.setMenu(Menu.buildFromTemplate(buildDockMenuTemplate({ recentFolders, actions: menuActions })))
    }, 30)
  }

  const folderOpened = (path: string): void => {
    if (process.platform === 'darwin') app.addRecentDocument(path)
    rebuildMenus()
  }
  const recentFoldersCleared = (): void => {
    if (process.platform === 'darwin') app.clearRecentDocuments()
    rebuildMenus()
  }

  // ---------------------------------------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------------------------------------
  const createWindow = (): BrowserWindow => {
    const win = createMainWindow({
      preloadPath: join(__dirname, '../preload/index.js'),
      urls,
      stateFile: paths.files.windowState,
      chrome: currentChrome(),
      alwaysOnTop: settings.get().alwaysOnTop,
      logger
    })
    mainWindow = win
    const wc = win.webContents
    const id = wc.id
    let fallback: ReturnType<typeof setTimeout> | null = null
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) readyContents.delete(id)
    })
    wc.on('did-finish-load', () => {
      if (fallback) clearTimeout(fallback)
      fallback = setTimeout(() => markReady(wc), READY_FALLBACK_MS)
    })
    win.on('closed', () => {
      if (fallback) clearTimeout(fallback)
      readyContents.delete(id)
      if (mainWindow === win) mainWindow = null
    })
    return win
  }

  const markReady = (wc: WebContents): void => {
    if (wc.isDestroyed() || readyContents.has(wc.id)) return
    readyContents.add(wc.id)
    flushQueue()
  }

  const focusMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }

  // ---------------------------------------------------------------------------------------------------------
  // Opening folders / files from the OS, the CLI helper and deep links
  // ---------------------------------------------------------------------------------------------------------
  /**
   * Ask before opening something a tinkerbox:// link asked for: any web page or program can trigger such a link,
   * and opening a project folder runs its PHP code (Composer autoload, framework bootstrap, .tinkerbox drivers).
   * Nothing is read from the path before the user agreed.
   */
  async function confirmLinkTarget(path: string): Promise<boolean> {
    focusMainWindow()
    const options: MessageBoxOptions = {
      type: 'warning',
      buttons: ['Open', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: `Open “${basename(path) || path}” in Tinkerbox?`,
      detail:
        `A tinkerbox:// link asked to open:\n${path}\n\n` +
        'Opening a project folder runs its PHP code (Composer autoload, framework bootstrap and .tinkerbox drivers). ' +
        'Only continue if you started this yourself and trust the folder.'
    }
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return answer.response === 0
  }

  /** One confirmation at a time: links arriving while it is open are dropped, so a page cannot stack prompts. */
  let confirmingLink = false

  async function openTarget(request: OpenTarget): Promise<void> {
    if (needsOpenConfirmation(request, readCliToken(paths.userData))) {
      if (confirmingLink) {
        logger.warn('Deep link ignored while another one waits for confirmation:', request.path)
        focusMainWindow()
        return
      }
      confirmingLink = true
      const confirmed = await confirmLinkTarget(request.path)
        .catch((err: unknown) => {
          logger.error('Could not ask before opening a deep link', err)
          return false
        })
        .finally(() => {
          confirmingLink = false
        })
      if (!confirmed) {
        logger.info('Deep link not opened (not confirmed):', request.path)
        return
      }
    }
    const target = request.path
    const info = await stat(target).catch(() => null)
    if (!info) {
      notice('warning', `Cannot open ${target}: no such file or directory`)
      focusMainWindow()
      return
    }
    if (info.isDirectory()) {
      const path = normalizeLocalPath(target)
      connections.openLocal(path)
      folderOpened(path)
      deliver({ channel: 'app:openPath', payload: { path } }, { focus: true })
      return
    }
    if (info.isFile()) {
      try {
        const content = await readTextFile(target, MAX_EDITOR_FILE_BYTES)
        deliver({ channel: 'file:opened', payload: { path: target, content } }, { focus: true })
      } catch (err) {
        notice('error', errorMessage(err))
        focusMainWindow()
      }
    }
  }

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const targets = extractOpenTargets(argv, { defaultApp: !!process.defaultApp, cwd: workingDirectory })
    if (targets.length === 0) focusMainWindow()
    for (const t of targets) void openTarget(t)
  })

  // ---------------------------------------------------------------------------------------------------------
  // Store change side effects
  // ---------------------------------------------------------------------------------------------------------
  settings.onChange((next: Settings, prev: Settings) => {
    broadcast('settings:changed', settings.getMasked())
    if (next.alwaysOnTop !== prev.alwaysOnTop) {
      for (const win of BrowserWindow.getAllWindows()) win.setAlwaysOnTop(next.alwaysOnTop)
    }
    if (!sameJson(next.shortcuts, prev.shortcuts)) rebuildMenus()
    if (next.phpBinary !== prev.phpBinary) invalidateCaches()
    if (next.historyLimit !== prev.historyLimit) history.setLimit(next.historyLimit)
    if (
      next.theme !== prev.theme ||
      next.syncThemeWithOs !== prev.syncThemeWithOs ||
      next.darkTheme !== prev.darkTheme ||
      next.lightTheme !== prev.lightTheme
    ) {
      applyChrome()
    }
  })

  let connectionsTimer: ReturnType<typeof setTimeout> | null = null
  connections.onChange(() => {
    // Coalesce bursts (sync, run touches) into one event + one menu rebuild.
    if (connectionsTimer) clearTimeout(connectionsTimer)
    connectionsTimer = setTimeout(() => {
      connectionsTimer = null
      broadcast('connections:changed', connections.snapshot())
      rebuildMenus()
    }, 50)
  })

  nativeTheme.on('updated', () => {
    broadcast('theme:osChanged', { dark: nativeTheme.shouldUseDarkColors })
    if (settings.get().syncThemeWithOs) applyChrome()
  })

  // ---------------------------------------------------------------------------------------------------------
  // IPC
  // ---------------------------------------------------------------------------------------------------------
  const appInfo = (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userDataPath: paths.userData,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    isPackaged: app.isPackaged,
    themesPath: paths.themes,
    driversPath: paths.drivers
  })

  const ctx: ShellContext = {
    paths,
    logger,
    settings,
    connections,
    snippets,
    history,
    session,
    stats,
    exec,
    envReady,
    runs,
    sandbox,
    watchers,
    broadcast,
    notice,
    windowFor: (sender) => BrowserWindow.fromWebContents(sender),
    folderOpened,
    recentFoldersCleared,
    rendererReady: (sender) => {
      setTimeout(() => markReady(sender), READY_FLUSH_DELAY_MS)
    },
    customThemesChanged: (themes) => {
      customThemes = themes
      applyChrome()
    },
    cliEnvironment,
    appInfo
  }

  const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame
    return !!frame && isAppUrl(frame.url, urls)
  }
  registerIpc(ipcMain, ctx, isTrustedSender)

  // ---------------------------------------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------------------------------------
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    copyright: 'Open source (MIT). An independent project.'
  })
  installSessionGuards()
  rebuildMenus()
  createWindow()
  try {
    refreshInstalledCli(cliEnvironment())
  } catch (err) {
    logger.warn('Could not refresh the installed CLI helper:', err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Quit: flush stores synchronously and stop child processes / file watchers.
  app.on('before-quit', flushStores)
  app.on('will-quit', () => {
    flushStores()
    watchers.disposeAll()
    try {
      disposeExecution()
    } catch (err) {
      logger.error('disposeExecution failed', err)
    }
  })

  return { openTarget }
}
