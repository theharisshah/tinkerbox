import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID, type Connection, type Settings } from '../../shared/types'
import { expandHome } from '../env/which'
import { localConnectionId, normalizeLocalPath, type ConnectionsStore } from '../store/connections'

export interface SandboxLocation {
  installed: boolean
  path: string
}

export interface ResolverDeps {
  connections: ConnectionsStore
  settings: () => Settings
  /** Current sandbox location (the execution module's synchronous sandbox helpers). */
  sandbox: () => SandboxLocation
  isDirectory?: (path: string) => boolean
  platform?: NodeJS.Platform
  /** Home directory for a `~` in the Default Working Directory setting (default: os.homedir()). */
  homeDir?: string
}

export function isDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Missing / unreadable → not a usable project directory.
    return false
  }
}

/**
 * Fields of a stored 'sandbox' / 'scratch' entry the user may customize (e.g. the PHP binary or Xdebug toggle of
 * the Default tab, saved through connections:save with that id).
 */
function implicitOverrides(stored: Connection | undefined): Partial<Connection> {
  if (!stored) return {}
  const out: Partial<Connection> = {}
  if (stored.phpBinary) out.phpBinary = stored.phpBinary
  if (stored.driver) out.driver = stored.driver
  if (stored.color) out.color = stored.color
  if (stored.debug) out.debug = true
  if (stored.lastUsedAt) out.lastUsedAt = stored.lastUsedAt
  return out
}

/**
 * ExecutionContext.resolveConnection():
 * - 'scratch' → plain PHP (no project);
 * - 'sandbox' → the Laravel Sandbox ("Default"); plain PHP while it is not installed;
 * - null      → Default Working Directory setting (`~` expanded, like everywhere else) → sandbox when installed →
 *               scratch;
 * - other ids → the saved project. Unknown ids throw.
 */
export function createConnectionResolver(deps: ResolverDeps): (id: string | null) => Connection {
  const isDirectory = deps.isDirectory ?? isDirectorySync
  const platform = deps.platform ?? process.platform

  const scratch = (): Connection => ({
    id: SCRATCH_CONNECTION_ID,
    name: 'PHP',
    type: 'local',
    path: '',
    createdAt: 0,
    ...implicitOverrides(deps.connections.get(SCRATCH_CONNECTION_ID))
  })

  const sandbox = (): Connection => {
    const location = deps.sandbox()
    return {
      id: SANDBOX_CONNECTION_ID,
      name: 'Default',
      type: 'local',
      path: location.installed ? location.path : '',
      createdAt: 0,
      ...implicitOverrides(deps.connections.get(SANDBOX_CONNECTION_ID))
    }
  }

  return (id: string | null): Connection => {
    if (id === SCRATCH_CONNECTION_ID) return scratch()
    if (id === SANDBOX_CONNECTION_ID) return sandbox()
    if (id === null) {
      const configured = deps.settings().defaultWorkingDirectory.trim()
      const dir = configured === '' ? '' : expandHome(configured, deps.homeDir, platform)
      if (dir !== '' && isDirectory(dir)) {
        const stored = deps.connections.findLocalByPath(dir)
        if (stored) return stored
        const path = normalizeLocalPath(dir, platform)
        return { id: localConnectionId(path, platform), name: basename(path) || path, type: 'local', path, createdAt: 0 }
      }
      return deps.sandbox().installed ? sandbox() : scratch()
    }
    const conn = deps.connections.get(id)
    if (!conn) throw new Error(`The project "${id}" is no longer available. Open the folder again.`)
    return conn
  }
}
