import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Connection, RunOptions, RunRequest, Settings } from '@shared/types'
import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID } from '@shared/types'
import type { ExecutionContext } from '../../../src/main/execution/types'

export const repoRoot = resolve(__dirname, '../../..')
export const herdBin = join(homedir(), 'Library', 'Application Support', 'Herd', 'bin')
/** Herd PHP 8.3 on the development machine (tests needing a real PHP are skipped without it). */
export const herdPhp83 = join(herdBin, 'php83')
export const hasHerdPhp = process.platform === 'darwin' && existsSync(herdPhp83)

const tempDirs: string[] = []

export function makeTempDir(prefix = 'tw-exec-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** Create files below `root` from a `{ relativePath: content }` map. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

export function localConnection(id: string, path: string, extra: Partial<Connection> = {}): Connection {
  return { id, name: id, type: 'local', path, createdAt: 0, ...extra }
}

export interface FakeContextOptions {
  settings?: Partial<Settings>
  connections?: Record<string, Connection>
  userDataPath?: string
  resourcesPath?: string
}

/** ExecutionContext like E2 builds it: implicit sandbox/scratch handled, saved connections by id. */
export function fakeContext(options: FakeContextOptions = {}): ExecutionContext {
  const settings: Settings = { ...DEFAULT_SETTINGS, phpBinary: hasHerdPhp ? herdPhp83 : 'auto', ...options.settings }
  const userDataPath = options.userDataPath ?? makeTempDir('tw-userdata-')
  return {
    getSettings: () => settings,
    resolveConnection: (id) => {
      if (id === null || id === SCRATCH_CONNECTION_ID) return localConnection(SCRATCH_CONNECTION_ID, '')
      if (id === SANDBOX_CONNECTION_ID) return localConnection(SANDBOX_CONNECTION_ID, '')
      const conn = options.connections?.[id]
      if (!conn) throw new Error(`The connection "${id}" no longer exists.`)
      return conn
    },
    resourcesPath: options.resourcesPath ?? repoRoot,
    userDataPath
  }
}

export function runOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    maxDepth: 6,
    maxItems: 250,
    maxStringLength: 10000,
    captureQueries: false,
    magicComments: true,
    coverage: false,
    strictTypes: false,
    outputType: 'buffered',
    timeoutMs: 20000,
    ...overrides
  }
}

let runCounter = 0
export function runRequest(code: string, overrides: Partial<RunRequest> = {}): RunRequest {
  runCounter++
  return { runId: `run-${process.pid}-${runCounter}`, tabId: 'tab-1', connectionId: SCRATCH_CONNECTION_ID, code, options: runOptions(), ...overrides }
}
