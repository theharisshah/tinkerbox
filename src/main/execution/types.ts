/**
 * Internal types of the main-process execution layer (E1).
 *
 * Public, IPC-facing contracts live in src/shared/types.ts; this file only holds the shapes shared
 * between the execution modules (connection → bundle → transport → envelope).
 */
import type { Connection, PhpDataMode, RunOptions, Settings } from '@shared/types'

/** Dependencies injected by the shell (E2). Keeps this layer free of `electron` imports. */
export interface ExecutionContext {
  /** Current settings with secrets decrypted. */
  getSettings(): Settings
  /** Decrypted connection; null / 'sandbox' / 'scratch' resolve to the implicit local connections. */
  resolveConnection(id: string | null): Connection
  /**
   * Directory containing the PHP runner resources: the repository root (which contains `resources/php`)
   * in development, `process.resourcesPath` (which contains `php`) when packaged. Both layouts are accepted.
   */
  resourcesPath: string
  userDataPath: string
}

/** JSON payload handed to `\Tinkerbox\Runner::main()` (docs/ARCHITECTURE.md §1.2). */
export interface PhpPayload {
  nonce: string
  mode: 'run' | PhpDataMode
  /** Absolute project path, '' for plain PHP. */
  projectPath: string
  /** Forced driver id or ''. */
  driver: string
  /** base64 encoded UTF-8 user code (run mode). */
  code: string
  /** Editor line of the first code line (selection runs). */
  lineOffset: number
  /** members mode. */
  className: string
  /** logRead mode. */
  logFile: string
  logLimit: number
  /** Home folder for global drivers in ~/.config/tinkerbox/drivers ('' => the runner reads HOME / USERPROFILE). */
  homePath: string
  options: RunOptions
}
