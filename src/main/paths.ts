import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Filesystem locations used by the shell. Pure (no Electron import) so it can be unit-tested; index.ts passes in
 * the values from `app`.
 */
export interface AppPaths {
  userData: string
  /**
   * Directory holding the bundled resources: `<repo>/resources` when running unpackaged, `process.resourcesPath`
   * when packaged (electron-builder copies resources/php → <resourcesPath>/php). Both contain `php/`.
   */
  resources: string
  /** ~/.config/tinkerbox — Tinkerbox's own config dir (global custom drivers live here). */
  configDir: string
  /** ~/.config/tinkerbox/themes — custom themes (same location on every platform). */
  themes: string
  /** ~/.config/tinkerbox/drivers — global custom drivers (DriverRegistry.php scans *.php here). */
  drivers: string
  /** Template of the macOS/Linux CLI helper. */
  cliTemplate: string
  files: {
    settings: string
    connections: string
    snippets: string
    history: string
    session: string
    stats: string
    windowState: string
  }
}

export interface PathInputs {
  userData: string
  /** app.getAppPath(): the repo root in development, `…/app.asar` when packaged. */
  appPath: string
  isPackaged: boolean
  /** process.resourcesPath */
  processResourcesPath: string
  home?: string
}

/** Environment variable that points the app at an isolated user-data directory (tests, side-by-side profiles). */
export const USER_DATA_ENV = 'TINKERBOX_USER_DATA_DIR'

/**
 * Explicit user-data directory requested on the command line (`--user-data-dir=<dir>`, the Chromium switch form)
 * or through TINKERBOX_USER_DATA_DIR (the switch wins). Relative paths resolve against `cwd`. Returns null when
 * neither is set. index.ts applies it with app.setPath('userData') before the single-instance lock, so an isolated
 * instance (e.g. the E2E suite) neither talks to nor quits because of a running Tinkerbox.
 */
export function userDataOverride(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string
): string | null {
  let value: string | undefined
  for (const arg of argv) {
    if (arg === '--') break
    if (typeof arg === 'string' && arg.startsWith('--user-data-dir=')) value = arg.slice('--user-data-dir='.length)
  }
  if (!value?.trim()) value = env[USER_DATA_ENV]
  const trimmed = value?.trim()
  return trimmed ? resolve(cwd, trimmed) : null
}

/** ~/.config/tinkerbox (USERPROFILE on Windows, via os.homedir()). */
export function tinkerboxConfigDir(home: string = homedir()): string {
  return join(home, '.config', 'tinkerbox')
}

export function themesDir(home: string = homedir()): string {
  return join(tinkerboxConfigDir(home), 'themes')
}

export function resolveAppPaths(input: PathInputs): AppPaths {
  const home = input.home ?? homedir()
  const resources = input.isPackaged ? input.processResourcesPath : join(input.appPath, 'resources')
  const file = (name: string): string => join(input.userData, name)
  return {
    userData: input.userData,
    resources,
    configDir: tinkerboxConfigDir(home),
    themes: themesDir(home),
    drivers: join(tinkerboxConfigDir(home), 'drivers'),
    // Inside app.asar when packaged (resources/** is also unpacked); Electron's fs reads both transparently.
    cliTemplate: join(input.appPath, 'resources', 'bin', 'tinkerbox.sh'),
    files: {
      settings: file('settings.json'),
      connections: file('connections.json'),
      snippets: file('snippets.json'),
      history: file('history.json'),
      session: file('session.json'),
      stats: file('stats.json'),
      windowState: file('window-state.json')
    }
  }
}
