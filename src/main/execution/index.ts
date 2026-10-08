/**
 * Execution API of the main process (docs/ARCHITECTURE.md §2.1), consumed by the IPC handlers (E2).
 *
 *   runCode:  resolve connection → transport (local by default, see transport.ts) → bundle (runner +
 *             payload) on stdin → stream outside-envelope output as run:progress → parseEnvelope → RunResult
 *   data modes (environment / members / detect / logs / logRead / panels / snippets) share the pipeline;
 *   introspection results are cached per connection (10 min).
 */
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runOptionsFromSettings } from '@shared/defaults'
import type {
  AppPanel,
  ClassMembers,
  Connection,
  ConnectionTestResult,
  DriverInfo,
  EnvironmentInfo,
  IntrospectRequest,
  LogEntry,
  LogListing,
  LogReadRequest,
  PhpDataEnvelope,
  PhpDataMode,
  PhpEnvelope,
  RunProgressEvent,
  RunRequest,
  RunResult,
  Snippet
} from '@shared/types'
import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID } from '@shared/types'
import { expandHome } from '../env/which'
import { buildBundle, encodeCode, loadRunnerScript, newNonce } from './bundle'
import { PromiseCache } from './cache'
import { normalizeConnection, resolveTargetConnection } from './connections'
import { EnvelopeStreamFilter, parseEnvelope } from './envelope'
import { killAllProcesses, summarizeOutput } from './process'
import { transportFor, type TransportResult } from './transport'
import type { ExecutionContext, PhpPayload } from './types'

export type { ExecutionContext, PhpPayload } from './types'
export type { Transport, TransportRequest, TransportResult } from './transport'
export { registerTransport, registeredTransports, unregisterTransport, transportFor } from './transport'
export { parseEnvelope, EnvelopeStreamFilter } from './envelope'
export { detectLocalProject } from './detectProject'
export { resolveImplicitConnection, resolveTargetConnection } from './connections'

/** Extra wall-clock time on top of `timeoutMs` so PHP's own `set_time_limit` can report first. */
export const TIMEOUT_GRACE_MS = 1000
const DATA_MODE_TIMEOUT_MS = 90_000
const CACHE_TTL_MS = 10 * 60_000
const MAX_RAW_OUTPUT = 5 * 1024 * 1024
const MAX_STREAMED = 8 * 1024 * 1024

const activeRuns = new Map<string, AbortController>()
const environmentCache = new PromiseCache<EnvironmentInfo>(CACHE_TTL_MS)
const membersCache = new PromiseCache<ClassMembers | null>(CACHE_TTL_MS)

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Cache key: connection id + a hash of everything that changes where/how the code runs. */
function cacheKey(conn: Connection): string {
  const relevant = [conn.type, conn.path, conn.phpBinary ?? '', conn.driver ?? '']
  return `${conn.id}|${createHash('sha1').update(JSON.stringify(relevant)).digest('hex')}`
}

function makePayload(conn: Connection, fields: Partial<PhpPayload> & Pick<PhpPayload, 'nonce' | 'mode' | 'options'>): PhpPayload {
  const transport = transportFor(conn)
  const defaults = transport.payloadDefaults?.(conn) ?? {}
  return {
    projectPath: defaults.projectPath ?? (conn.path ? expandHome(conn.path) : ''),
    driver: defaults.driver ?? conn.driver ?? '',
    homePath: defaults.homePath ?? homedir(),
    code: '',
    lineOffset: 1,
    className: '',
    logFile: '',
    logLimit: 500,
    ...fields
  }
}

/** Keep the head and the tail of very large raw output. */
function capRawOutput(text: string): string {
  if (text.length <= MAX_RAW_OUTPUT) return text
  const head = text.slice(0, 1024 * 1024)
  const tail = text.slice(text.length - (MAX_RAW_OUTPUT - head.length))
  return `${head}\n… ${text.length - head.length - tail.length} characters of output omitted …\n${tail}`
}

/** Coalesce output chunks (≈25 events/s per stream, ≤ 64 KB each) so the renderer is not flooded. */
function createProgressEmitter(request: RunRequest, onProgress: (e: RunProgressEvent) => void) {
  let stdout = ''
  let stderr = ''
  let streamed = 0
  let truncated = false
  let timer: NodeJS.Timeout | undefined
  const emit = (stream: 'stdout' | 'stderr', chunk: string): void => {
    if (!chunk) return
    try {
      onProgress({ runId: request.runId, tabId: request.tabId, stream, chunk })
    } catch {
      /* the window may be gone: progress is best effort, the final RunResult still arrives */
    }
  }
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const out = stdout
    const err = stderr
    stdout = ''
    stderr = ''
    emit('stdout', out)
    emit('stderr', err)
  }
  const add = (stream: 'stdout' | 'stderr', chunk: string): void => {
    if (!chunk || truncated) return
    streamed += chunk.length
    if (streamed > MAX_STREAMED) {
      truncated = true
      chunk = '\n… live output truncated (the complete output is shown when the run finishes) …\n'
      stream = 'stderr'
    }
    if (stream === 'stdout') stdout += chunk
    else stderr += chunk
    if (stdout.length + stderr.length > 64 * 1024) flush()
    else if (!timer) timer = setTimeout(flush, 40)
  }
  return {
    stdout: (chunk: string) => add('stdout', chunk),
    stderr: (chunk: string) => add('stderr', chunk),
    flush,
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    }
  }
}

function emptyRunResult(request: RunRequest, connectionId: string, started: number): RunResult {
  return {
    runId: request.runId,
    tabId: request.tabId,
    connectionId,
    phpVersion: '',
    driver: null,
    events: [],
    hasReturnValue: false,
    returnValue: null,
    magic: [],
    coverage: [],
    exception: null,
    diagnostics: [],
    bootMs: 0,
    durationMs: 0,
    memoryPeak: 0,
    ok: false,
    totalMs: Math.round(performance.now() - started),
    stderr: '',
    rawOutput: '',
    exitCode: null,
    finishedAt: Date.now()
  }
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Why no envelope came back, phrased for the user (exit code, PHP's own error output, parse state). */
export function explainMissingEnvelope(result: Pick<TransportResult, 'stderr' | 'exitCode'>, problem: string | undefined): string {
  const stderr = summarizeOutput(result.stderr, 500)
  if (problem === 'incomplete') return 'The PHP process stopped while reporting its result (the output was cut off).'
  if (problem?.startsWith('invalid-json')) return `The Tinkerbox runner returned an unreadable result (${problem.slice('invalid-json: '.length)}).`
  if (/Parse error/i.test(result.stderr) && /Standard input code/i.test(result.stderr)) {
    return `PHP could not compile the Tinkerbox runner (Tinkerbox needs PHP 7.4 or newer): ${stderr}`
  }
  const how = result.exitCode === null ? 'was terminated' : `exited with code ${result.exitCode}`
  return `PHP ${how} without reporting a result${stderr ? `: ${stderr}` : '.'}`
}

/** Combine the transport outcome and the decoded envelope into the renderer-facing result. */
export function buildRunResult(request: RunRequest, connectionId: string, transport: TransportResult, nonce: string, started: number): RunResult {
  const parsed = parseEnvelope<PhpEnvelope>(transport.stdout, nonce)
  const envelope = parsed.envelope && (parsed.envelope.mode === undefined || parsed.envelope.mode === 'run') ? parsed.envelope : null
  const result = emptyRunResult(request, connectionId, started)
  if (envelope) {
    result.phpVersion = typeof envelope.phpVersion === 'string' ? envelope.phpVersion : ''
    result.driver = (envelope.driver as DriverInfo | null) ?? null
    result.events = asArray(envelope.events)
    result.hasReturnValue = Boolean(envelope.hasReturnValue)
    result.returnValue = envelope.returnValue ?? null
    result.magic = asArray(envelope.magic)
    result.coverage = asArray(envelope.coverage)
    result.exception = envelope.exception ?? null
    result.diagnostics = asArray(envelope.diagnostics)
    result.bootMs = asNumber(envelope.bootMs)
    result.durationMs = asNumber(envelope.durationMs)
    result.memoryPeak = asNumber(envelope.memoryPeak)
    if (envelope.exited) result.exited = true
  }
  result.stderr = transport.stderr
  result.rawOutput = capRawOutput(parsed.outside)
  result.exitCode = transport.exitCode
  if (transport.cancelled) result.cancelled = true
  if (transport.timedOut) result.timedOut = true

  let error = transport.error
  if (!error && transport.cancelled) error = 'Execution cancelled.'
  if (!error && transport.timedOut) {
    error = `Execution timed out after ${Math.round(request.options.timeoutMs / 100) / 10}s. Increase the timeout in Settings → Output if the script needs more time.`
  }
  if (!error && !envelope) error = explainMissingEnvelope(transport, parsed.problem)
  if (error) result.error = error
  result.ok = envelope !== null && !envelope.exception && !error
  result.totalMs = Math.round(performance.now() - started)
  result.finishedAt = Date.now()
  return result
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

/**
 * Run user code in a fresh PHP process. Never rejects: configuration and process problems come back as
 * `ok: false` with an actionable `error` ("PHP binary not found: …", "Project directory not found: …").
 *
 * `signal` cancels the run like cancelRun() (the shell aborts it when the window that started the run closes or
 * reloads); an already aborted signal cancels before anything is spawned.
 */
export async function runCode(
  ctx: ExecutionContext,
  request: RunRequest,
  onProgress: (e: RunProgressEvent) => void,
  signal?: AbortSignal
): Promise<RunResult> {
  const started = performance.now()
  const controller = new AbortController()
  activeRuns.get(request.runId)?.abort()
  activeRuns.set(request.runId, controller)
  const abortFromCaller = (): void => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const progress = createProgressEmitter(request, onProgress)
  let connectionId = request.connectionId ?? ''
  try {
    const conn = await resolveTargetConnection(ctx, request.connectionId)
    connectionId = conn.id
    if (controller.signal.aborted) return { ...emptyRunResult(request, connectionId, started), cancelled: true, error: 'Execution cancelled.' }
    const nonce = newNonce()
    const payload = makePayload(conn, {
      nonce,
      mode: 'run',
      code: encodeCode(request.code),
      lineOffset: request.lineOffset && request.lineOffset > 0 ? Math.floor(request.lineOffset) : 1,
      options: request.options
    })
    const script = buildBundle(loadRunnerScript(ctx.resourcesPath), payload)
    const filter = new EnvelopeStreamFilter(nonce)
    const transport = await transportFor(conn).run({
      script,
      connection: conn,
      settings: ctx.getSettings(),
      timeoutMs: request.options.timeoutMs > 0 ? request.options.timeoutMs + TIMEOUT_GRACE_MS : 0,
      signal: controller.signal,
      onStdout: (chunk) => progress.stdout(filter.push(chunk)),
      onStderr: (chunk) => progress.stderr(chunk)
    })
    progress.stdout(filter.flush())
    progress.flush()
    return buildRunResult(request, connectionId, transport, nonce, started)
  } catch (err) {
    progress.flush()
    const result = emptyRunResult(request, connectionId, started)
    if (controller.signal.aborted) result.cancelled = true
    return { ...result, error: (err as Error).message }
  } finally {
    signal?.removeEventListener('abort', abortFromCaller)
    progress.dispose()
    if (activeRuns.get(request.runId) === controller) activeRuns.delete(request.runId)
  }
}

/** Stop a running script (kills the PHP process group). Unknown / finished run ids are ignored. */
export function cancelRun(runId: string): void {
  activeRuns.get(runId)?.abort()
}

export function activeRunIds(): string[] {
  return [...activeRuns.keys()]
}

// ---------------------------------------------------------------------------------------------
// Data modes
// ---------------------------------------------------------------------------------------------

async function runDataModeOn<T>(ctx: ExecutionContext, connection: Connection, mode: PhpDataMode, extra: Record<string, unknown> = {}): Promise<PhpDataEnvelope<T>> {
  // Data requests never start an Xdebug session (they would block on the IDE for every completion).
  const conn: Connection = { ...connection, debug: false }
  const settings = ctx.getSettings()
  const nonce = newNonce()
  const options = { ...runOptionsFromSettings(settings, false), magicComments: false, coverage: false, outputType: 'buffered' as const }
  const reserved = new Set(['nonce', 'mode', 'options'])
  const extras = Object.fromEntries(Object.entries(extra).filter(([k]) => !reserved.has(k))) as Partial<PhpPayload>
  const payload = makePayload(conn, { nonce, mode, options, ...extras })
  const script = buildBundle(loadRunnerScript(ctx.resourcesPath), payload)
  const transport = await transportFor(conn).run({
    script,
    connection: conn,
    settings,
    timeoutMs: DATA_MODE_TIMEOUT_MS,
    signal: new AbortController().signal,
    onStdout: () => {},
    onStderr: () => {}
  })
  const parsed = parseEnvelope<PhpDataEnvelope<T>>(transport.stdout, nonce)
  if (!parsed.envelope) {
    if (transport.error) throw new Error(transport.error)
    if (transport.timedOut) throw new Error(`The ${mode} request timed out after ${DATA_MODE_TIMEOUT_MS / 1000}s`)
    throw new Error(explainMissingEnvelope(transport, parsed.problem))
  }
  return parsed.envelope
}

/** Run a runner data mode on a connection and return the raw data envelope. */
export async function runDataMode<T>(ctx: ExecutionContext, connectionId: string | null, mode: PhpDataMode, extra?: Record<string, unknown>): Promise<PhpDataEnvelope<T>> {
  const conn = await resolveTargetConnection(ctx, connectionId)
  return runDataModeOn<T>(ctx, conn, mode, extra)
}

/** `data`, or an Error carrying the runner's message when the mode failed without data. */
function unwrap<T>(envelope: PhpDataEnvelope<T>, what: string): T {
  if (envelope.data === null || envelope.data === undefined) {
    throw new Error(envelope.error ? `${what}: ${envelope.error}` : `${what}: the runner returned no data`)
  }
  return envelope.data
}

/** Functions, classes, models… for autocompletion. Cached per connection for 10 minutes (`force` refreshes). */
export async function introspectEnvironment(ctx: ExecutionContext, req: IntrospectRequest): Promise<EnvironmentInfo> {
  const conn = await resolveTargetConnection(ctx, req.connectionId)
  return environmentCache.get(
    cacheKey(conn),
    async () => {
      const envelope = await runDataModeOn<EnvironmentInfo>(ctx, conn, 'environment')
      const info = unwrap(envelope, 'Environment introspection failed')
      return {
        ...info,
        phpVersion: info.phpVersion || envelope.phpVersion,
        driver: info.driver ?? envelope.driver ?? null,
        extensions: asArray(info.extensions),
        functions: asArray(info.functions),
        classes: asArray(info.classes),
        aliases: info.aliases && typeof info.aliases === 'object' && !Array.isArray(info.aliases) ? info.aliases : {},
        constants: asArray(info.constants),
        models: asArray(info.models),
        variables: asArray(info.variables)
      }
    },
    Boolean(req.force)
  )
}

/** Members of one class (facades / models resolved by the runner). Cached per connection + class. */
export async function introspectMembers(ctx: ExecutionContext, req: IntrospectRequest): Promise<ClassMembers | null> {
  const className = req.className?.trim().replace(/^\\+/, '')
  if (!className) return null
  const conn = await resolveTargetConnection(ctx, req.connectionId)
  return membersCache.get(
    `${cacheKey(conn)}|${className}`,
    async () => {
      const envelope = await runDataModeOn<ClassMembers | null>(ctx, conn, 'members', { className })
      if (envelope.error && (envelope.data === null || envelope.data === undefined)) throw new Error(`Class introspection failed: ${envelope.error}`)
      return envelope.data ?? null
    },
    Boolean(req.force)
  )
}

/** Panels modal: driver panels + Laravel "App Information". */
export async function projectPanels(ctx: ExecutionContext, connectionId: string | null): Promise<AppPanel[]> {
  const envelope = await runDataMode<AppPanel[]>(ctx, connectionId, 'panels')
  return asArray<AppPanel>(unwrap(envelope, 'Could not load the app panels'))
}

export async function listLogs(ctx: ExecutionContext, connectionId: string | null): Promise<LogListing> {
  const conn = await resolveTargetConnection(ctx, connectionId)
  if (!conn.path) return { root: '', files: [] } // plain PHP has no project logs
  const envelope = await runDataModeOn<LogListing>(ctx, conn, 'logs')
  const listing = unwrap(envelope, 'Could not list log files')
  return { root: typeof listing.root === 'string' ? listing.root : '', files: asArray(listing.files) }
}

export async function readLog(ctx: ExecutionContext, req: LogReadRequest): Promise<LogEntry[]> {
  const conn = await resolveTargetConnection(ctx, req.connectionId)
  const limit = req.limit > 0 ? Math.min(Math.floor(req.limit), 10_000) : 500
  const envelope = await runDataModeOn<LogEntry[]>(ctx, conn, 'logRead', { logFile: req.file, logLimit: limit })
  return asArray<LogEntry>(unwrap(envelope, `Could not read ${req.file}`))
}

interface RawProjectSnippet {
  name?: unknown
  description?: unknown
  code?: unknown
  file?: unknown
}

/** Snippet file relative to `.tinkerbox/snippets` (the stable id component). */
export function snippetFileKey(file: string): string {
  const normalized = file.replace(/\\/g, '/')
  const marker = '/.tinkerbox/snippets/'
  const i = normalized.lastIndexOf(marker)
  return i === -1 ? normalized.replace(/^(\.\/)+/, '').replace(/^\/+/, '') : normalized.slice(i + marker.length)
}

/**
 * Project snippets from `<project>/.tinkerbox/snippets/*.php` (read-only, source 'project'), parsed by the
 * runner's snippets mode (`@label` / `@description` docblock tags). Ids: `project:<connId>:<file>`.
 */
export async function projectSnippets(ctx: ExecutionContext, connectionId: string | null): Promise<Snippet[]> {
  const conn = await resolveTargetConnection(ctx, connectionId)
  if (conn.id === SCRATCH_CONNECTION_ID || !conn.path) return []
  const snippetsDir = join(expandHome(conn.path), '.tinkerbox', 'snippets')
  // Fast path: no snippets folder → no PHP process.
  try {
    if (!(await readdir(snippetsDir)).some((f) => f.endsWith('.php'))) return []
  } catch {
    return []
  }
  const envelope = await runDataModeOn<RawProjectSnippet[]>(ctx, conn, 'snippets')
  const raw = asArray<RawProjectSnippet>(unwrap(envelope, 'Could not read project snippets'))
  const out: Snippet[] = []
  for (const item of raw) {
    if (!item || typeof item.code !== 'string') continue
    const file = typeof item.file === 'string' && item.file ? item.file : typeof item.name === 'string' ? `${item.name}.php` : ''
    const key = snippetFileKey(file)
    if (!key) continue
    let mtime = 0
    try {
      mtime = Math.round((await stat(join(snippetsDir, key))).mtimeMs)
    } catch {
      /* the runner may report a name that is not a file path; timestamps stay 0 */
    }
    const snippet: Snippet = {
      id: `project:${conn.id}:${key}`,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : key.replace(/\.php$/, ''),
      code: item.code,
      connectionId: conn.id,
      source: 'project',
      createdAt: mtime,
      updatedAt: mtime
    }
    if (typeof item.description === 'string' && item.description.trim()) snippet.description = item.description.trim()
    out.push(snippet)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------------------------

interface DetectData {
  driver?: DriverInfo | null
  phpVersionLine?: string
}

/** Run the runner's detect mode for a (possibly unsaved) connection and report PHP + framework. */
export async function testConnection(ctx: ExecutionContext, connection: Connection): Promise<ConnectionTestResult> {
  const started = performance.now()
  const elapsed = (): number => Math.round(performance.now() - started)
  try {
    const implicit = connection.id === SANDBOX_CONNECTION_ID || connection.id === SCRATCH_CONNECTION_ID
    const conn = implicit && !connection.path ? await resolveTargetConnection(ctx, connection.id) : normalizeConnection(connection)
    const envelope = await runDataModeOn<DetectData>(ctx, conn, 'detect')
    const driver = envelope.data?.driver ?? envelope.driver ?? null
    const php = envelope.phpVersion ? `PHP ${envelope.phpVersion}` : (envelope.data?.phpVersionLine ?? '')
    const framework = driver?.appVersion || (driver && driver.id !== 'none' ? driver.name : '')
    const result: ConnectionTestResult = {
      ok: !envelope.error,
      message: envelope.error ? `PHP ran, but the project failed to boot: ${envelope.error}` : [php, framework].filter(Boolean).join(' · ') || 'PHP is working',
      driver,
      durationMs: elapsed()
    }
    if (envelope.phpVersion) result.phpVersion = envelope.phpVersion
    return result
  } catch (err) {
    return { ok: false, message: (err as Error).message, durationMs: elapsed() }
  }
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

/** Drop cached introspection (all, or for one connection whose settings changed). */
export function invalidateCaches(connectionId?: string): void {
  if (connectionId === undefined) {
    environmentCache.clear()
    membersCache.clear()
    return
  }
  const prefix = `${connectionId}|`
  environmentCache.deleteWhere((k) => k.startsWith(prefix))
  membersCache.deleteWhere((k) => k.startsWith(prefix))
}

/** App shutdown: cancel runs and kill every PHP process group. */
export function disposeExecution(): void {
  for (const controller of activeRuns.values()) controller.abort()
  activeRuns.clear()
  killAllProcesses('SIGKILL')
  environmentCache.clear()
  membersCache.clear()
}
