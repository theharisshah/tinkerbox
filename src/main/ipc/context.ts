import type { BrowserWindow, WebContents } from 'electron'
import type { EventChannel, EventChannels } from '../../shared/ipc'
import type { AppInfo, CustomTheme } from '../../shared/types'
import type { CliEnvironment } from '../cli'
import type { ExecutionContext } from '../execution/types'
import type { AppPaths } from '../paths'
import type { Logger } from '../store/common'
import type { ConnectionsStore } from '../store/connections'
import type { HistoryStore } from '../store/history'
import type { SessionStore } from '../store/session'
import type { SettingsStore } from '../store/settings'
import type { SnippetsStore } from '../store/snippets'
import type { StatsStore } from '../store/stats'
import type { FileWatchers } from './files'
import type { RunService } from './runs'
import type { SandboxManager } from './sandbox'

/** Everything the IPC handlers need; assembled once in src/main/index.ts. */
export interface ShellContext {
  paths: AppPaths
  logger: Logger
  settings: SettingsStore
  connections: ConnectionsStore
  snippets: SnippetsStore
  history: HistoryStore
  session: SessionStore
  stats: StatsStore
  exec: ExecutionContext
  /** Resolves once the login-shell PATH is loaded; await before anything that spawns processes. */
  envReady: Promise<void>
  runs: RunService
  sandbox: SandboxManager
  watchers: FileWatchers
  /** Send an event to every window. */
  broadcast<E extends EventChannel>(channel: E, payload: EventChannels[E]): void
  /** Toast in the renderer (queued until the renderer is ready). */
  notice(level: 'info' | 'warning' | 'error', message: string): void
  windowFor(sender: WebContents): BrowserWindow | null
  /** A local project folder was opened: OS recent documents + Open Recent / dock menus. */
  folderOpened(path: string): void
  /** Recent folders were cleared. */
  recentFoldersCleared(): void
  /** The renderer finished its startup (first session:load): deliver queued open requests. */
  rendererReady(sender: WebContents): void
  /** Custom themes were (re)listed; used for window chrome colors. */
  customThemesChanged(themes: CustomTheme[]): void
  cliEnvironment(): CliEnvironment
  appInfo(): AppInfo
}

/** Send an event to one renderer, ignoring destroyed web contents (window closed mid-operation). */
export function sendTo<E extends EventChannel>(wc: WebContents, channel: E, payload: EventChannels[E]): void {
  if (!wc.isDestroyed()) wc.send(channel, payload)
}
