import type {
  AppInfo,
  AppPanel,
  ClassMembers,
  Connection,
  ConnectionTestResult,
  CustomTheme,
  EnvironmentInfo,
  HerdSite,
  HistoryEntry,
  IntrospectRequest,
  LogEntry,
  LogListing,
  LogReadRequest,
  PhpBinary,
  RunProgressEvent,
  RunRequest,
  RunResult,
  SandboxStatus,
  SessionState,
  Settings,
  Snippet,
  UsageStats
} from './types'

/**
 * Invoke channels (renderer -> main, request/response via ipcRenderer.invoke).
 * Keys are channel names; values are [args tuple, return type].
 */
export interface InvokeChannels {
  'app:info': [[], AppInfo]

  // Settings ----------------------------------------------------------------
  'settings:get': [[], Settings]
  /** Partial update (deep-merged for nested objects); returns the full, masked settings. */
  'settings:update': [[patch: DeepPartial<Settings>], Settings]
  /** Reset everything to DEFAULT_SETTINGS. */
  'settings:reset': [[], Settings]

  // Connections ---------------------------------------------------------------
  /** Local project connections (= recent folders), most recent first. */
  'connections:list': [[], Connection[]]
  /** Create or update (by id). Returns the saved connection. */
  'connections:save': [[connection: Connection], Connection]
  'connections:delete': [[id: string], void]
  /** Open (or reuse) the local project connection for a directory; updates lastUsedAt. */
  'connections:openLocal': [[path: string], Connection]
  'connections:test': [[connection: Connection], ConnectionTestResult]
  /** Mark a connection as used now (recent folders ordering). */
  'connections:touch': [[id: string], void]
  /** Clear the recent folders list. */
  'connections:clearRecents': [[], void]

  // PHP & Herd -----------------------------------------------------------------------------
  'php:binaries': [[], PhpBinary[]]
  /** Validate a binary path or Herd alias; returns null when it is not a working PHP CLI. */
  'php:inspect': [[binary: string], PhpBinary | null]
  'herd:sites': [[], HerdSite[]]

  // Laravel Sandbox -------------------------------------------------------------------
  'sandbox:status': [[], SandboxStatus]
  /** Installs/updates the sandbox via `composer create-project laravel/laravel` (progress via 'sandbox:progress'). */
  'sandbox:install': [[], SandboxStatus]

  // Running code -------------------------------------------------------------------------
  'run:start': [[request: RunRequest], RunResult]
  'run:cancel': [[runId: string], void]

  // Introspection / project data ---------------------------------------------------------
  'introspect:environment': [[request: IntrospectRequest], EnvironmentInfo]
  'introspect:members': [[request: IntrospectRequest], ClassMembers | null]
  'project:panels': [[connectionId: string | null], AppPanel[]]
  'logs:list': [[connectionId: string | null], LogListing]
  'logs:read': [[request: LogReadRequest], LogEntry[]]

  // Snippets ---------------------------------------------------------------------------
  /** User snippets + project snippets of the given connection (.tinkerbox/snippets). */
  'snippets:list': [[connectionId?: string | null], Snippet[]]
  'snippets:save': [[snippet: Snippet], Snippet]
  'snippets:delete': [[id: string], void]
  /** Save dialog → JSON export. Returns the path or null if cancelled. */
  'snippets:export': [[], string | null]
  /** Open dialog → merge snippets from a JSON export. Returns the number imported. */
  'snippets:import': [[], number]

  // History ------------------------------------------------------------------------------
  'history:list': [[], HistoryEntry[]]
  'history:delete': [[id: string], void]
  'history:clear': [[], void]

  // Session & stats ---------------------------------------------------------------------
  'session:load': [[], SessionState | null]
  'session:save': [[state: SessionState], void]
  'stats:get': [[year?: number], UsageStats]

  // Themes ---------------------------------------------------------------------------
  'themes:listCustom': [[], CustomTheme[]]
  /** Create a custom theme file from a base theme JSON; returns the created theme. */
  'themes:create': [[name: string, base: CustomTheme['theme']], CustomTheme]
  'themes:openFolder': [[], void]

  // Files & shell -----------------------------------------------------------------------
  'dialog:openDirectory': [[title?: string], string | null]
  /** Pick a file (e.g. private key, kubeconfig, php binary). */
  'dialog:openFile': [[title?: string, filters?: Array<{ name: string; extensions: string[] }>], string | null]
  /** Open a .php file; returns its path and contents. */
  'file:open': [[], { path: string; content: string } | null]
  /** Save to the given path, or ask with a dialog when path is undefined. Returns the final path. */
  'file:save': [[content: string, path?: string, defaultName?: string], string | null]
  /** Read a local text file. Max 512 KB. */
  'file:read': [[path: string], string]
  /** Watch a file for external changes ('file:changed' events); path null stops watching for the tab. */
  'file:watch': [[tabId: string, path: string | null], void]
  /** Whether the path (absolute, or starting with ~) is an existing directory (e.g. the Default working directory). */
  'file:isDirectory': [[path: string], boolean]
  'shell:openExternal': [[url: string], void]
  /** Open a file at a line in the preferred editor (settings.editorIntegration). */
  'shell:openInEditor': [[file: string, line?: number, connectionId?: string | null], void]
  /** Open a project directory in the preferred editor. */
  'shell:openProjectInEditor': [[connectionId: string | null], void]
  'shell:revealInFinder': [[path: string], void]
  'clipboard:write': [[text: string], void]
  'window:setTitle': [[title: string], void]
  /** Enter / leave fullscreen (native fullscreen included); resolves with the new state. */
  'window:toggleFullscreen': [[], boolean]
  /** Installs the `tinkerbox` CLI helper; returns the installed path or a manual command to run. */
  'cli:install': [[], { installed: boolean; path: string; message: string }]


  // Integrations ----------------------------------------------------------------------------
  /** Create a GitHub Gist from code; returns the gist URL. */
  'share:gist': [[code: string, description: string, isPublic: boolean], string]
}

/** Event channels (main -> renderer, pushed via webContents.send). */
export interface EventChannels {
  'run:progress': RunProgressEvent
  /** Native application menu item triggered a renderer command. */
  'menu:command': { command: CommandId }
  /** Settings changed (e.g. from main-side logic or another window). */
  'settings:changed': Settings
  /** Connections changed in main (e.g. openLocal from the CLI helper). */
  'connections:changed': { connections: Connection[] }
  /** History changed (a run finished). */
  'history:changed': void
  /** A directory should be opened in a new tab (CLI helper / second instance / dock drop). */
  'app:openPath': { path: string }
  /** A .php file was opened via the OS. */
  'file:opened': { path: string; content: string }
  /** A watched file changed on disk. */
  'file:changed': { tabId: string; path: string; content: string }
  /** Non-fatal notice for the renderer to toast (e.g. corrupted settings recovered). */
  'app:notice': { level: 'info' | 'warning' | 'error'; message: string }
  'sandbox:progress': { line: string; status: SandboxStatus }
  /** OS dark/light preference changed. */
  'theme:osChanged': { dark: boolean }
}

export type InvokeChannel = keyof InvokeChannels
export type EventChannel = keyof EventChannels
export type InvokeArgs<C extends InvokeChannel> = InvokeChannels[C][0]
export type InvokeReturn<C extends InvokeChannel> = InvokeChannels[C][1]

/** Typed bridge exposed on `window.tinkerbox` by the preload script. */
export interface TinkerboxBridge {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeReturn<C>>
  /** Subscribe to a main-process event; returns an unsubscribe function. */
  on<E extends EventChannel>(channel: E, listener: (payload: EventChannels[E]) => void): () => void
  platform: NodeJS.Platform
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/**
 * Commands that can be triggered from the native menu, the command palette and
 * keyboard shortcuts. The renderer owns their implementation; DEFAULT_SHORTCUTS
 * (src/shared/shortcuts.ts) holds the default accelerators.
 */
export const COMMANDS = [
  // Run
  'run',
  'runSelection',
  'cancelRun',
  'toggleAutoRun',
  'toggleDebugging',
  'toggleQueries',
  // Tabs
  'newTab',
  'closeTab',
  'duplicateTab',
  'reopenClosedTab',
  'nextTab',
  'previousTab',
  'renameTab',
  'showWelcome',
  // Files / projects
  'openFolder',
  'openFile',
  'saveFile',
  'saveFileAs',
  'saveOutput',
  'watchFile',
  'openSandbox',
  'openProjectInEditor',
  // Windows & panels
  'commandPalette',
  'phpSettings',
  'showHistory',
  'showSnippets',
  'showLogs',
  'showPanels',
  'openSettings',
  'showWrapped',
  // Layout
  'toggleLayout',
  'toggleOutput',
  'toggleToolbar',
  'toggleSidebar',
  'zenMode',
  'toggleFullscreen',
  'toggleAlwaysOnTop',
  'zoomIn',
  'zoomOut',
  'resetZoom',
  // Output
  'outputDetail',
  'outputCli',
  'toggleCliMode',
  'clearOutput',
  'copyResult',
  // Editor
  'prettify',
  'addMagicComment',
  'addToSnippets',
  'addSelectionToSnippets',
  'focusEditor',
  'shareGist'
] as const

export type CommandId = (typeof COMMANDS)[number]
