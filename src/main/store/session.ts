import type { OutputMode, SessionState, TabState } from '../../shared/types'
import { cloneJson, consoleLogger, isPlainObject, optionalString, type Logger, type NoticeSink } from './common'
import { JsonStore } from './jsonStore'

const MAX_TABS = 200
const MAX_TAB_CODE = 5 * 1024 * 1024
const OUTPUT_MODES: readonly OutputMode[] = ['detail', 'cli']

function sanitizeTab(input: unknown): TabState | null {
  if (!isPlainObject(input)) return null
  if (typeof input.id !== 'string' || input.id === '' || input.id.length > 200) return null
  const kind = input.kind === 'welcome' ? 'welcome' : input.kind === 'code' ? 'code' : null
  if (!kind) return null
  const code = typeof input.code === 'string' ? input.code : ''
  if (code.length > MAX_TAB_CODE) return null
  const tab: TabState = {
    id: input.id,
    kind,
    title: typeof input.title === 'string' ? input.title.slice(0, 500) : '',
    code,
    connectionId: typeof input.connectionId === 'string' ? input.connectionId.slice(0, 200) : null,
    outputMode: OUTPUT_MODES.includes(input.outputMode as OutputMode) ? (input.outputMode as OutputMode) : 'detail',
    showQueries: input.showQueries === true
  }
  const customTitle = optionalString(input.customTitle, 500)
  if (customTitle !== undefined) tab.customTitle = customTitle
  const filePath = optionalString(input.filePath, 4096)
  if (filePath !== undefined) tab.filePath = filePath
  if (input.dirty === true) tab.dirty = true
  return tab
}

/** Validate a session coming from the renderer or from disk. Invalid tabs are dropped. */
export function sanitizeSession(input: unknown): SessionState {
  if (!isPlainObject(input) || !Array.isArray(input.tabs)) throw new TypeError('Session must contain a "tabs" array')
  const tabs: TabState[] = []
  const ids = new Set<string>()
  for (const raw of input.tabs.slice(0, MAX_TABS)) {
    const tab = sanitizeTab(raw)
    if (!tab || ids.has(tab.id)) continue
    ids.add(tab.id)
    tabs.push(tab)
  }
  const activeTabId =
    typeof input.activeTabId === 'string' && ids.has(input.activeTabId) ? input.activeTabId : (tabs[0]?.id ?? null)
  return { tabs, activeTabId }
}

/** session.json — open tabs and their code, restored on start (when `restoreSession` is on). */
export class SessionStore {
  private readonly store: JsonStore<SessionState | null>

  constructor(file: string, opts: { onNotice?: NoticeSink; logger?: Logger; debounceMs?: number } = {}) {
    this.store = new JsonStore<SessionState | null>({
      file,
      label: 'Session',
      defaults: () => null,
      normalize: (raw) => (raw === null ? null : sanitizeSession(raw)),
      debounceMs: opts.debounceMs ?? 500,
      onNotice: opts.onNotice,
      logger: opts.logger ?? consoleLogger
    })
  }

  load(): SessionState | null {
    return cloneJson(this.store.value)
  }

  save(state: unknown): void {
    this.store.set(sanitizeSession(state))
  }

  flushSync(): boolean {
    return this.store.flushSync()
  }

  dispose(): void {
    this.store.dispose()
  }
}
