/**
 * Wave A integration: the REAL main-process execution layer (src/main/execution: bundle → local transport →
 * envelope → RunResult) running the REAL PHP runner (resources/php) through Herd PHP, with an ExecutionContext
 * assembled exactly like src/main/index.ts does it — SettingsStore + ConnectionsStore persisted in a temp userData
 * folder, createConnectionResolver() and the sandbox helpers, resources = <repo>/resources. No Electron.
 *
 * The Laravel tests use the project in TINKERBOX_TEST_LARAVEL strictly read-only: only side-effect-free code runs,
 * the process environment points the default database at in-memory SQLite and logging at stderr, and
 * the project's bootstrap/cache, database and storage/logs folders are verified unchanged afterwards.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runOptionsFromSettings } from '@shared/defaults'
import type { Connection, DumpNode, OutputEvent, RunOptions, RunRequest, RunResult } from '@shared/types'
import { SCRATCH_CONNECTION_ID } from '@shared/types'
import {
  activeRunIds,
  cancelRun,
  detectLocalProject,
  introspectEnvironment,
  introspectMembers,
  listLogs,
  projectPanels,
  readLog,
  runCode,
  runDataMode,
  testConnection
} from '../../../src/main/execution'
import type { ExecutionContext } from '../../../src/main/execution/types'
import { createConnectionResolver } from '../../../src/main/ipc/connectionResolver'
import { resolveAppPaths } from '../../../src/main/paths'
import { isSandboxAvailable, sandboxPathSync } from '../../../src/main/sandbox'
import { ConnectionsStore } from '../../../src/main/store/connections'
import { SecretBox, unavailableCipher } from '../../../src/main/store/secrets'
import { SettingsStore } from '../../../src/main/store/settings'
import { cleanupTempDirs, hasHerdPhp, herdBin, makeTempDir, repoRoot } from '../execution/helpers'

const LARAVEL_PROJECT = process.env.TINKERBOX_TEST_LARAVEL ?? ''
const hasLaravel = hasHerdPhp && LARAVEL_PROJECT !== '' && existsSync(join(LARAVEL_PROJECT, 'artisan')) && existsSync(join(LARAVEL_PROJECT, 'vendor', 'autoload.php'))
const php74 = join(herdBin, 'php74')
const hasPhp74 = hasHerdPhp && existsSync(php74)

const silent = { info: () => {}, warn: () => {}, error: () => {} }

interface Shell {
  ctx: ExecutionContext
  settings: SettingsStore
  connections: ConnectionsStore
}

/** The stores + ExecutionContext of src/main/index.ts, persisted in a temp userData folder. */
function createShell(): Shell {
  const paths = resolveAppPaths({ userData: makeTempDir('tw-int-userdata-'), appPath: repoRoot, isPackaged: false, processResourcesPath: repoRoot })
  const box = new SecretBox(unavailableCipher, undefined, silent)
  const settings = new SettingsStore(paths.files.settings, box, { logger: silent, debounceMs: 0 })
  const connections = new ConnectionsStore(paths.files.connections, { logger: silent, debounceMs: 0 })
  const sandboxCtx = { resourcesPath: paths.resources, userDataPath: paths.userData, getSettings: () => settings.get() }
  const resolveConnection = createConnectionResolver({
    connections,
    settings: () => settings.get(),
    sandbox: () => ({ installed: isSandboxAvailable(sandboxCtx), path: sandboxPathSync(sandboxCtx) })
  })
  const ctx: ExecutionContext = {
    getSettings: () => settings.get(),
    resolveConnection,
    resourcesPath: paths.resources,
    userDataPath: paths.userData
  }
  return { ctx, settings, connections }
}

let counter = 0
interface RequestExtras extends Partial<Omit<RunRequest, 'options'>> {
  options?: Partial<RunOptions>
  captureQueries?: boolean
}

function request(shell: Shell, code: string, extra: RequestExtras = {}): RunRequest {
  const { options, captureQueries, ...rest } = extra
  counter++
  return {
    runId: `int-${process.pid}-${counter}`,
    tabId: 'tab-int',
    connectionId: SCRATCH_CONNECTION_ID,
    code,
    ...rest,
    // The renderer derives run options from the settings like this (tabs store → runs:start).
    options: { ...runOptionsFromSettings(shell.settings.get(), captureQueries ?? false), ...options }
  }
}

const run = (shell: Shell, code: string, extra: RequestExtras = {}): Promise<RunResult> =>
  runCode(shell.ctx, request(shell, code, extra), () => {})

const echoes = (result: RunResult): Array<Extract<OutputEvent, { kind: 'echo' }>> =>
  result.events.filter((e): e is Extract<OutputEvent, { kind: 'echo' }> => e.kind === 'echo')

const dumps = (result: RunResult): Array<Extract<OutputEvent, { kind: 'dump' }>> =>
  result.events.filter((e): e is Extract<OutputEvent, { kind: 'dump' }> => e.kind === 'dump')

const queries = (result: RunResult): Array<Extract<OutputEvent, { kind: 'query' }>> =>
  result.events.filter((e): e is Extract<OutputEvent, { kind: 'query' }> => e.kind === 'query')

/** Scalar value of a dump node (`int` / `string` / `bool` / `float`), for compact assertions. */
function scalar(node: DumpNode | null | undefined): unknown {
  if (!node) return undefined
  switch (node.t) {
    case 'int':
      return Number(node.v)
    case 'float':
      return Number(node.v)
    case 'string':
    case 'bool':
      return node.v
    case 'null':
      return null
    default:
      return node
  }
}

afterAll(cleanupTempDirs)

describe.skipIf(!hasHerdPhp)('integration: real execution layer + real runner (plain PHP)', () => {
  const shell = createShell()

  it('(a) scratch run: return value, echo event, magic comment and coverage on editor lines', async () => {
    const result = await run(shell, "$a = [1,2,3];\necho 'hi';\narray_sum($a); //?", { options: { coverage: true, magicComments: true } })
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.connectionId).toBe(SCRATCH_CONNECTION_ID)
    expect(result.driver?.id).toBe('none')
    expect(result.phpVersion).toMatch(/^\d+\.\d+\.\d+/)

    expect(result.hasReturnValue).toBe(true)
    expect(result.returnValue).toEqual({ t: 'int', v: '6' })

    const echo = echoes(result)
    expect(echo).toHaveLength(1)
    expect(echo[0]).toMatchObject({ kind: 'echo', text: 'hi', line: 2 })

    expect(result.magic).toHaveLength(1)
    expect(result.magic[0]).toMatchObject({ line: 3, type: 'value', hits: 1, value: { t: 'int', v: '6' } })
    expect(result.magic[0].preview).toBe('6')

    expect(result.coverage).toEqual(expect.arrayContaining([1, 2, 3]))
    expect(result.exception).toBeNull()
    expect(result.exited).toBeUndefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.memoryPeak).toBeGreaterThan(0)
    expect(result.totalMs).toBeGreaterThan(0)
    expect(result.rawOutput).toBe('')
    expect(result.exitCode).toBe(0)
  })

  it('(c) maps exceptions to editor lines with a code snippet and a user-code trace', async () => {
    const code = [
      '$x = 41;', //                                         1
      'function explode_on(int $v): void', //                2
      '{', //                                                3
      '    throw new InvalidArgumentException("bad {$v}");', // 4
      '}', //                                                5
      'explode_on($x + 1);' //                               6
    ].join('\n')
    const result = await run(shell, code)
    expect(result.ok).toBe(false)
    expect(result.error).toBeUndefined()
    const ex = result.exception!
    expect(ex).toMatchObject({ class: 'InvalidArgumentException', message: 'bad 42', userLine: 4 })
    expect(ex.fatal).toBeFalsy()
    expect(ex.bootstrap).toBeFalsy()
    expect(ex.snippet?.line).toBe(4)
    const snippetLines = ex.snippet!.lines
    expect(snippetLines[4 - ex.snippet!.startLine]).toContain('throw new InvalidArgumentException')
    // The call site of the user function is a user-code frame on editor line 6.
    expect(ex.trace.some((f) => f.userCode && f.line === 6)).toBe(true)

    const parse = await run(shell, "$a = 1;\n$b = ;\n$a;")
    expect(parse.ok).toBe(false)
    expect(parse.exception).toMatchObject({ class: 'ParseError', userLine: 2 })
  })

  it('(d) selection runs report editor lines through lineOffset', async () => {
    // Lines 10-13 of a larger editor buffer were selected.
    const selection = ["echo 'selected';", '$n = 20 + 1; //?', 'dump($n);', "throw new RuntimeException('in selection');"].join('\n')
    const result = await run(shell, selection, { lineOffset: 10, options: { coverage: true } })
    expect(echoes(result)[0]).toMatchObject({ text: 'selected', line: 10 })
    expect(result.magic[0]).toMatchObject({ line: 11, value: { t: 'int', v: '21' } })
    expect(dumps(result)[0]).toMatchObject({ line: 12, value: { t: 'int', v: '21' } })
    expect(result.exception).toMatchObject({ class: 'RuntimeException', message: 'in selection', userLine: 13 })
    expect(result.coverage).toEqual(expect.arrayContaining([10, 11, 12, 13]))
    expect(Math.min(...result.coverage)).toBeGreaterThanOrEqual(10)
  })

  it('(e) timeouts: PHP time limit inside the script, wall-clock kill outside it', async () => {
    // CPU-bound / sleeping PHP code hits the runner's set_time_limit(ceil(timeoutMs / 1000)) first: one envelope
    // with a fatal "Maximum execution time" error on the editor line.
    const limited = await run(shell, "echo 'before';\nwhile (true) { usleep(1000); }", { options: { timeoutMs: 1000 } })
    expect(limited.ok).toBe(false)
    if (limited.exception) {
      expect(limited.exception).toMatchObject({ class: 'FatalError', fatal: true, userLine: 2 })
      expect(limited.exception.message).toContain('Maximum execution time')
      expect(echoes(limited).map((e) => e.text)).toEqual(['before'])
    } else {
      expect(limited.timedOut).toBe(true) // platforms where the limit does not count the waits
    }

    // Time spent in an external program does not count towards PHP's limit: the main process kills the whole
    // process group after timeoutMs + grace.
    const marker = `sleep 31.${process.pid}`
    const started = Date.now()
    const result = await run(shell, `echo 'before';\nshell_exec('${marker}');`, { options: { timeoutMs: 1000 } })
    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timed out after 1s/)
    expect(Date.now() - started).toBeLessThan(8000)
    expect(activeRunIds()).not.toContain(result.runId)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim()).toBe('')
  })

  it('(e) cancel stops a running script and its child processes', async () => {
    const marker = `sleep 41.${process.pid}`
    const req = request(shell, `echo 'started';\nshell_exec('${marker}');\n'never';`)
    const started = Date.now()
    setTimeout(() => cancelRun(req.runId), 500)
    const result = await runCode(shell.ctx, req, () => {})
    expect(result.cancelled).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Execution cancelled.')
    expect(Date.now() - started).toBeLessThan(5000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim()).toBe('')

    // The same tab can run again right away.
    const again = await run(shell, '1 + 1;')
    expect(again.ok).toBe(true)
    expect(again.returnValue).toEqual({ t: 'int', v: '2' })
  })

  it('(g) runs scratch code with the Herd php74 binary chosen for the scratch connection', async () => {
    if (!hasPhp74) return
    shell.connections.save({ id: SCRATCH_CONNECTION_ID, type: 'local', path: '', name: 'PHP', phpBinary: php74 })
    try {
      const code = "$items = array_map(function ($n) { return $n * 2; }, [1, 2, 3]);\necho PHP_VERSION;\narray_sum($items); //?"
      const result = await run(shell, code, { options: { coverage: true } })
      expect(result.error).toBeUndefined()
      expect(result.ok).toBe(true)
      expect(result.phpVersion).toMatch(/^7\.4\./)
      expect(echoes(result)[0]).toMatchObject({ line: 2 })
      expect(echoes(result)[0].text).toMatch(/^7\.4\./)
      expect(result.returnValue).toEqual({ t: 'int', v: '12' })
      expect(result.magic[0]).toMatchObject({ line: 3, value: { t: 'int', v: '12' } })
      // PCRE JIT warnings of Herd's 7.4 build never reach the user.
      expect(result.diagnostics.filter((d) => /jit/i.test(d.message))).toEqual([])

      const tested = await testConnection(shell.ctx, shell.ctx.resolveConnection(SCRATCH_CONNECTION_ID))
      expect(tested.ok).toBe(true)
      expect(tested.phpVersion).toMatch(/^7\.4\./)
    } finally {
      shell.connections.delete(SCRATCH_CONNECTION_ID)
    }
    const back = await run(shell, 'PHP_MAJOR_VERSION;')
    expect(back.returnValue).not.toEqual({ t: 'int', v: '7' })
  })

  it('(h) dd() and exit produce exactly one envelope with the output collected so far', async () => {
    const dd = await run(shell, "echo 'one';\ndd(['a' => 1], 'two');\necho 'never';")
    expect(dd.error).toBeUndefined()
    expect(dd.exited).toBe(true)
    expect(dd.exception).toBeNull()
    expect(echoes(dd).map((e) => e.text)).toEqual(['one'])
    const ddDumps = dumps(dd)
    expect(ddDumps).toHaveLength(2)
    expect(ddDumps[0]).toMatchObject({ line: 2, value: { t: 'array', count: 1 } })
    expect(scalar(ddDumps[1].value)).toBe('two')
    expect(dd.rawOutput).not.toContain('never')

    const exit = await run(shell, "echo 'bye';\nexit(3);\necho 'never';")
    expect(exit.error).toBeUndefined()
    expect(exit.exited).toBe(true)
    expect(echoes(exit).map((e) => e.text)).toEqual(['bye'])
    expect(exit.hasReturnValue).toBe(false)
    expect(exit.exitCode).toBe(3)

    const die = await run(shell, "die('stopped');")
    expect(die.exited).toBe(true)
    expect(echoes(die).map((e) => e.text).join('')).toContain('stopped')
  })

  it('reports PHP fatal errors (uncatchable) once with the editor line', async () => {
    const result = await run(shell, "$a = 1;\nundefined_function_xyz();")
    expect(result.ok).toBe(false)
    expect(result.exception).toMatchObject({ class: 'Error', userLine: 2 })
    expect(result.exception?.message).toContain('undefined_function_xyz')
  })
})

/** File list + size + mtime below a project's writable folders (to prove the Laravel runs wrote nothing). */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const path = join(dir, name)
      const st = statSync(path)
      if (st.isDirectory()) {
        if (depth < 6) walk(path, depth + 1)
      } else {
        out[path] = `${st.size}:${st.mtimeMs}`
      }
    }
  }
  for (const sub of ['bootstrap/cache', 'database', 'storage/logs', '.env']) {
    const path = join(root, sub)
    if (!existsSync(path)) continue
    if (statSync(path).isDirectory()) walk(path, 0)
    else out[path] = `${statSync(path).size}:${statSync(path).mtimeMs}`
  }
  return out
}

describe.skipIf(!hasLaravel)('integration: real execution layer on a local Laravel project (read-only)', () => {
  const shell = createShell()
  let project: Connection
  let before: Record<string, string>
  const savedEnv: Record<string, string | undefined> = {}
  /** Keep the project's real database, cache, session and log files out of reach of the child processes. */
  const overrides: Record<string, string> = {
    DB_CONNECTION: 'sqlite',
    DB_DATABASE: ':memory:',
    DB_URL: '',
    // Not 'null': Laravel's env() turns the string "null" into null (→ default channel / explode() deprecations).
    LOG_CHANNEL: 'stderr',
    CACHE_STORE: 'array',
    CACHE_DRIVER: 'array',
    SESSION_DRIVER: 'array',
    QUEUE_CONNECTION: 'sync',
    MAIL_MAILER: 'array'
  }

  beforeAll(() => {
    for (const [key, value] of Object.entries(overrides)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
    before = snapshot(LARAVEL_PROJECT)
    project = shell.connections.openLocal(LARAVEL_PROJECT)
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('sniffs the folder as a Laravel project without PHP', async () => {
    expect((await detectLocalProject(LARAVEL_PROJECT)).driver).toBe('laravel')
    expect(project.id).toMatch(/^local-[0-9a-f]{16}$/)
    expect(shell.ctx.resolveConnection(project.id).path).toBe(LARAVEL_PROJECT)
  })

  it('(b) boots the project: app()->version(), driver info, query capture, config', async () => {
    const code = [
      'app()->version();', // 1
      "config(['database.connections.tw_memory' => ['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '']]);", // 2
      "$db = DB::connection('tw_memory');", // 3
      "$db->select('select ? as answer', [42]);", // 4
      "$db->table('sqlite_master')->where('type', 'table')->count();", // 5
      "[config('app.name'), app()->environment(), $db->getDriverName()];" // 6
    ].join('\n')
    const result = await run(shell, code, { connectionId: project.id, captureQueries: true })
    expect(result.error).toBeUndefined()
    expect(result.exception).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.connectionId).toBe(project.id)
    expect(result.driver).toMatchObject({ id: 'laravel', name: 'Laravel' })
    expect(result.driver?.appVersion).toMatch(/^Laravel \d+\.\d+\.\d+/)
    expect(result.bootMs).toBeGreaterThan(0)
    expect(result.rawOutput).toBe('')
    expect(result.diagnostics).toEqual([])

    const captured = queries(result)
    expect(captured.length).toBeGreaterThanOrEqual(2)
    expect(captured[0]).toMatchObject({ sql: 'select ? as answer', bindings: ['42'], rawSql: 'select 42 as answer', connection: 'tw_memory', line: 4 })
    expect(captured[0].timeMs).toBeGreaterThanOrEqual(0)
    expect(captured[1]).toMatchObject({ connection: 'tw_memory', line: 5 })
    expect(captured[1].sql).toContain('sqlite_master')

    expect(result.returnValue?.t).toBe('array')
    const items = result.returnValue?.t === 'array' ? result.returnValue.items : []
    expect(items.map((item) => scalar(item.v))).toEqual([expect.any(String), expect.any(String), 'sqlite'])

    const version = await run(shell, 'app()->version();', { connectionId: project.id })
    expect(version.ok).toBe(true)
    expect(`Laravel ${String(scalar(version.returnValue))}`).toBe(result.driver?.appVersion)
  })

  it('(c) a fatal error inside the booted app is reported once, without the framework re-rendering it', async () => {
    const code = "echo 'before';\nini_set('memory_limit', '64M');\n$s = str_repeat('x', 96 * 1024 * 1024);"
    const result = await run(shell, code, { connectionId: project.id })
    expect(result.ok).toBe(false)
    expect(result.error).toBeUndefined()
    expect(result.exception).toMatchObject({ class: 'FatalError', fatal: true, userLine: 3 })
    expect(result.exception?.message).toContain('Allowed memory size')
    expect(result.exception?.snippet?.line).toBe(3)
    expect(echoes(result).map((e) => e.text)).toEqual(['before'])
    // Laravel's HandleExceptions / Collision shutdown renderer and its log reporter never run after the envelope.
    expect(result.rawOutput).toBe('')
    expect(result.stderr).not.toContain('local.ERROR')
    expect(result.exitCode).toBe(255)
  })

  it('(b) environment introspection and members("DB")', async () => {
    const env = await introspectEnvironment(shell.ctx, { connectionId: project.id, force: true })
    expect(env.driver).toMatchObject({ id: 'laravel' })
    expect(env.phpVersion).toMatch(/^8\./)
    expect(env.extensions.length).toBeGreaterThan(5)
    expect(env.functions.some((f) => f.name === 'collect')).toBe(true)
    expect(env.classes).toEqual(expect.arrayContaining(['Illuminate\\Support\\Collection']))
    expect(env.aliases.DB).toBe('Illuminate\\Support\\Facades\\DB')
    expect(env.variables.map((v) => v.name)).toContain('app')
    expect(Array.isArray(env.models)).toBe(true)

    const db = await introspectMembers(shell.ctx, { connectionId: project.id, className: 'DB', force: true })
    expect(db).not.toBeNull()
    const names = db!.members.map((m) => m.name)
    expect(names).toEqual(expect.arrayContaining(['table', 'select', 'connection', 'transaction']))
    const table = db!.members.find((m) => m.name === 'table')!
    expect(table.kind).toBe('method')
    expect(table.static).toBe(true)
    expect(table.signature).toContain('$table')
  })

  it('(f) logs, log entries and panels data modes', async () => {
    const listing = await listLogs(shell.ctx, project.id)
    expect(listing.root).toBe(join(LARAVEL_PROJECT, 'storage', 'logs'))
    const laravelLog = listing.files.find((f) => f.name === 'laravel.log')
    if (existsSync(join(LARAVEL_PROJECT, 'storage', 'logs', 'laravel.log'))) {
      expect(laravelLog).toMatchObject({ path: 'laravel.log', dir: '' })
      const entries = await readLog(shell.ctx, { connectionId: project.id, file: laravelLog!.path, limit: 3 })
      expect(entries.length).toBeLessThanOrEqual(3)
      for (const entry of entries) {
        expect(typeof entry.datetime).toBe('string')
        expect(typeof entry.level).toBe('string')
        expect(typeof entry.message).toBe('string')
      }
    }

    const panels = await projectPanels(shell.ctx, project.id)
    expect(panels.length).toBeGreaterThan(0)
    const rows = panels.flatMap((p) => p.sections.flatMap((s) => s.rows))
    expect(rows.length).toBeGreaterThan(3)
    const laravelVersion = rows.find((r) => r.key === 'Laravel Version')
    expect(laravelVersion?.value).toMatch(/^\d+\.\d+\.\d+/)
    expect(rows.some((r) => r.key === 'PHP Version')).toBe(true)

    const detect = await runDataMode<{ driver: { id: string; appVersion?: string }; phpVersionLine: string }>(shell.ctx, project.id, 'detect')
    expect(detect.data?.driver).toMatchObject({ id: 'laravel' })
    expect(detect.data?.phpVersionLine).toMatch(/^PHP \d/)
  })

  it('left the project untouched', () => {
    expect(snapshot(LARAVEL_PROJECT)).toEqual(before)
  })
})
