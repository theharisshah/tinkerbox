import { BrowserWindow, Menu, screen, session, shell, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Logger } from './store/common'
import { JsonStore } from './store/jsonStore'
import {
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  normalizeWindowState,
  restoreBounds,
  type WindowState
} from './store/windowState'
import type { ChromeColors } from './themes'

/** Height of the renderer's custom title bar; the Windows/Linux window controls overlay uses the same height. */
export const TITLE_BAR_HEIGHT = 40

/** URLs the app itself is served from (dev server or the built renderer file). */
export interface AppUrls {
  /** Dev server URL (ELECTRON_RENDERER_URL) or null when loading the built file. */
  devUrl: string | null
  /** Absolute path of out/renderer/index.html. */
  rendererFile: string
}

export function appUrls(mainDir: string): AppUrls {
  return {
    devUrl: process.env['ELECTRON_RENDERER_URL'] || null,
    rendererFile: join(mainDir, '../renderer/index.html')
  }
}

/**
 * True when `url` belongs to the app (same dev-server origin, or the renderer index file). Never throws: anything
 * that cannot be parsed or decoded (e.g. a stray `%` in a file: URL) is not an app URL, so navigation guards and the
 * IPC sender check fail closed.
 */
export function isAppUrl(url: string, urls: AppUrls): boolean {
  try {
    const parsed = new URL(url)
    if (urls.devUrl) return parsed.origin === new URL(urls.devUrl).origin
    if (parsed.protocol !== 'file:') return false
    const expected = new URL(pathToFileURL(urls.rendererFile).href)
    return decodeURIComponent(parsed.pathname) === decodeURIComponent(expected.pathname)
  } catch {
    return false
  }
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Open a URL in the default browser / mail client; other protocols are refused. */
export async function openExternalSafely(url: string, logger: Logger): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    logger.warn('Refusing to open invalid URL', url)
    return false
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    logger.warn('Refusing to open URL with protocol', parsed.protocol)
    return false
  }
  await shell.openExternal(parsed.href)
  return true
}

/** Session-wide hardening: deny permission requests the app does not need. */
export function installSessionGuards(): void {
  const allowed = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

export interface MainWindowOptions {
  preloadPath: string
  urls: AppUrls
  stateFile: string
  chrome: ChromeColors
  alwaysOnTop: boolean
  logger: Logger
}

/**
 * Create the main window: hidden-inset title bar on macOS, hidden title bar + native window-controls overlay on
 * Windows/Linux (the renderer draws the rest of the title bar), persisted bounds, hardened navigation.
 */
export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const stateStore = new JsonStore<WindowState>({
    file: opts.stateFile,
    label: 'Window state',
    defaults: () => ({ ...DEFAULT_WINDOW_STATE }),
    normalize: normalizeWindowState,
    debounceMs: 500,
    logger: opts.logger
  })
  const saved = stateStore.value
  const primary = screen.getPrimaryDisplay().workArea
  const bounds = restoreBounds(
    saved,
    screen.getAllDisplays().map((d) => d.workArea),
    primary
  )
  const isMac = process.platform === 'darwin'

  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: 'Tinkerbox',
    backgroundColor: opts.chrome.background,
    alwaysOnTop: opts.alwaysOnTop,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: opts.chrome.background,
            symbolColor: opts.chrome.foreground,
            height: TITLE_BAR_HEIGHT
          },
          autoHideMenuBar: true
        }),
    webPreferences: {
      preload: opts.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: false
    }
  })

  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize()
    win.show()
  })

  // Persist the normal (un-maximized) bounds.
  const persist = (): void => {
    if (win.isDestroyed()) return
    const normal = win.getNormalBounds()
    stateStore.set({ ...normal, maximized: win.isMaximized() })
  }
  win.on('resize', persist)
  win.on('move', persist)
  win.on('maximize', persist)
  win.on('unmaximize', persist)
  win.on('close', () => {
    persist()
    stateStore.flushSync()
  })

  hardenWebContents(win, opts.urls, opts.logger)

  if (opts.urls.devUrl) void win.loadURL(opts.urls.devUrl)
  else void win.loadFile(opts.urls.rendererFile)

  return win
}

function hardenWebContents(win: BrowserWindow, urls: AppUrls, logger: Logger): void {
  const wc = win.webContents

  // Links never navigate the app window; external links open in the browser.
  wc.on('will-navigate', (event, url) => {
    if (isAppUrl(url, urls)) return
    event.preventDefault()
    void openExternalSafely(url, logger).catch((err) => logger.error('openExternal failed', err))
  })
  wc.on('will-redirect', (event, url) => {
    if (!isAppUrl(url, urls)) event.preventDefault()
  })
  wc.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url, logger).catch((err) => logger.error('openExternal failed', err))
    return { action: 'deny' }
  })
  wc.on('will-attach-webview', (event) => event.preventDefault())

  // The editor zooms its own font; pinch-zooming the whole UI only gets in the way.
  void wc.setVisualZoomLevelLimits(1, 1).catch((err) => logger.warn('setVisualZoomLevelLimits failed', err))

  // Basic native context menu for text fields and selections outside Monaco (Monaco handles its own menu and
  // prevents the default one).
  wc.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll }
      )
    } else if (params.selectionText.trim() !== '') {
      items.push({ role: 'copy' })
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })

  // Reload after a renderer crash so the user is not left with a blank window — but give up when it keeps
  // crashing (a crash loop would otherwise spin forever).
  const crashes: number[] = []
  wc.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process gone:', details.reason, details.exitCode)
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    const now = Date.now()
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift()
    crashes.push(now)
    if (crashes.length > 3) {
      logger.error('Renderer keeps crashing; not reloading again')
      return
    }
    if (urls.devUrl) void win.loadURL(urls.devUrl)
    else void win.loadFile(urls.rendererFile)
  })
}

/** Apply theme chrome colors (window background + Windows/Linux controls overlay). */
export function applyChromeColors(win: BrowserWindow, chrome: ChromeColors): void {
  if (win.isDestroyed()) return
  win.setBackgroundColor(chrome.background)
  if (process.platform !== 'darwin') {
    win.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.foreground, height: TITLE_BAR_HEIGHT })
  }
}
