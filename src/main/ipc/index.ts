import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ShellContext } from './context'
import { coreHandlers } from './core'
import { executionHandlers } from './execution'
import { createGist } from './services'
import { systemHandlers } from './system'
import { registerInvokeHandlers, UserFacingError, type HandlerGroup, type InvokeHandlerMap } from './typed'
import { bool, nonEmptyStr, str } from './validate'

const MAX_GIST_CODE = 5 * 1024 * 1024

/** Share as GitHub Gist (integrations module E3). */
function shareHandlers(ctx: ShellContext) {
  return {
    'share:gist': (_e, code, description, isPublic) => {
      const token = ctx.settings.get().github.token
      if (!token) throw new UserFacingError('Add a GitHub token (with the "gist" scope) in Settings › Advanced first.')
      return createGist(
        token,
        nonEmptyStr(code, 'code', MAX_GIST_CODE),
        str(description ?? '', 'description', 1000),
        bool(isPublic, 'isPublic')
      )
    }
  } satisfies HandlerGroup
}

/**
 * Register a handler for every InvokeChannel. `handlers` is typed as InvokeHandlerMap, so forgetting a channel
 * (or adding one that does not exist) is a compile error.
 */
export function registerIpc(
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  ctx: ShellContext,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
): () => void {
  const handlers: InvokeHandlerMap = {
    ...coreHandlers(ctx),
    ...systemHandlers(ctx),
    ...executionHandlers(ctx),
    ...shareHandlers(ctx)
  }
  return registerInvokeHandlers(ipcMain, handlers, { isTrustedSender, logger: ctx.logger })
}
