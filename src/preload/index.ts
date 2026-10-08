import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EventChannel, EventChannels, InvokeArgs, InvokeChannel, InvokeReturn, TinkerboxBridge } from '../shared/ipc'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from './channels'

/**
 * Sandboxed preload: exposes `window.tinkerbox` (TinkerboxBridge). Only channels from the allow-lists can be used,
 * so a compromised page cannot reach arbitrary IPC channels. This file may only import 'electron' at runtime
 * (everything else is bundled by electron-vite).
 */

const invokeChannels = new Set<string>(INVOKE_CHANNELS)
const eventChannels = new Set<string>(EVENT_CHANNELS)

const bridge: TinkerboxBridge = {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeReturn<C>> {
    if (!invokeChannels.has(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`))
    return ipcRenderer.invoke(channel, ...args) as Promise<InvokeReturn<C>>
  },

  on<E extends EventChannel>(channel: E, listener: (payload: EventChannels[E]) => void): () => void {
    if (!eventChannels.has(channel)) throw new Error(`Unknown IPC event: ${String(channel)}`)
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    // Never hand the IpcRendererEvent (which exposes `sender`) to the page.
    const wrapped = (_event: IpcRendererEvent, payload: EventChannels[E]): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },

  platform: process.platform
}

contextBridge.exposeInMainWorld('tinkerbox', bridge)
