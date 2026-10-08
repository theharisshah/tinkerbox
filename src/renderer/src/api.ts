import type {
  EventChannel,
  EventChannels,
  InvokeArgs,
  InvokeChannel,
  InvokeReturn,
  TinkerboxBridge
} from '@shared/ipc'
import { createMockBridge } from './api.mock'
import { detectPlatform } from './utils/platform'

/**
 * Typed access to the preload bridge (`window.tinkerbox`). When the renderer runs without Electron (plain browser
 * during UI development) an in-memory mock bridge is used instead so the UI stays usable. Tests can inject their
 * own bridge with `setBridge()`.
 */

let override: TinkerboxBridge | null = null
let mock: TinkerboxBridge | null = null

function bridge(): TinkerboxBridge {
  if (override) return override
  if (typeof window !== 'undefined' && window.tinkerbox) return window.tinkerbox
  if (!mock) mock = createMockBridge(detectPlatform())
  return mock
}

/** Replace the bridge (unit tests). Pass null to go back to window.tinkerbox / the mock. */
export function setBridge(next: TinkerboxBridge | null): void {
  override = next
}

/** True when no Electron preload bridge is available (browser preview / tests without an injected bridge). */
export function isMockBridge(): boolean {
  if (override) return false
  return !(typeof window !== 'undefined' && window.tinkerbox)
}

/** Invoke a main-process handler. Rejections carry the main process' error message. */
export function invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeReturn<C>> {
  return bridge().invoke(channel, ...args)
}

/** Subscribe to a main-process event; returns the unsubscribe function. */
export function on<E extends EventChannel>(channel: E, listener: (payload: EventChannels[E]) => void): () => void {
  return bridge().on(channel, listener)
}

/** Message of an IPC error without Electron's "Error invoking remote method 'x': Error:" prefix. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
  return raw.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '')
}

export const api = {
  invoke,
  on,
  errorText,
  get platform(): NodeJS.Platform {
    return bridge().platform
  },
  get isMock(): boolean {
    return isMockBridge()
  },
  /** Copy text to the clipboard through the main process (works without focus / permissions). */
  copy(text: string): Promise<void> {
    return invoke('clipboard:write', text)
  }
}

export type Api = typeof api
