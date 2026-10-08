/**
 * Child-process plumbing shared by the local transport, the sandbox installer and the PHP binary
 * discovery helpers: streaming stdout/stderr, stdin input, timeouts, cancellation and process-group kill.
 *
 * On POSIX every child is spawned `detached` so it leads its own process group; terminating kills the
 * whole group (`process.kill(-pid)`), which also stops grandchildren started by user code
 * (`shell_exec('sleep 100')`). SIGTERM is escalated to SIGKILL after a grace period. Windows uses
 * `taskkill /T /F`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export interface SpawnSpec {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Run through the platform shell (custom runtime commands). */
  shell?: boolean
  windowsVerbatimArguments?: boolean
}

export interface StreamOptions {
  /** Written to stdin, which is then closed. */
  input?: string | Buffer
  /** Wall-clock limit; 0 / undefined => none. */
  timeoutMs?: number
  signal?: AbortSignal
  onStdout?(chunk: string): void
  onStderr?(chunk: string): void
  /** Kill the process once stdout + stderr exceed this many bytes (default 100 MB). */
  maxOutputBytes?: number
  /** Delay between SIGTERM and SIGKILL (default 2000 ms). */
  killGraceMs?: number
}

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
  outputLimitExceeded: boolean
  /** Spawn failure (ENOENT, EACCES…): the process never ran. */
  spawnError?: NodeJS.ErrnoException
}

export const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024
const CLOSE_AFTER_EXIT_MS = 1000

const liveChildren = new Set<ChildProcess>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Last line of defence when the app quits without disposeExecution(): detached process groups
  // would otherwise outlive Tinkerbox. Only synchronous work is possible here.
  process.once('exit', () => {
    for (const child of liveChildren) killProcessTree(child, 'SIGKILL')
  })
}

/** Send `signal` to the child's whole process tree. Never throws. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {
        // taskkill unavailable: fall back to killing the direct child only.
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      })
    } catch {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // Not a group leader (should not happen with detached) or the group is gone: kill the child itself.
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

function processGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/** Terminate every running child (used by disposeExecution). */
export function killAllProcesses(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const child of liveChildren) killProcessTree(child, signal)
}

export function liveProcessCount(): number {
  return liveChildren.size
}

/** Spawn a process, stream its output and resolve when it is done. Never rejects. */
export function spawnStreaming(spec: SpawnSpec, options: StreamOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const base: ProcessResult = {
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputLimitExceeded: false
    }
    if (options.signal?.aborted) {
      resolve({ ...base, cancelled: true })
      return
    }

    let child: ChildProcess
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        shell: spec.shell ?? false,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({ ...base, spawnError: err as NodeJS.ErrnoException })
      return
    }
    liveChildren.add(child)
    installExitHook()

    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const graceMs = options.killGraceMs ?? 2000
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const stdoutParts: string[] = []
    const stderrParts: string[] = []
    let bytes = 0
    let exited = false
    let settled = false
    let terminating = false
    let spawnError: NodeJS.ErrnoException | undefined
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let timedOut = false
    let cancelled = false
    let outputLimitExceeded = false
    let timeoutTimer: NodeJS.Timeout | undefined
    let closeFallbackTimer: NodeJS.Timeout | undefined

    const terminate = (): void => {
      if (terminating) return
      terminating = true
      killProcessTree(child, 'SIGTERM')
      const pid = child.pid
      const escalate = setTimeout(() => {
        // Escalate when the leader survived SIGTERM or other group members (grandchildren) still run.
        if (!exited || (pid !== undefined && processGroupAlive(pid))) killProcessTree(child, 'SIGKILL')
      }, graceMs)
      escalate.unref()
    }

    const onAbort = (): void => {
      if (settled) return
      cancelled = true
      terminate()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        terminate()
      }, options.timeoutMs)
    }

    const account = (size: number): boolean => {
      bytes += size
      if (bytes > maxBytes) {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true
          terminate()
        }
        return false
      }
      return true
    }

    child.stdout?.on('data', (buf: Buffer) => {
      if (!account(buf.length)) return
      const text = stdoutDecoder.write(buf)
      if (text) {
        stdoutParts.push(text)
        options.onStdout?.(text)
      }
    })
    child.stderr?.on('data', (buf: Buffer) => {
      if (!account(buf.length)) return
      const text = stderrDecoder.write(buf)
      if (text) {
        stderrParts.push(text)
        options.onStderr?.(text)
      }
    })
    // EPIPE when the process exits (or was never started) before reading all of its input.
    child.stdin?.on('error', () => {})

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (closeFallbackTimer) clearTimeout(closeFallbackTimer)
      options.signal?.removeEventListener('abort', onAbort)
      liveChildren.delete(child)
      const restOut = stdoutDecoder.end()
      if (restOut) {
        stdoutParts.push(restOut)
        options.onStdout?.(restOut)
      }
      const restErr = stderrDecoder.end()
      if (restErr) {
        stderrParts.push(restErr)
        options.onStderr?.(restErr)
      }
      // A grandchild may still hold the pipes open (close fallback): stop reading them.
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({
        stdout: stdoutParts.join(''),
        stderr: stderrParts.join(''),
        exitCode,
        signal: exitSignal,
        timedOut,
        cancelled,
        outputLimitExceeded,
        spawnError
      })
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      // Spawn failures (ENOENT…) or kill failures; only the former means the process never ran.
      if (child.pid === undefined) spawnError = err
      if (child.pid === undefined || exited) finish()
    })
    child.on('exit', (code, sig) => {
      exited = true
      exitCode = code
      exitSignal = sig
      closeFallbackTimer = setTimeout(finish, CLOSE_AFTER_EXIT_MS)
    })
    child.on('close', (code, sig) => {
      if (!exited) {
        exited = true
        exitCode = code
        exitSignal = sig
      }
      finish()
    })

    if (child.stdin) {
      if (options.input !== undefined) child.stdin.end(options.input)
      else child.stdin.end()
    }
  })
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result?: ProcessResult
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

export interface CaptureOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Human name used in errors, e.g. "Composer". */
  label?: string
  /** Hint appended when the executable is missing, e.g. "Install Composer from getcomposer.org". */
  missingHint?: string
  /** Resolve instead of throwing on a non-zero exit code. */
  allowFailure?: boolean
  shell?: boolean
  windowsVerbatimArguments?: boolean
}

/** Last meaningful lines of a command's stderr/stdout, for error messages. */
export function summarizeOutput(text: string, maxChars = 600): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
  if (clean.length <= maxChars) return clean
  return '…' + clean.slice(clean.length - maxChars)
}

/** Run a command to completion and capture its output; throws CommandError with an actionable message. */
export async function runCapture(command: string, args: string[], options: CaptureOptions = {}): Promise<ProcessResult> {
  const label = options.label ?? command
  const result = await spawnStreaming(
    {
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      windowsVerbatimArguments: options.windowsVerbatimArguments
    },
    { input: options.input, timeoutMs: options.timeoutMs ?? 30000, signal: options.signal, maxOutputBytes: 64 * 1024 * 1024 }
  )
  if (result.spawnError) {
    const code = result.spawnError.code
    if (code === 'ENOENT') {
      throw new CommandError(`${label} not found on PATH${options.missingHint ? `. ${options.missingHint}` : ''}`, result)
    }
    if (code === 'EACCES') throw new CommandError(`${label} is not executable (${command})`, result)
    throw new CommandError(`Could not start ${label}: ${result.spawnError.message}`, result)
  }
  if (result.cancelled) throw new CommandError(`${label} was cancelled`, result)
  if (result.timedOut) throw new CommandError(`${label} timed out after ${Math.round((options.timeoutMs ?? 30000) / 1000)}s`, result)
  if (!options.allowFailure && result.exitCode !== 0) {
    const detail = summarizeOutput(result.stderr) || summarizeOutput(result.stdout)
    throw new CommandError(`${label} failed (exit code ${result.exitCode ?? result.signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`, result)
  }
  return result
}
