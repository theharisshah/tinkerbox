import type { TinkerboxBridge } from '../shared/ipc'

declare global {
  interface Window {
    /** IPC bridge exposed by the preload script (src/preload/index.ts). */
    tinkerbox: TinkerboxBridge
  }
}

export {}
