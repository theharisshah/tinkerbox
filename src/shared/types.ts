/**
 * Shared contracts between the Electron main process, the preload bridge and the
 * renderer. Everything that crosses the IPC boundary is declared here.
 *
 * The PHP runner (resources/php) emits JSON that must match `PhpEnvelope` /
 * `PhpDataEnvelope`. See docs/ARCHITECTURE.md for the full protocol.
 */

// ---------------------------------------------------------------------------
// Connections
//
// SCOPE: this build executes code LOCALLY only — local projects, the Laravel Sandbox and
// plain PHP. Remote targets (SSH, Docker, Kubernetes, Vapor, Laravel Cloud) are deferred and
// will be added later as new `Connection` variants + execution transports (see
// docs/ARCHITECTURE.md "Extension point: transports").
// ---------------------------------------------------------------------------

export type ConnectionType = 'local'

export interface ConnectionBase {
  id: string
  /** Display label: the folder name of the project. */
  name: string
  type: ConnectionType
  /** PHP binary override (path or Herd alias like `php83`). Empty => global setting. */
  phpBinary?: string
  /** Force a driver id (see DriverInfo.id); empty => auto-detect. */
  driver?: string
  /** Optional label color (CSS color) for the tab badge. */
  color?: string
  createdAt: number
  lastUsedAt?: number
  /** Xdebug step debugging toggled for this project. */
  debug?: boolean
}

export interface LocalConnection extends ConnectionBase {
  type: 'local'
  /** Absolute project directory on this machine. '' => plain PHP scratch (no framework). */
  path: string
}

/** Union kept for future remote connection types (SSH, Docker…). */
export type Connection = LocalConnection

/** Placeholder sent to the renderer instead of stored secrets. Saving it back keeps the old secret. */
export const SECRET_MASK = '••••••••'

/** Implicit plain-PHP connection (no project). */
export const SCRATCH_CONNECTION_ID = 'scratch'
/** Implicit connection pointing at the bundled/installed Laravel Sandbox. */
export const SANDBOX_CONNECTION_ID = 'sandbox'

export interface ConnectionTestResult {
  ok: boolean
  message: string
  phpVersion?: string
  driver?: DriverInfo | null
  durationMs: number
}

// ---------------------------------------------------------------------------
// PHP binaries & Herd
// ---------------------------------------------------------------------------

export interface PhpBinary {
  path: string
  /** Short version, e.g. "8.3.12". */
  version: string
  /** Full first line of `php -v`, e.g. "PHP 8.3.12 (cli) (built: …) (NTS)". */
  versionLine: string
  /** e.g. "Herd", "Homebrew", "System", "MAMP", "XAMPP", "Laragon", "PATH" */
  source: string
  /** Herd alias such as php83 when applicable. */
  alias?: string
}

export interface HerdSite {
  name: string
  path: string
  url: string
  phpVersion?: string
}

export interface SandboxStatus {
  installed: boolean
  path: string
  laravelVersion?: string
  installing: boolean
  /** Last install error, if any. */
  error?: string
}

// ---------------------------------------------------------------------------
// Dumped values (structured, rendered VarDumper-style in the output cards and as text in CLI mode)
// ---------------------------------------------------------------------------

export type Visibility = 'public' | 'protected' | 'private' | 'dynamic' | 'attribute' | 'relation' | 'meta'

export interface DumpProperty {
  name: string
  vis: Visibility
  v: DumpNode
  /** For private props declared on a parent class. */
  declaringClass?: string
}

export interface DumpItem {
  k: string | number
  v: DumpNode
}

export type DumpNode =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  /** Integers are strings to preserve 64-bit precision. */
  | { t: 'int'; v: string }
  /** Floats are strings ("INF", "NAN", "1.5", "1.0E+25"). */
  | { t: 'float'; v: string }
  | { t: 'string'; v: string; len: number; truncated?: boolean; binary?: boolean }
  | { t: 'array'; count: number; items: DumpItem[]; truncated?: boolean }
  | {
      t: 'object'
      class: string
      /** spl_object_id */
      id: number
      /**
       * Rendering hints:
       *  model       Eloquent model — props: attributes (vis 'attribute'), relations ('relation'), meta ('meta'); summary "#<key>"
       *  collection  Laravel Collection / Traversable — `items` holds the elements, `count` the size
       *  datetime    DateTimeInterface/Carbon — `summary` holds "Y-m-d H:i:s.u T (P)"
       *  exception   Throwable — props include message/code/file/line
       *  stringable  Stringable / __toString objects — `summary` holds the string
       *  builder     Eloquent / Query builder — `summary` holds the SQL with bindings
       *  html        Mailable / View / MailMessage / Htmlable — `html` holds the rendered HTML (eye icon → HTML Preview)
       */
      kind?: 'model' | 'collection' | 'datetime' | 'exception' | 'stringable' | 'builder' | 'html' | 'generic'
      summary?: string
      html?: string
      props: DumpProperty[]
      items?: DumpItem[]
      count?: number
      truncated?: boolean
    }
  /** Object already printed elsewhere in the tree (cycle / repeated reference). */
  | { t: 'ref'; class: string; id: number }
  | { t: 'enum'; class: string; case: string; value?: string | number }
  | { t: 'closure'; signature: string; file?: string; line?: number }
  | { t: 'resource'; type: string; id: number }
  /** Depth limit reached; the value was not expanded. */
  | { t: 'max-depth'; type: string; class?: string; count?: number }

// ---------------------------------------------------------------------------
// Run output: an ordered event stream (one output card per event)
// ---------------------------------------------------------------------------

export interface QueryEntry {
  sql: string
  bindings: string[]
  /** SQL with bindings interpolated (for display / copy). */
  rawSql: string
  timeMs: number
  connection: string
}

export type OutputEvent =
  /** Text written with echo/print/printf/var_dump… between other events. */
  | { seq: number; kind: 'echo'; text: string; line?: number }
  /** dump()/dd()/tw()/var_dump-captured value. `file`/`line` point at the call site (editor line when userCode). */
  | { seq: number; kind: 'dump'; value: DumpNode; line?: number; file?: string; userCode?: boolean; label?: string }
  | ({ seq: number; kind: 'query'; line?: number } & QueryEntry)

/** Value recorded by a magic comment. */
export interface MagicValue {
  /** 1-based editor line. */
  line: number
  /** 0-based editor column of the comment (for inline `/*?*\/` comments). */
  column?: number
  /** 'value' for //?, /*?*\/ and /*?->expr*\/; 'time' for /*?.*\/ (seconds since script start). */
  type: 'value' | 'time'
  /** Short one-line preview rendered inline as a badge. */
  preview: string
  value: DumpNode | null
  /** How many times this comment was hit (loops). The latest value wins. */
  hits: number
  label?: string
}

export interface TraceFrame {
  file?: string
  line?: number
  /** e.g. "App\\Models\\User::find()" */
  call: string
  /** Frame belongs to the user's editor code. `line` is then the editor line. */
  userCode?: boolean
  /** Frame is inside vendor/ (collapsed by default in the UI). */
  vendor?: boolean
}

export interface CodeSnippet {
  /** First line number of `lines`. */
  startLine: number
  /** The highlighted line. */
  line: number
  lines: string[]
}

export interface ExceptionInfo {
  class: string
  message: string
  code: string
  file: string
  line: number
  /** 1-based editor line when the exception originates from (or passes through) the user's code. */
  userLine?: number
  /** Collision-style code excerpt around the failing line (project file or the user's code). */
  snippet?: CodeSnippet
  trace: TraceFrame[]
  previous?: ExceptionInfo | null
  /** Fatal engine error captured in the shutdown handler (cannot be caught). */
  fatal?: boolean
  /** Exception happened while bootstrapping the framework (before user code ran). */
  bootstrap?: boolean
}

export interface PhpDiagnostic {
  /** e.g. "Warning", "Notice", "Deprecated" */
  level: string
  message: string
  file: string
  line: number
  userLine?: number
}

export interface DriverInfo {
  /** Driver id(): laravel, lumen, laravel-zero, statamic, october, testbench, symfony, wordpress, bedrock, radicle, drupal7, drupal, craft, magento2, shopware, kirby, moodle, prestashop, typo3, cakephp, codeigniter4, yii2, joomla, composer, none — or the id a custom driver (.tinkerbox/drivers) declares */
  id: string
  name: string
  /** Footer label, e.g. "Laravel 12.20.0" (driver version()). */
  appVersion?: string
  /** Driver preference for Collision-style error output: null => follow the global setting. */
  usesCollision?: boolean | null
  /** Root directory for the log viewer. */
  logFilesPath?: string | null
}

// ---------------------------------------------------------------------------
// Running code
// ---------------------------------------------------------------------------

export interface DumpLimits {
  maxDepth: number
  maxItems: number
  maxStringLength: number
}

export interface RunOptions extends DumpLimits {
  captureQueries: boolean
  magicComments: boolean
  /** Track executed lines for the coverage gutter. */
  coverage: boolean
  /** Prepend declare(strict_types=1). */
  strictTypes: boolean
  /** buffered: echo output captured into events. realtime: echo streams to stdout as it happens. */
  outputType: 'buffered' | 'realtime'
  timeoutMs: number
}

export interface RunRequest {
  runId: string
  tabId: string
  /** null => default (Default Working Directory, else Sandbox when installed, else scratch) */
  connectionId: string | null
  code: string
  /**
   * When running a selection, the 1-based editor line the selection starts at, so
   * line numbers in errors/magic comments/dumps map back to the full editor buffer.
   */
  lineOffset?: number
  options: RunOptions
}

/** JSON document emitted by the PHP runner between the nonce markers (mode `run`). */
export interface PhpEnvelope {
  version: 1
  mode: 'run'
  phpVersion: string
  driver: DriverInfo | null
  events: OutputEvent[]
  hasReturnValue: boolean
  returnValue: DumpNode | null
  magic: MagicValue[]
  /** Executed editor lines (1-based), sorted. */
  coverage: number[]
  exception: ExceptionInfo | null
  diagnostics: PhpDiagnostic[]
  bootMs: number
  durationMs: number
  memoryPeak: number
  /** User code called exit()/die() or dd(). */
  exited?: boolean
}

/** Envelope emitted by the runner for data modes. */
export interface PhpDataEnvelope<T> {
  version: 1
  mode: PhpDataMode
  phpVersion: string
  driver: DriverInfo | null
  data: T
  /** Bootstrap or mode failure message. */
  error?: string
}

export type PhpDataMode = 'environment' | 'members' | 'detect' | 'logs' | 'logRead' | 'panels' | 'snippets'

export interface RunResult extends Omit<PhpEnvelope, 'version' | 'mode'> {
  runId: string
  tabId: string
  connectionId: string
  ok: boolean
  /** Wall clock measured by the main process, including process spawn. */
  totalMs: number
  stderr: string
  /** stdout outside the envelope (framework noise, realtime output) or everything when parsing failed. */
  rawOutput: string
  exitCode: number | null
  cancelled?: boolean
  timedOut?: boolean
  /** Transport-level failure (could not spawn php, envelope missing…). */
  error?: string
  finishedAt: number
}

/** Streamed while a run is in progress (raw stdout/stderr chunks, outside-envelope text only). */
export interface RunProgressEvent {
  runId: string
  tabId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

// ---------------------------------------------------------------------------
// Introspection (autocomplete), panels, logs, project snippets
// ---------------------------------------------------------------------------

export interface FunctionInfo {
  name: string
  /** e.g. "(string $haystack, string $needle): bool" */
  signature: string
  doc?: string
}

export interface ModelInfo {
  class: string
  table?: string
  columns: Array<{ name: string; type?: string }>
  relations?: string[]
}

export interface EnvironmentInfo {
  phpVersion: string
  driver: DriverInfo | null
  extensions: string[]
  functions: FunctionInfo[]
  /** FQCNs available for autocomplete (declared + composer classmap + PSR-4 scan). */
  classes: string[]
  /** Short name => FQCN aliases resolved automatically at run time (Tinker-style class aliasing). */
  aliases: Record<string, string>
  constants: string[]
  models: ModelInfo[]
  /** Variables pre-defined by the driver (variables()), e.g. $app, $kernel, $container. */
  variables: Array<{ name: string; type?: string }>
}

export interface MemberInfo {
  name: string
  kind: 'method' | 'property' | 'constant' | 'case'
  static: boolean
  visibility: 'public' | 'protected' | 'private'
  /** For methods: "(int $id, array $columns = ['*']): ?static" */
  signature?: string
  type?: string
  doc?: string
  declaringClass?: string
}

export interface ClassMembers {
  class: string
  parent?: string
  interfaces: string[]
  members: MemberInfo[]
}

export interface IntrospectRequest {
  connectionId: string | null
  /** Required for members. Short names are resolved through aliases. */
  className?: string
  /** Bypass the cache. */
  force?: boolean
}

/** Panels modal (click framework version in the footer). Laravel default: `artisan about --json`. */
export interface AppPanel {
  title: string
  sections: Array<{ title: string; rows: Array<{ key: string; value: string }> }>
}

export interface LogFile {
  /** Path relative to the logs root. */
  path: string
  name: string
  /** Directory relative to the logs root ('' for root). */
  dir: string
  size: number
  modifiedAt: number
}

export interface LogEntry {
  /** ISO-ish timestamp as printed in the log. */
  datetime: string
  env?: string
  /** debug, info, notice, warning, error, critical, alert, emergency */
  level: string
  message: string
  context?: string
  stack?: string
}

export interface LogReadRequest {
  connectionId: string | null
  file: string
  /** Max entries returned (newest first). */
  limit: number
}

export interface LogListing {
  root: string
  files: LogFile[]
}

// ---------------------------------------------------------------------------
// Snippets, history, tabs, stats
// ---------------------------------------------------------------------------

export interface Snippet {
  id: string
  name: string
  description?: string
  code: string
  /** Connection id the snippet is assigned to ('' = global). Opening it switches the tab to that project. */
  connectionId: string
  /** 'user' snippets live in snippets.json; 'project' snippets come from <project>/.tinkerbox/snippets/*.php (read-only). */
  source: 'user' | 'project'
  createdAt: number
  updatedAt: number
}

export interface HistoryEntry {
  id: string
  code: string
  connectionId: string
  connectionName: string
  ranAt: number
  durationMs: number
  ok: boolean
  /** One-line preview of the result or exception message. */
  preview: string
}

/** detail = output cards; cli = PsySH-style text. */
export type OutputMode = 'detail' | 'cli'

export interface TabState {
  id: string
  kind: 'code' | 'welcome'
  /** Auto title (project / connection name) unless renamed by the user for this session. */
  title: string
  customTitle?: string
  code: string
  /** null => default connection (Default Working Directory, else Sandbox, else scratch). */
  connectionId: string | null
  outputMode: OutputMode
  /** SQL toggle in the title bar. */
  showQueries: boolean
  /** File on disk the tab is bound to (Save / Save As). */
  filePath?: string
  dirty?: boolean
}

export interface SessionState {
  tabs: TabState[]
  activeTabId: string | null
}

/** Usage statistics for "Year in Review" (yearly summary). */
export interface UsageStats {
  year: number
  runs: number
  failedRuns: number
  exceptions: Record<string, number>
  queries: number
  magicComments: number
  totalRunMs: number
  /** runs per hour of day (24 entries). */
  hours: number[]
  /** runs per connection name. */
  projects: Record<string, number>
  /** runs per driver id. */
  drivers: Record<string, number>
  longestRunMs: number
  firstRunAt?: number
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type EditorIntegration =
  | 'none'
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'phpstorm'
  | 'sublime'
  | 'zed'
  | 'textmate'
  | 'nova'
  | 'bbedit'

export interface Settings {
  // General
  /** 'auto' or a path / Herd alias. */
  phpBinary: string
  editorIntegration: EditorIntegration
  /** Directory used for new tabs; '' => Laravel Sandbox (or plain PHP when the sandbox is not installed). */
  defaultWorkingDirectory: string
  welcomeTab: boolean
  restoreSession: boolean
  askBeforeClosingTab: boolean

  // Appearance
  /** Theme id (built-in or custom:<file-name>). */
  theme: string
  /** Follow the OS dark/light preference using the two themes below. */
  syncThemeWithOs: boolean
  darkTheme: string
  lightTheme: string
  editorFontFamily: string
  editorFontSize: number
  outputFontSize: number
  lineHeight: number
  fontLigatures: boolean
  indentGuides: boolean
  lineNumbers: boolean
  minimap: boolean
  wordWrap: boolean
  /** vertical: output right of the editor. horizontal: output below the editor (Ctrl+.). */
  layout: 'vertical' | 'horizontal'
  /** Fraction of the split given to the editor (0.15..0.85). */
  splitRatio: number
  showToolbar: boolean
  showOutput: boolean
  alwaysOnTop: boolean
  /** ESC hides the output pane; it re-appears on the next run. */
  autoHideOutput: boolean

  // Behaviour
  autoRun: boolean
  autoRunDelayMs: number
  /** Run only the selected code when a selection exists. */
  runSelection: boolean
  strictTypes: boolean
  prettifyOnRun: boolean
  prettierQuoteStyle: 'single' | 'double'
  tabSize: number

  // Output
  defaultOutputMode: OutputMode
  outputType: 'buffered' | 'realtime'
  showQueriesByDefault: boolean
  magicComments: boolean
  coverage: boolean
  /** Show exceptions inline in the editor next to the failing line. */
  inlineErrors: boolean
  /** Collapse nested arrays/objects in the output cards by default. */
  collapseNested: boolean
  maxDepth: number
  maxItems: number
  maxStringLength: number
  timeoutMs: number

  // Shortcuts: command id -> Electron accelerator (overrides the defaults)
  shortcuts: Partial<Record<string, string>>


  // Advanced
  vimMode: boolean
  historyLimit: number
  collision: boolean
  /** Encrypted at rest; masked as SECRET_MASK in the renderer. Used for "Share as Gist". */
  github: { token: string }
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/** Monaco theme JSON of a custom theme (~/.config/tinkerbox/themes/*.json). */
export interface MonacoThemeJson {
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
  inherit: boolean
  rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>
  colors: Record<string, string>
  /**
   * App chrome colors (optional `custom` block), e.g. "primary.background",
   * "primary.hoverBackground", "primary.activeBackground", "primary.foreground",
   * "secondary.background", "border", "text", "alternate", "accent". Missing keys are
   * derived from `colors` (editor.background, editor.foreground…).
   */
  custom?: Record<string, string>
}

export interface CustomTheme {
  /** custom:<file-name-without-extension> */
  id: string
  name: string
  file: string
  theme: MonacoThemeJson
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
  arch: string
  userDataPath: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  isPackaged: boolean
  /** Directory scanned for custom themes. */
  themesPath: string
  /** Directory scanned for global custom drivers. */
  driversPath: string
}
