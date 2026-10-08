/**
 * Local transport: `spawn(php, flags, { cwd: path || tmpdir, env: + Herd ini dirs })` with the bundle on
 * stdin. Streams stdout/stderr, honors the timeout and cancellation (process-group kill, see process.ts).
 */
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expandHome } from '../env/which'
import { resolvePhpBinary } from '../php/binaries'
import { herdVersionDigits, herdXdebugExtension } from '../php/herd'
import { phpFlags } from './argv'
import { DEFAULT_MAX_OUTPUT_BYTES, spawnStreaming } from './process'
import type { Transport, TransportRequest, TransportResult } from './transport'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Xdebug flags for a binary: Herd's bundled extension is loaded when its php.ini does not load one. */
export function localPhpArgs(php: string, debug: boolean): string[] {
  if (!debug) return phpFlags()
  const digits = herdVersionDigits(php)
  const xdebugExtension = (digits && herdXdebugExtension(digits)) || undefined
  return phpFlags({ debug: true, xdebugExtension })
}

export const localTransport: Transport = {
  id: 'local',

  supports: (connection) => connection.type === 'local',

  async run(req: TransportRequest): Promise<TransportResult> {
    const projectDir = req.connection.path ? expandHome(req.connection.path) : ''
    if (projectDir && !isDirectory(projectDir)) throw new Error(`Project directory not found: ${projectDir}`)
    const { path: php, env } = await resolvePhpBinary(req.settings, req.connection)
    const result = await spawnStreaming(
      {
        command: php,
        args: localPhpArgs(php, Boolean(req.connection.debug)),
        cwd: projectDir || tmpdir(),
        env: { ...process.env, ...env }
      },
      {
        input: req.script,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        onStdout: req.onStdout,
        onStderr: req.onStderr
      }
    )
    if (result.spawnError) {
      const code = result.spawnError.code
      if (code === 'ENOENT') throw new Error(`PHP binary not found: ${php}`)
      if (code === 'EACCES') throw new Error(`PHP binary is not executable: ${php}`)
      throw new Error(`Could not start PHP (${php}): ${result.spawnError.message}`)
    }
    const out: TransportResult = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled
    }
    if (result.outputLimitExceeded) {
      out.error = `Output limit exceeded (${Math.round(DEFAULT_MAX_OUTPUT_BYTES / 1048576)} MB); the PHP process was stopped.`
    }
    return out
  }
}
