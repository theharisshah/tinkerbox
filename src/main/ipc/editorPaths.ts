import { isAbsolute, join } from 'node:path'
import type { Connection } from '../../shared/types'

/**
 * Resolve a file path reported by PHP for "open in editor". The runner reports project files relative to the
 * project root (ExceptionFormatter), so relative paths are joined with the project directory; absolute paths are
 * returned unchanged. (Remote transports will extend this with path mapping when they are added.)
 */
export function localPathForFile(file: string, connection: Connection | null): string {
  if (isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) return file
  if (!connection || !connection.path) return file
  return join(connection.path, file)
}
