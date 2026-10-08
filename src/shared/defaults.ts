import type { RunOptions, Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  // General
  phpBinary: 'auto',
  editorIntegration: 'vscode',
  defaultWorkingDirectory: '',
  welcomeTab: true,
  restoreSession: true,
  askBeforeClosingTab: false,

  // Appearance
  theme: 'tinkerbox',
  syncThemeWithOs: false,
  darkTheme: 'dracula',
  lightTheme: 'tinkerbox',
  editorFontFamily: "'Fira Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
  editorFontSize: 16,
  outputFontSize: 14,
  lineHeight: 1.8,
  fontLigatures: true,
  indentGuides: true,
  lineNumbers: true,
  minimap: false,
  wordWrap: true,
  layout: 'vertical',
  splitRatio: 0.55,
  showToolbar: true,
  showOutput: true,
  alwaysOnTop: false,
  autoHideOutput: false,

  // Behaviour
  autoRun: false,
  autoRunDelayMs: 1000,
  runSelection: true,
  strictTypes: false,
  prettifyOnRun: true,
  prettierQuoteStyle: 'single',
  tabSize: 4,

  // Output
  defaultOutputMode: 'detail',
  outputType: 'buffered',
  showQueriesByDefault: false,
  magicComments: true,
  coverage: true,
  inlineErrors: true,
  collapseNested: true,
  maxDepth: 8,
  maxItems: 500,
  maxStringLength: 10000,
  timeoutMs: 120000,

  // Shortcuts
  shortcuts: {},


  // Advanced
  vimMode: false,
  historyLimit: 150,
  collision: true,
  github: { token: '' }
}

/** Run options for a tab; `captureQueries` follows the tab's SQL toggle. */
export function runOptionsFromSettings(s: Settings, captureQueries: boolean): RunOptions {
  return {
    maxDepth: s.maxDepth,
    maxItems: s.maxItems,
    maxStringLength: s.maxStringLength,
    captureQueries,
    magicComments: s.magicComments,
    coverage: s.coverage,
    strictTypes: s.strictTypes,
    outputType: s.outputType,
    timeoutMs: s.timeoutMs
  }
}

/** Example script shown in the Get Started tab and in brand-new tabs. */
export const WELCOME_CODE = `// Welcome to Tinkerbox! Write PHP and press ⌘R / Ctrl+R to run it.
// The value of the last expression appears in the output pane.
// End a line with a magic comment //? to see its value inline.

$greeting = 'Hello from PHP ' . PHP_VERSION; //?

$fruits = ['apple', 'banana', 'cherry'];

array_map(fn (string $fruit) => strtoupper($fruit), $fruits);
`
