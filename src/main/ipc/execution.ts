import type { WebContents } from 'electron'
import { runOptionsFromSettings } from '../../shared/defaults'
import type { IntrospectRequest, LogReadRequest } from '../../shared/types'
import { sendTo, type ShellContext } from './context'
import {
  cancelRun,
  findPhpBinaries,
  inspectPhpBinary,
  introspectEnvironment,
  introspectMembers,
  invalidateCaches,
  listHerdSites,
  listLogs,
  projectPanels,
  readLog
} from './services'
import { RunOwners, sanitizeRunRequest } from './runs'
import type { HandlerGroup } from './typed'
import { connectionIdOrNull, int, nonEmptyStr, obj } from './validate'

function introspectRequest(raw: unknown, needsClass: boolean): IntrospectRequest {
  const r = obj(raw, 'request')
  const req: IntrospectRequest = { connectionId: connectionIdOrNull(r.connectionId) }
  if (needsClass) req.className = nonEmptyStr(r.className, 'className', 500)
  if (r.force === true) req.force = true
  return req
}

/** PHP / Herd discovery, sandbox, running code, introspection, logs and panels (execution module E1). */
export function executionHandlers(ctx: ShellContext) {
  /** Await the login-shell PATH before calling into anything that spawns processes. */
  const ready = async <T>(fn: () => Promise<T>): Promise<T> => {
    await ctx.envReady
    return fn()
  }

  // Runs belong to the window that started them: closing or reloading it cancels them (kills the PHP processes).
  const owners = new RunOwners()
  const trackedSenders = new WeakSet<WebContents>()
  const startOwnedRun = (sender: WebContents): { signal: AbortSignal; release(): void } => {
    const id = sender.id
    if (!trackedSenders.has(sender)) {
      trackedSenders.add(sender)
      sender.once('destroyed', () => owners.cancelOwner(id))
      sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) owners.cancelOwner(id)
      })
    }
    const run = owners.start(id)
    if (sender.isDestroyed()) owners.cancelOwner(id)
    return run
  }

  return {
    'php:binaries': () => ready(() => findPhpBinaries()),
    'php:inspect': (_e, binary) => {
      const value = nonEmptyStr(binary, 'binary', 4096)
      return ready(() => inspectPhpBinary(value))
    },
    'herd:sites': () => ready(() => listHerdSites()),

    'sandbox:status': () => ctx.sandbox.refresh(),
    'sandbox:install': async () => {
      const status = await ctx.sandbox.install((line, progress) => ctx.broadcast('sandbox:progress', { line, status: progress }))
      invalidateCaches('sandbox')
      // Final event with the resulting status (installed, or the error) for every listening window.
      ctx.broadcast('sandbox:progress', { line: '', status })
      return status
    },

    'run:start': async (e, request) => {
      const settings = ctx.settings.get()
      const req = sanitizeRunRequest(request, runOptionsFromSettings(settings, settings.showQueriesByDefault))
      const sender = e.sender
      const owned = startOwnedRun(sender)
      try {
        return await ctx.runs.run(req, (progress) => sendTo(sender, 'run:progress', progress), owned.signal)
      } finally {
        owned.release()
      }
    },
    'run:cancel': (_e, runId) => cancelRun(nonEmptyStr(runId, 'runId', 200)),

    'introspect:environment': (_e, request) => {
      const req = introspectRequest(request, false)
      return ready(() => introspectEnvironment(ctx.exec, req))
    },
    'introspect:members': (_e, request) => {
      const req = introspectRequest(request, true)
      return ready(() => introspectMembers(ctx.exec, req))
    },
    'project:panels': (_e, connectionId) => {
      const id = connectionIdOrNull(connectionId)
      return ready(() => projectPanels(ctx.exec, id))
    },
    'logs:list': (_e, connectionId) => {
      const id = connectionIdOrNull(connectionId)
      return ready(() => listLogs(ctx.exec, id))
    },
    'logs:read': (_e, request) => {
      const r = obj(request, 'request')
      const req: LogReadRequest = {
        connectionId: connectionIdOrNull(r.connectionId),
        file: nonEmptyStr(r.file, 'file', 4096),
        limit: int(r.limit, 'limit', 1, 10_000)
      }
      return ready(() => readLog(ctx.exec, req))
    }
  } satisfies HandlerGroup
}
