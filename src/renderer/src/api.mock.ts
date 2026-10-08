import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { EventChannel, EventChannels, InvokeArgs, InvokeChannel, InvokeReturn, TinkerboxBridge } from '@shared/ipc'
import type {
  Connection,
  HistoryEntry,
  RunResult,
  SandboxStatus,
  SessionState,
  Settings,
  Snippet,
  UsageStats
} from '@shared/types'
import { deepMerge, cloneJson } from './utils/merge'

/**
 * In-memory stand-in for the preload bridge, used ONLY when `window.tinkerbox` is missing (the renderer opened in a
 * plain browser). It keeps the UI navigable; nothing touches the disk and PHP cannot run.
 */

type MockHandlers = {
  [C in InvokeChannel]: (...args: InvokeArgs<C>) => InvokeReturn<C> | Promise<InvokeReturn<C>>
}

const MOCK_NOTICE = 'PHP cannot run in the browser preview — start the Tinkerbox desktop app (npm run dev).'

function emptyStats(year: number): UsageStats {
  return {
    year,
    runs: 0,
    failedRuns: 0,
    exceptions: {},
    queries: 0,
    magicComments: 0,
    totalRunMs: 0,
    hours: Array.from({ length: 24 }, () => 0),
    projects: {},
    drivers: {},
    longestRunMs: 0
  }
}

export function createMockBridge(platform: NodeJS.Platform): TinkerboxBridge {
  const listeners = new Map<EventChannel, Set<(payload: unknown) => void>>()
  const emit = <E extends EventChannel>(channel: E, payload: EventChannels[E]): void => {
    for (const listener of listeners.get(channel) ?? []) listener(payload)
  }

  let settings: Settings = cloneJson(DEFAULT_SETTINGS)
  let connections: Connection[] = []
  let snippets: Snippet[] = []
  let history: HistoryEntry[] = []
  let session: SessionState | null = null
  const sandbox: SandboxStatus = { installed: false, path: '/mock/sandbox', installing: false }

  const handlers: MockHandlers = {
    'app:info': () => ({
      name: 'Tinkerbox',
      version: '0.0.0-preview',
      platform,
      arch: 'web',
      userDataPath: '(browser preview)',
      electronVersion: '-',
      chromeVersion: typeof navigator !== 'undefined' ? navigator.userAgent : '-',
      nodeVersion: '-',
      isPackaged: false,
      themesPath: '~/.config/tinkerbox/themes',
      driversPath: '~/.config/tinkerbox/drivers'
    }),
    'settings:get': () => cloneJson(settings),
    'settings:update': (patch) => {
      settings = deepMerge(settings, patch)
      emit('settings:changed', cloneJson(settings))
      return cloneJson(settings)
    },
    'settings:reset': () => {
      settings = cloneJson(DEFAULT_SETTINGS)
      emit('settings:changed', cloneJson(settings))
      return cloneJson(settings)
    },
    'connections:list': () => cloneJson(connections),
    'connections:save': (connection) => {
      const saved = { ...connection, createdAt: connection.createdAt || Date.now() }
      connections = connections.some((c) => c.id === saved.id)
        ? connections.map((c) => (c.id === saved.id ? saved : c))
        : [...connections, saved]
      emit('connections:changed', { connections: cloneJson(connections) })
      return cloneJson(saved)
    },
    'connections:delete': (id) => {
      connections = connections.filter((c) => c.id !== id)
      emit('connections:changed', { connections: cloneJson(connections) })
    },
    'connections:openLocal': (path) => {
      const now = Date.now()
      const existing = connections.find((c) => c.path === path)
      const conn: Connection = existing
        ? { ...existing, lastUsedAt: now }
        : { id: `local-${Math.random().toString(16).slice(2, 10)}`, name: path.split(/[\\/]/).pop() || path, type: 'local', path, createdAt: now, lastUsedAt: now }
      connections = [conn, ...connections.filter((c) => c.id !== conn.id)]
      emit('connections:changed', { connections: cloneJson(connections) })
      return cloneJson(conn)
    },
    'connections:test': () => ({ ok: false, message: MOCK_NOTICE, durationMs: 0 }),
    'connections:touch': () => undefined,
    'connections:clearRecents': () => {
      connections = []
      emit('connections:changed', { connections: [] })
    },
    'php:binaries': () => [],
    'php:inspect': () => null,
    'herd:sites': () => [],
    'sandbox:status': () => ({ ...sandbox }),
    'sandbox:install': () => ({ ...sandbox, error: MOCK_NOTICE }),
    'run:start': (request) => {
      const result: RunResult = {
        runId: request.runId,
        tabId: request.tabId,
        connectionId: request.connectionId ?? 'scratch',
        ok: false,
        phpVersion: '',
        driver: null,
        events: [],
        hasReturnValue: false,
        returnValue: null,
        magic: [],
        coverage: [],
        exception: null,
        diagnostics: [],
        bootMs: 0,
        durationMs: 0,
        memoryPeak: 0,
        totalMs: 0,
        stderr: '',
        rawOutput: '',
        exitCode: null,
        error: MOCK_NOTICE,
        finishedAt: Date.now()
      }
      return result
    },
    'run:cancel': () => undefined,
    'introspect:environment': () => {
      throw new Error(MOCK_NOTICE)
    },
    'introspect:members': () => null,
    'project:panels': () => [],
    'logs:list': () => ({ root: '', files: [] }),
    'logs:read': () => [],
    'snippets:list': () => cloneJson(snippets),
    'snippets:save': (snippet) => {
      snippets = snippets.some((s) => s.id === snippet.id)
        ? snippets.map((s) => (s.id === snippet.id ? snippet : s))
        : [...snippets, snippet]
      return cloneJson(snippet)
    },
    'snippets:delete': (id) => {
      snippets = snippets.filter((s) => s.id !== id)
    },
    'snippets:export': () => null,
    'snippets:import': () => 0,
    'history:list': () => cloneJson(history),
    'history:delete': (id) => {
      history = history.filter((h) => h.id !== id)
      emit('history:changed', undefined)
    },
    'history:clear': () => {
      history = []
      emit('history:changed', undefined)
    },
    'session:load': () => cloneJson(session),
    'session:save': (state) => {
      session = cloneJson(state)
    },
    'stats:get': (year) => emptyStats(year ?? new Date().getFullYear()),
    'themes:listCustom': () => [],
    'themes:create': (name, base) => ({ id: `custom:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, file: '', theme: base }),
    'themes:openFolder': () => undefined,
    'dialog:openDirectory': () => {
      const value = typeof window !== 'undefined' ? window.prompt('Project directory (absolute path)') : null
      return value && value.trim() ? value.trim() : null
    },
    'dialog:openFile': () => null,
    'file:open': () => null,
    'file:save': (_content, path) => path ?? null,
    'file:read': () => '',
    'file:isDirectory': (path) => path.trim() !== '',
    'file:watch': () => undefined,
    'shell:openExternal': (url) => {
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener')
    },
    'shell:openInEditor': () => undefined,
    'shell:openProjectInEditor': () => undefined,
    'shell:revealInFinder': () => undefined,
    'clipboard:write': async (text) => {
      if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text)
    },
    'window:setTitle': (title) => {
      if (typeof document !== 'undefined') document.title = title
    },
    'window:toggleFullscreen': async () => {
      if (typeof document === 'undefined') return false
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
      return !!document.fullscreenElement
    },
    'cli:install': () => ({ installed: false, path: '', message: MOCK_NOTICE }),
    'share:gist': () => {
      throw new Error(MOCK_NOTICE)
    }
  }

  return {
    platform,
    async invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeReturn<C>> {
      const handler = handlers[channel] as (...a: InvokeArgs<C>) => InvokeReturn<C> | Promise<InvokeReturn<C>>
      return handler(...args)
    },
    on<E extends EventChannel>(channel: E, listener: (payload: EventChannels[E]) => void): () => void {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      const wrapped = listener as (payload: unknown) => void
      set.add(wrapped)
      return () => {
        set.delete(wrapped)
      }
    }
  }
}
