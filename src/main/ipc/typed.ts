import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { InvokeArgs, InvokeChannel, InvokeReturn } from '../../shared/ipc'
import { errorMessage, type Logger } from '../store/common'

export type InvokeHandler<C extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: InvokeArgs<C>
) => InvokeReturn<C> | Promise<InvokeReturn<C>>

/** One handler per invoke channel. Assigning an object with a missing channel is a compile error. */
export type InvokeHandlerMap = { [C in InvokeChannel]: InvokeHandler<C> }

/** A group of handlers (used with `satisfies HandlerGroup` so the literal keeps its exact keys). */
export type HandlerGroup = Partial<InvokeHandlerMap>

/** Error whose message is meant for the user (no stack logged as an unexpected failure). */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}

export interface RegisterOptions {
  /** Reject invocations that do not come from the app's own page. */
  isTrustedSender(event: IpcMainInvokeEvent): boolean
  logger: Logger
}

/**
 * Register every handler with ipcMain.handle. Returns a function that removes them again.
 * Errors are logged and re-thrown as plain `Error`s (Electron serializes only the message across IPC).
 */
export function registerInvokeHandlers(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  handlers: InvokeHandlerMap,
  opts: RegisterOptions
): () => void {
  const channels = Object.keys(handlers) as InvokeChannel[]
  for (const channel of channels) {
    const handler = handlers[channel] as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!opts.isTrustedSender(event)) {
        opts.logger.warn(`Rejected IPC "${channel}" from untrusted sender`, event.senderFrame?.url)
        throw new Error('Untrusted IPC sender')
      }
      try {
        return await handler(event, ...args)
      } catch (err) {
        if (err instanceof UserFacingError || err instanceof TypeError) {
          opts.logger.warn(`IPC ${channel} failed: ${errorMessage(err)}`)
        } else {
          opts.logger.error(`IPC ${channel} failed:`, err)
        }
        throw err instanceof Error ? new Error(err.message) : new Error(errorMessage(err))
      }
    })
  }
  return () => {
    for (const channel of channels) ipc.removeHandler(channel)
  }
}
