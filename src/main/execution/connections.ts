/**
 * Connection resolution for runs and data requests (docs/ARCHITECTURE.md §2.1, "Implicit connections"):
 * `sandbox` → the Laravel Sandbox ("Default"), `scratch` → plain PHP, `null` → Default Working Directory
 * setting → sandbox when available → scratch. The shell's `resolveConnection` is authoritative; the
 * implicit fallbacks here only apply when it cannot resolve an implicit id itself.
 */
import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Connection, LocalConnection } from '@shared/types'
import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID } from '@shared/types'
import { expandHome } from '../env/which'
import { ensureSandboxReady, isSandboxAvailable, sandboxPathSync, userSandboxDir } from '../sandbox'
import type { ExecutionContext } from './types'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function localConnection(id: string, name: string, path: string, base: Partial<LocalConnection> = {}): LocalConnection {
  return { ...base, id, name, type: 'local', path, createdAt: base.createdAt ?? 0 }
}

/** User-tunable fields of an implicit connection (PHP binary / driver / debug of the Default tab). */
function carry(conn: Connection | null): Partial<LocalConnection> {
  if (!conn) return {}
  const out: Partial<LocalConnection> = {}
  if (conn.phpBinary) out.phpBinary = conn.phpBinary
  if (conn.driver) out.driver = conn.driver
  if (conn.color) out.color = conn.color
  if (conn.debug) out.debug = conn.debug
  return out
}

/** Implicit connection for `sandbox`, `scratch` or `null`; null for any other id. */
export function resolveImplicitConnection(ctx: ExecutionContext, id: string | null): LocalConnection | null {
  if (id === SCRATCH_CONNECTION_ID) return localConnection(SCRATCH_CONNECTION_ID, 'PHP', '')
  if (id === SANDBOX_CONNECTION_ID) return localConnection(SANDBOX_CONNECTION_ID, 'Default', sandboxPathSync(ctx))
  if (id !== null) return null
  const configured = ctx.getSettings().defaultWorkingDirectory?.trim()
  if (configured && isDirectory(expandHome(configured))) {
    const path = expandHome(configured)
    return localConnection(`local:${path}`, basename(path) || path, path)
  }
  if (isSandboxAvailable(ctx)) return localConnection(SANDBOX_CONNECTION_ID, 'Default', sandboxPathSync(ctx))
  return localConnection(SCRATCH_CONNECTION_ID, 'PHP', '')
}

/** Fill defaults a partially edited / older connection object may lack. */
export function normalizeConnection(conn: Connection): Connection {
  return { ...conn, name: conn.name ?? conn.id, path: typeof conn.path === 'string' ? conn.path : '' }
}

/**
 * Resolve the connection a run / data request targets. Guarantees the sandbox connection points at a
 * ready-to-run sandbox (copying a bundled one out of the packaged app on first use).
 */
export async function resolveTargetConnection(ctx: ExecutionContext, id: string | null): Promise<Connection> {
  let conn: Connection | null = null
  try {
    conn = ctx.resolveConnection(id) ?? null
  } catch (err) {
    if (id !== null && id !== SANDBOX_CONNECTION_ID && id !== SCRATCH_CONNECTION_ID) throw err
  }
  if (!conn) conn = resolveImplicitConnection(ctx, id)
  if (!conn) throw new Error(`Unknown connection: ${String(id)}`)
  conn = normalizeConnection(conn)

  if (conn.id === SANDBOX_CONNECTION_ID) {
    // Until the sandbox is installed the "Default" tab runs plain PHP (no project, no framework).
    if (!isSandboxAvailable(ctx)) return localConnection(SANDBOX_CONNECTION_ID, conn.name || 'Default', '', carry(conn))
    if (!conn.path || conn.path === userSandboxDir(ctx.userDataPath) || !existsSync(join(conn.path, 'artisan'))) {
      conn = { ...conn, path: await ensureSandboxReady(ctx) }
    }
  }
  return conn
}
