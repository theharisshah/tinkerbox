import type { CommandId } from './ipc'

export interface CommandMeta {
  title: string
  /** Group used in the command palette and the Shortcuts settings page. */
  group: 'Run' | 'Tabs' | 'File' | 'Panels' | 'Layout' | 'Output' | 'Editor'
  /** Default Electron accelerator; '' = no default. */
  accelerator: string
  /** Optional per-platform override of the default accelerator. */
  win?: string
  linux?: string
  /** Whether the shortcut is handled by the native menu (true) or only inside the renderer. */
  menu?: boolean
}

/**
 * Default command metadata and accelerators
 * (Run ⌘R, Open Anything ⇧⌘P, Prettify ⌘P, History ⌘Y / Ctrl+I, Snippets ⌘B, Logs ⌘L,
 * CLI mode ⇧⌘C, layout Ctrl+., duplicate tab ⇧⌘D …).
 */
export const COMMAND_META: Record<CommandId, CommandMeta> = {
  run: { title: 'Run Code', group: 'Run', accelerator: 'CmdOrCtrl+R', menu: true },
  runSelection: { title: 'Run Selected Code', group: 'Run', accelerator: 'CmdOrCtrl+Shift+R', menu: true },
  cancelRun: { title: 'Stop Running Code', group: 'Run', accelerator: '', menu: true },
  toggleAutoRun: { title: 'Toggle Auto Evaluate', group: 'Run', accelerator: 'CmdOrCtrl+Shift+A', menu: true },
  toggleDebugging: { title: 'Toggle Debugging (Xdebug)', group: 'Run', accelerator: '', menu: true },
  toggleQueries: { title: 'Toggle SQL Query Inspection', group: 'Run', accelerator: 'CmdOrCtrl+Shift+Q', menu: true },

  newTab: { title: 'New Tab', group: 'Tabs', accelerator: 'CmdOrCtrl+T', menu: true },
  closeTab: { title: 'Close Tab', group: 'Tabs', accelerator: 'CmdOrCtrl+W', menu: true },
  duplicateTab: { title: 'Duplicate Tab', group: 'Tabs', accelerator: 'CmdOrCtrl+Shift+D', menu: true },
  reopenClosedTab: { title: 'Reopen Closed Tab', group: 'Tabs', accelerator: 'CmdOrCtrl+Shift+T', menu: true },
  nextTab: { title: 'Next Tab', group: 'Tabs', accelerator: 'Ctrl+Tab', menu: true },
  previousTab: { title: 'Previous Tab', group: 'Tabs', accelerator: 'Ctrl+Shift+Tab', menu: true },
  renameTab: { title: 'Rename Tab', group: 'Tabs', accelerator: '', menu: false },
  showWelcome: { title: 'Show Get Started', group: 'Tabs', accelerator: '', menu: true },

  openFolder: { title: 'Open Local Project…', group: 'File', accelerator: 'CmdOrCtrl+O', menu: true },
  openFile: { title: 'Open File…', group: 'File', accelerator: 'CmdOrCtrl+Shift+O', menu: true },
  saveFile: { title: 'Save File', group: 'File', accelerator: 'CmdOrCtrl+S', menu: true },
  saveFileAs: { title: 'Save File As…', group: 'File', accelerator: 'CmdOrCtrl+Shift+S', menu: true },
  saveOutput: { title: 'Save Output to File…', group: 'File', accelerator: '', menu: true },
  watchFile: { title: 'Watch File (Re-run on Change)', group: 'File', accelerator: 'CmdOrCtrl+Shift+W', menu: true },
  openSandbox: { title: 'Open Laravel Sandbox', group: 'File', accelerator: '', menu: true },
  openProjectInEditor: { title: 'Open Project in Editor', group: 'File', accelerator: '', menu: true },

  commandPalette: { title: 'Open Anything', group: 'Panels', accelerator: 'CmdOrCtrl+Shift+P', menu: true },
  phpSettings: { title: 'Project PHP Settings', group: 'Panels', accelerator: '', menu: true },
  showHistory: { title: 'Toggle History', group: 'Panels', accelerator: 'CmdOrCtrl+Y', win: 'Ctrl+I', linux: 'Ctrl+I', menu: true },
  showSnippets: { title: 'Toggle Snippets', group: 'Panels', accelerator: 'CmdOrCtrl+B', menu: true },
  showLogs: { title: 'Toggle Logs', group: 'Panels', accelerator: 'CmdOrCtrl+L', menu: true },
  showPanels: { title: 'Show App Information Panels', group: 'Panels', accelerator: '', menu: true },
  openSettings: { title: 'Settings…', group: 'Panels', accelerator: 'CmdOrCtrl+,', menu: true },
  showWrapped: { title: 'Year in Review', group: 'Panels', accelerator: '', menu: true },

  toggleLayout: { title: 'Toggle Editor Layout', group: 'Layout', accelerator: 'Ctrl+.', menu: true },
  toggleOutput: { title: 'Toggle Editor Output', group: 'Layout', accelerator: 'CmdOrCtrl+Alt+Shift+O', menu: true },
  toggleToolbar: { title: 'Toggle Toolbar', group: 'Layout', accelerator: 'CmdOrCtrl+Alt+Shift+T', menu: true },
  toggleSidebar: { title: 'Toggle Sidebar', group: 'Layout', accelerator: 'CmdOrCtrl+\\', menu: true },
  zenMode: { title: 'Toggle Zen Mode', group: 'Layout', accelerator: 'CmdOrCtrl+Alt+Shift+Z', menu: true },
  toggleFullscreen: { title: 'Toggle Fullscreen', group: 'Layout', accelerator: 'CmdOrCtrl+Alt+F', menu: true },
  toggleAlwaysOnTop: { title: 'Toggle Always on Top', group: 'Layout', accelerator: '', menu: true },
  zoomIn: { title: 'Zoom In', group: 'Layout', accelerator: 'CmdOrCtrl+=', menu: true },
  zoomOut: { title: 'Zoom Out', group: 'Layout', accelerator: 'CmdOrCtrl+-', menu: true },
  resetZoom: { title: 'Reset Zoom', group: 'Layout', accelerator: 'CmdOrCtrl+0', menu: true },

  outputDetail: { title: 'Output: Cards', group: 'Output', accelerator: '', menu: true },
  outputCli: { title: 'Output: CLI Mode', group: 'Output', accelerator: '', menu: true },
  toggleCliMode: { title: 'Toggle CLI Mode', group: 'Output', accelerator: 'CmdOrCtrl+Shift+C', menu: true },
  clearOutput: { title: 'Clear Output', group: 'Output', accelerator: 'Ctrl+L', win: 'Ctrl+Alt+L', linux: 'Ctrl+Alt+L', menu: false },
  copyResult: { title: 'Copy Result', group: 'Output', accelerator: '', menu: true },

  prettify: { title: 'Prettify Code', group: 'Editor', accelerator: 'CmdOrCtrl+P', menu: true },
  addMagicComment: { title: 'Add Magic Comment at End of Line', group: 'Editor', accelerator: 'CmdOrCtrl+Shift+M', menu: false },
  addToSnippets: { title: 'Add Code to Snippets', group: 'Editor', accelerator: '', menu: true },
  addSelectionToSnippets: { title: 'Add Selected Code to Snippets', group: 'Editor', accelerator: '', menu: false },
  focusEditor: { title: 'Focus Editor', group: 'Editor', accelerator: 'Escape', menu: false },
  shareGist: { title: 'Share Code as GitHub Gist', group: 'Editor', accelerator: '', menu: true }
}

/** Effective accelerator for a command on a platform, honoring user overrides. */
export function acceleratorFor(
  id: CommandId,
  platform: NodeJS.Platform,
  overrides: Partial<Record<string, string>> = {}
): string {
  const override = overrides[id]
  if (override !== undefined) return override
  const meta = COMMAND_META[id]
  if (platform === 'win32' && meta.win !== undefined) return meta.win
  if (platform === 'linux' && meta.linux !== undefined) return meta.linux
  return meta.accelerator
}
