/**
 * Extension point: transports (docs/ARCHITECTURE.md §2.1).
 *
 * A transport delivers the bundled PHP script to a PHP process for a connection and returns its
 * output. This build ships the local transport only; remote ones (SSH, Docker, Kubernetes…) can be added
 * later as new files that call `registerTransport()` — runCode, the data modes and the IPC layer do not
 * change. The most recently registered transport that `supports()` a connection wins.
 */
import type { Connection, Settings } from '@shared/types'
import { localTransport } from './localTransport'
import type { PhpPayload } from './types'

export interface TransportRequest {
  /** Complete PHP script (runner sources + payload invocation), written to PHP's stdin. */
  script: string
  connection: Connection
  settings: Settings
  /** Wall-clock limit in ms; 0 => none. */
  timeoutMs: number
  signal: AbortSignal
  onStdout(chunk: string): void
  onStderr(chunk: string): void
}

export interface TransportResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  /**
   * Optional (Tinkerbox extension of the documented shape): failure after the process started, e.g. the
   * output limit was exceeded. Failures to start at all are reported by rejecting `run()`.
   */
  error?: string
}

export interface Transport {
  id: string
  supports(connection: Connection): boolean
  /** Resolves with the process outcome; rejects with an actionable message when PHP cannot be started. */
  run(req: TransportRequest): Promise<TransportResult>
  /**
   * Optional payload defaults for targets where the project lives elsewhere (e.g. a container path).
   * Defaults: projectPath = connection.path, driver = connection.driver, homePath = local home.
   */
  payloadDefaults?(connection: Connection): Partial<Pick<PhpPayload, 'projectPath' | 'driver' | 'homePath'>>
}

const registry: Transport[] = [localTransport]

/** Register (or replace, by id) a transport. Later registrations take precedence. */
export function registerTransport(transport: Transport): void {
  const existing = registry.findIndex((t) => t.id === transport.id)
  if (existing !== -1) registry.splice(existing, 1)
  registry.push(transport)
}

/** Remove a transport by id (the local transport is re-registered when it would leave none). */
export function unregisterTransport(id: string): void {
  const index = registry.findIndex((t) => t.id === id)
  if (index !== -1) registry.splice(index, 1)
  if (registry.length === 0) registry.push(localTransport)
}

export function registeredTransports(): readonly Transport[] {
  return registry
}

/** The transport for a connection; throws when no registered transport supports it. */
export function transportFor(connection: Connection): Transport {
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i].supports(connection)) return registry[i]
  }
  throw new Error(`No transport can run code for connection "${connection.name || connection.id}" (type ${String(connection.type)})`)
}
