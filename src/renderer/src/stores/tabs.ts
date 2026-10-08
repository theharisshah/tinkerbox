import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef, watch } from 'vue'
import { runOptionsFromSettings, WELCOME_CODE } from '@shared/defaults'
import {
  SANDBOX_CONNECTION_ID,
  type Connection,
  type OutputMode,
  type RunRequest,
  type RunResult,
  type SessionState,
  type TabState
} from '@shared/types'
import { api } from '../api'
import { getEditor, type EditorSelection } from '../editorBridge'
import { uid } from '../utils/id'
import { cloneJson } from '../utils/merge'
import { basename } from '../utils/platform'
import { useAppStore } from './app'
import { useConnectionsStore } from './connections'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'

export const WELCOME_TITLE = 'Get started'
/** Max closed tabs remembered for "Reopen Closed Tab". */
export const CLOSED_TABS_LIMIT = 20
/** Debounce of session.json writes. */
export const SESSION_SAVE_DELAY_MS = 500
/** Streamed (realtime) output kept per tab while running. */
export const MAX_STREAMED_CHARS = 2_000_000

export interface NewTabOptions {
  connectionId?: string | null
  code?: string
  /** Custom (session) title. */
  customTitle?: string
  filePath?: string
  outputMode?: OutputMode
  showQueries?: boolean
  /** Insert right after this tab (default: at the end). */
  afterTabId?: string
  /** Activate the new tab (default true). */
  activate?: boolean
}

export interface RunArgs {
  /** Defaults to the active tab. */
  tabId?: string
  /** Run only the selection (falls back to the whole buffer when nothing is selected). */
  selectionOnly?: boolean
  /** Triggered by auto-evaluate: whole buffer, no prettify. */
  auto?: boolean
}

export interface OpenCodeOptions {
  /** Switch the tab to this project (undefined = keep). */
  connectionId?: string | null
  /** Open in a new tab instead of replacing the active tab's code. */
  newTab?: boolean
  /** Run right away. */
  run?: boolean
}

interface ClosedTab {
  tab: TabState
  index: number
}

/** RunResult for failures that happen before PHP produced an envelope (IPC errors). */
export function failedRunResult(request: RunRequest, message: string, startedAt: number): RunResult {
  const now = Date.now()
  return {
    runId: request.runId,
    tabId: request.tabId,
    connectionId: request.connectionId ?? '',
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
    totalMs: Math.max(0, now - startedAt),
    stderr: '',
    rawOutput: '',
    exitCode: null,
    error: message,
    finishedAt: now
  }
}

function sanitizeFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'tinkerbox'
  return /\.php$/i.test(base) ? base : `${base}.php`
}

export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<TabState[]>([])
  const activeTabId = ref<string | null>(null)

  // Per-tab runtime state (not persisted). Results are raw (never deep-reactive) and must not be mutated.
  const results = shallowRef<Record<string, RunResult | null>>({})
  const running = ref<Record<string, boolean>>({})
  const runIds = ref<Record<string, string>>({})
  const runStartedAt = ref<Record<string, number>>({})
  const streamed = shallowRef<Record<string, string>>({})
  const watching = ref<Record<string, boolean>>({})

  const closedTabs = ref<ClosedTab[]>([])
  const initialized = ref(false)

  const autoRunTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const unsubscribers: Array<() => void> = []
  let stopSessionWatch: (() => void) | null = null

  // -- getters ------------------------------------------------------------------------------------------------

  const activeTab = computed<TabState | null>(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null)
  const activeResult = computed<RunResult | null>(() => (activeTabId.value ? (results.value[activeTabId.value] ?? null) : null))
  const codeTabs = computed(() => tabs.value.filter((t) => t.kind === 'code'))
  const anyRunning = computed(() => Object.values(running.value).some(Boolean))

  function byId(id: string | null | undefined): TabState | undefined {
    if (!id) return undefined
    return tabs.value.find((t) => t.id === id)
  }

  function isRunning(tabId: string | null | undefined): boolean {
    return !!tabId && running.value[tabId] === true
  }

  function resultOf(tabId: string | null | undefined): RunResult | null {
    return tabId ? (results.value[tabId] ?? null) : null
  }

  function streamedOf(tabId: string | null | undefined): string {
    return tabId ? (streamed.value[tabId] ?? '') : ''
  }

  /** Auto title for a tab: file name, project label or "Get started". */
  function autoTitle(tab: Pick<TabState, 'kind' | 'connectionId' | 'filePath'>): string {
    if (tab.kind === 'welcome') return WELCOME_TITLE
    if (tab.filePath) return basename(tab.filePath)
    return useConnectionsStore().label(tab.connectionId)
  }

  /** Title shown in the tab bar and the window title (custom session title wins). */
  function displayTitle(tabOrId: TabState | string | null | undefined): string {
    const tab = typeof tabOrId === 'string' ? byId(tabOrId) : tabOrId
    if (!tab) return ''
    return tab.customTitle?.trim() || autoTitle(tab)
  }

  // -- helpers ------------------------------------------------------------------------------------------------

  function patchTab(id: string, patch: Partial<TabState>): void {
    const tab = byId(id)
    if (!tab) return
    Object.assign(tab, patch)
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (tab as unknown as Record<string, unknown>)[key]
    }
  }

  function setRecord<T>(target: { value: Record<string, T> }, key: string, value: T | undefined): void {
    if (value === undefined) {
      if (!(key in target.value)) return
      const { [key]: _drop, ...rest } = target.value
      void _drop
      target.value = rest
    } else {
      target.value = { ...target.value, [key]: value }
    }
  }

  function makeCodeTab(options: NewTabOptions = {}): TabState {
    const settings = useSettingsStore().settings
    const tab: TabState = {
      id: uid('tab'),
      kind: 'code',
      title: '',
      code: options.code ?? '',
      connectionId: options.connectionId === undefined ? null : options.connectionId,
      outputMode: options.outputMode ?? settings.defaultOutputMode,
      showQueries: options.showQueries ?? settings.showQueriesByDefault
    }
    if (options.filePath) tab.filePath = options.filePath
    if (options.customTitle?.trim()) tab.customTitle = options.customTitle.trim()
    tab.title = autoTitle(tab)
    return tab
  }

  function makeWelcomeTab(): TabState {
    const settings = useSettingsStore().settings
    return {
      id: uid('tab'),
      kind: 'welcome',
      title: WELCOME_TITLE,
      code: '',
      connectionId: null,
      outputMode: settings.defaultOutputMode,
      showQueries: false
    }
  }

  function insertTab(tab: TabState, afterTabId?: string, activate = true): TabState {
    const list = [...tabs.value]
    const after = afterTabId ? list.findIndex((t) => t.id === afterTabId) : -1
    if (after >= 0) list.splice(after + 1, 0, tab)
    else list.push(tab)
    tabs.value = list
    if (activate) activeTabId.value = tab.id
    return byId(tab.id) ?? tab
  }

  // -- tab actions --------------------------------------------------------------------------------------------

  function activate(id: string): void {
    if (byId(id)) activeTabId.value = id
  }

  /** Open a new code tab (default connection, empty code unless given). */
  function newTab(options: NewTabOptions = {}): TabState {
    const tab = makeCodeTab(options)
    if (tab.connectionId) useConnectionsStore().touch(tab.connectionId)
    return insertTab(tab, options.afterTabId, options.activate !== false)
  }

  /** Activate the "Get started" tab, creating it (first position) when needed. */
  function openWelcome(): TabState {
    const existing = tabs.value.find((t) => t.kind === 'welcome')
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab = makeWelcomeTab()
    tabs.value = [tab, ...tabs.value]
    activeTabId.value = tab.id
    return byId(tab.id) ?? tab
  }

  function needsCloseConfirmation(tab: TabState): boolean {
    if (tab.kind !== 'code') return false
    if (tab.dirty) return true
    return useSettingsStore().settings.askBeforeClosingTab && tab.code.trim() !== ''
  }

  async function confirmClose(list: TabState[]): Promise<boolean> {
    const risky = list.filter(needsCloseConfirmation)
    if (risky.length === 0) return true
    const dirty = risky.some((t) => t.dirty)
    return useUiStore().confirm({
      title: risky.length === 1 ? `Close “${displayTitle(risky[0])}”?` : `Close ${risky.length} tabs?`,
      message: dirty
        ? 'Changes that were not saved to the file will be lost.'
        : 'The code will be gone — you can still bring the tab back with Reopen Closed Tab.',
      confirmLabel: risky.length === 1 ? 'Close Tab' : 'Close Tabs',
      danger: true
    })
  }

  function forgetRuntime(id: string): void {
    const runId = runIds.value[id]
    if (runId) void api.invoke('run:cancel', runId).catch(() => undefined)
    if (watching.value[id]) void api.invoke('file:watch', id, null).catch(() => undefined)
    const timer = autoRunTimers.get(id)
    if (timer) clearTimeout(timer)
    autoRunTimers.delete(id)
    setRecord(results, id, undefined)
    setRecord(running, id, undefined)
    setRecord(runIds, id, undefined)
    setRecord(runStartedAt, id, undefined)
    setRecord(streamed, id, undefined)
    setRecord(watching, id, undefined)
  }

  /** Remove tabs without asking. The last tab closing leaves the "Get started" tab. */
  function removeTabs(ids: string[]): void {
    const remove = new Set(ids.filter((id) => byId(id)))
    if (remove.size === 0) return
    const before = tabs.value
    const activeIndex = before.findIndex((t) => t.id === activeTabId.value)
    const closed: ClosedTab[] = []
    before.forEach((tab, index) => {
      if (!remove.has(tab.id)) return
      if (tab.kind === 'code') closed.push({ tab: cloneJson(tab), index })
      forgetRuntime(tab.id)
    })
    if (closed.length) closedTabs.value = [...closedTabs.value, ...closed].slice(-CLOSED_TABS_LIMIT)
    const remaining = before.filter((t) => !remove.has(t.id))
    tabs.value = remaining
    if (remaining.length === 0) {
      openWelcome()
      return
    }
    if (!activeTabId.value || remove.has(activeTabId.value)) {
      // Prefer the tab that slid into the closed tab's place, else the one before it.
      let next: TabState | undefined
      for (let i = activeIndex + 1; i < before.length && !next; i++) if (!remove.has(before[i].id)) next = before[i]
      for (let i = activeIndex - 1; i >= 0 && !next; i--) if (!remove.has(before[i].id)) next = before[i]
      activeTabId.value = (next ?? remaining[0]).id
    }
  }

  /** Whether the tab can be closed: the Get started tab stays when it is the only tab (the window is never empty). */
  function canClose(id: string | TabState | null | undefined = activeTabId.value): boolean {
    const tab = typeof id === 'object' && id !== null ? id : byId(id)
    if (!tab) return false
    return !(tab.kind === 'welcome' && tabs.value.length === 1)
  }

  /** Close a tab (asks first per settings / unsaved file). Resolves false when the user cancelled. */
  async function closeTab(id: string | null = activeTabId.value, options: { force?: boolean } = {}): Promise<boolean> {
    const tab = byId(id)
    if (!tab || !canClose(tab)) return false
    if (!options.force && !(await confirmClose([tab]))) return false
    removeTabs([tab.id])
    return true
  }

  async function closeMany(list: TabState[]): Promise<boolean> {
    if (list.length === 0) return true
    if (!(await confirmClose(list))) return false
    removeTabs(list.map((t) => t.id))
    return true
  }

  function closeOthers(id: string | null = activeTabId.value): Promise<boolean> {
    if (!byId(id)) return Promise.resolve(false)
    const ok = closeMany(tabs.value.filter((t) => t.id !== id))
    if (id) activeTabId.value = id
    return ok
  }

  function closeToRight(id: string | null = activeTabId.value): Promise<boolean> {
    const index = tabs.value.findIndex((t) => t.id === id)
    if (index < 0) return Promise.resolve(false)
    return closeMany(tabs.value.slice(index + 1))
  }

  function closeAll(): Promise<boolean> {
    return closeMany([...tabs.value])
  }

  function duplicateTab(id: string | null = activeTabId.value): TabState | null {
    const tab = byId(id)
    if (!tab) return null
    if (tab.kind === 'welcome') return openWelcome()
    const editor = getEditor(tab.id)
    const code = editor ? editor.getCode() : tab.code
    return newTab({
      code,
      connectionId: tab.connectionId,
      outputMode: tab.outputMode,
      showQueries: tab.showQueries,
      customTitle: tab.customTitle,
      afterTabId: tab.id
    })
  }

  function reopenClosedTab(): TabState | null {
    const last = closedTabs.value[closedTabs.value.length - 1]
    if (!last) return null
    closedTabs.value = closedTabs.value.slice(0, -1)
    const tab: TabState = { ...cloneJson(last.tab) }
    if (byId(tab.id)) tab.id = uid('tab')
    const list = [...tabs.value]
    list.splice(Math.min(Math.max(last.index, 0), list.length), 0, tab)
    tabs.value = list
    activeTabId.value = tab.id
    return byId(tab.id) ?? tab
  }

  /** Session-only title; '' restores the automatic title. */
  /** Rename a code tab (the Get started tab keeps its title). */
  function renameTab(id: string, title: string): void {
    const tab = byId(id)
    if (!tab || tab.kind !== 'code') return
    const clean = title.trim().slice(0, 200)
    patchTab(id, { customTitle: clean === '' || clean === autoTitle(tab) ? undefined : clean })
  }

  function cycle(step: number): void {
    const list = tabs.value
    if (list.length < 2) return
    const index = list.findIndex((t) => t.id === activeTabId.value)
    const next = (index + step + list.length) % list.length
    activeTabId.value = list[next].id
  }

  function nextTab(): void {
    cycle(1)
  }

  function previousTab(): void {
    cycle(-1)
  }

  /** Drag & drop reordering. */
  function moveTab(fromIndex: number, toIndex: number): void {
    const list = [...tabs.value]
    if (fromIndex < 0 || fromIndex >= list.length) return
    const target = Math.min(Math.max(toIndex, 0), list.length - 1)
    if (target === fromIndex) return
    const [tab] = list.splice(fromIndex, 1)
    list.splice(target, 0, tab)
    tabs.value = list
  }

  /** Switch a tab to another project (null = default connection). Clears its output. */
  function setConnection(id: string | null, connectionId: string | null): void {
    const tab = byId(id)
    if (!tab || tab.kind !== 'code') return
    patchTab(tab.id, { connectionId })
    patchTab(tab.id, { title: autoTitle(tab) })
    if (connectionId) useConnectionsStore().touch(connectionId)
    clearOutput(tab.id)
  }

  /** Open a project: in the active code tab, or a new tab when the active one is "Get started" / `newTab`. */
  function openProject(connection: Connection | string | null, options: { newTab?: boolean } = {}): TabState {
    const connectionId = typeof connection === 'string' || connection === null ? connection : connection.id
    const active = activeTab.value
    if (!options.newTab && active && active.kind === 'code') {
      setConnection(active.id, connectionId)
      return active
    }
    return newTab({ connectionId })
  }

  /** New tab on the Laravel Sandbox; shows "Get started" (install button) when it is not installed. */
  function openSandbox(): TabState {
    const app = useAppStore()
    if (app.sandbox && !app.sandbox.installed) {
      useUiStore().toast({
        level: 'warning',
        message: 'The Laravel Sandbox is not installed yet. Install it from the Get started tab.'
      })
      return openWelcome()
    }
    return newTab({ connectionId: SANDBOX_CONNECTION_ID })
  }

  function setOutputMode(id: string | null, mode: OutputMode): void {
    const tab = byId(id ?? activeTabId.value)
    if (tab) patchTab(tab.id, { outputMode: mode })
  }

  function toggleQueries(id: string | null = activeTabId.value): boolean {
    const tab = byId(id)
    if (!tab) return false
    patchTab(tab.id, { showQueries: !tab.showQueries })
    return !!byId(tab.id)?.showQueries
  }

  /** Editor → store: the buffer changed. Marks file tabs dirty and schedules auto-evaluation. */
  function setCode(id: string, code: string): void {
    const tab = byId(id)
    if (!tab || tab.code === code) return
    patchTab(id, tab.filePath ? { code, dirty: true } : { code })
    scheduleAutoRun(id)
  }

  /** Programmatic replacement (snippets, history, file reloads): updates the tab and the mounted editor. */
  function replaceCode(id: string, code: string): void {
    const tab = byId(id)
    if (!tab) return
    const editor = getEditor(id)
    if (editor && editor.getCode() !== code) editor.replaceAll(code)
    if (tab.code !== code) patchTab(id, tab.filePath ? { code, dirty: true } : { code })
  }

  /** Insert text at the cursor of the tab's editor (appends when the editor is not mounted). */
  function insertCode(id: string, text: string): void {
    const tab = byId(id)
    if (!tab) return
    const editor = getEditor(id)
    if (editor) {
      editor.insertText(text)
      setCode(id, editor.getCode())
    } else {
      const sep = tab.code === '' || tab.code.endsWith('\n') ? '' : '\n'
      setCode(id, tab.code + sep + text)
    }
  }

  /** Open code (history entry / snippet): replaces the active code tab's code, or opens a new tab. */
  function openCode(code: string, options: OpenCodeOptions = {}): TabState {
    const active = activeTab.value
    let tab: TabState
    if (options.newTab || !active || active.kind !== 'code') {
      tab = newTab({ code, connectionId: options.connectionId === undefined ? null : options.connectionId })
    } else {
      tab = active
      if (options.connectionId !== undefined && options.connectionId !== tab.connectionId) setConnection(tab.id, options.connectionId)
      replaceCode(tab.id, code)
    }
    if (options.run) void run({ tabId: tab.id })
    return tab
  }

  // -- running ------------------------------------------------------------------------------------------------

  function scheduleAutoRun(id: string): void {
    const settings = useSettingsStore().settings
    const prev = autoRunTimers.get(id)
    if (prev) clearTimeout(prev)
    autoRunTimers.delete(id)
    if (!settings.autoRun) return
    const tab = byId(id)
    if (!tab || tab.kind !== 'code' || tab.code.trim() === '') return
    autoRunTimers.set(
      id,
      setTimeout(
        () => {
          autoRunTimers.delete(id)
          if (isRunning(id)) {
            scheduleAutoRun(id)
            return
          }
          void run({ tabId: id, auto: true })
        },
        Math.max(150, settings.autoRunDelayMs)
      )
    )
  }

  /**
   * Run a tab's code (default: the active tab). Running again while it runs stops it. Honors "Evaluate selected
   * code", prettify on run and auto-hidden output. Resolves with the result (null when nothing ran).
   */
  async function run(args: RunArgs = {}): Promise<RunResult | null> {
    const tab = byId(args.tabId ?? activeTabId.value)
    if (!tab || tab.kind !== 'code') return null
    if (isRunning(tab.id)) {
      if (!args.auto) await cancel(tab.id)
      return null
    }
    const settingsStore = useSettingsStore()
    const settings = settingsStore.settings
    const runId = uid('run')
    const startedAt = Date.now()
    setRecord(runIds, tab.id, runId)
    setRecord(running, tab.id, true)
    setRecord(runStartedAt, tab.id, startedAt)
    setRecord(streamed, tab.id, '')

    let editor = getEditor(tab.id)
    let selection: EditorSelection | null = null
    if (editor && !args.auto && (args.selectionOnly || settings.runSelection)) {
      selection = editor.getSelection()
      if (selection && selection.text.trim() === '') selection = null
    }
    if (editor && !selection && !args.auto && settings.prettifyOnRun && editor.prettify) {
      try {
        await editor.prettify()
      } catch (err) {
        // Unparseable code is run as-is; PHP reports the syntax error with the right line.
        console.debug('Prettify before run skipped:', err)
      }
      editor = getEditor(tab.id)
    }
    if (runIds.value[tab.id] !== runId) return null // cancelled / tab closed while prettifying

    const fullCode = editor ? editor.getCode() : tab.code
    if (fullCode !== tab.code) setCode(tab.id, fullCode)
    const code = selection ? selection.text : fullCode
    if (code.trim() === '') {
      setRecord(running, tab.id, undefined)
      setRecord(runIds, tab.id, undefined)
      return null
    }

    if (settings.autoHideOutput && !settings.showOutput) void settingsStore.set('showOutput', true)

    const request: RunRequest = {
      runId,
      tabId: tab.id,
      connectionId: tab.connectionId,
      code,
      options: runOptionsFromSettings(settings, tab.showQueries)
    }
    if (selection) request.lineOffset = selection.startLine
    // Result lines refer to this buffer: the editor maps them if it is edited while the script runs.
    editor?.beginRun?.(runId, selection)

    let result: RunResult
    try {
      result = await api.invoke('run:start', request)
    } catch (err) {
      result = failedRunResult(request, api.errorText(err), startedAt)
    }
    if (runIds.value[tab.id] !== runId) return result // tab closed meanwhile

    result = markRaw(result)
    setRecord(results, tab.id, result)
    setRecord(running, tab.id, undefined)
    setRecord(runIds, tab.id, undefined)
    try {
      getEditor(tab.id)?.applyRunDecorations(result)
    } catch (err) {
      console.error('applyRunDecorations failed', err)
    }
    return result
  }

  /** Stop the running script of a tab (its RunResult arrives with `cancelled: true`). */
  async function cancel(id: string | null = activeTabId.value): Promise<void> {
    if (!id) return
    const runId = runIds.value[id]
    if (!runId) return
    try {
      await api.invoke('run:cancel', runId)
    } catch (err) {
      useUiStore().error(err, 'Could not stop the script')
    }
  }

  function clearOutput(id: string | null = activeTabId.value): void {
    if (!id) return
    setRecord(results, id, null)
    setRecord(streamed, id, '')
    try {
      getEditor(id)?.clearDecorations()
    } catch (err) {
      console.error('clearDecorations failed', err)
    }
  }

  // -- files --------------------------------------------------------------------------------------------------

  function openFileContent(path: string, content: string): TabState {
    const existing = tabs.value.find((t) => t.filePath === path)
    if (existing) {
      activeTabId.value = existing.id
      if (!existing.dirty && existing.code !== content) replaceCode(existing.id, content)
      patchTab(existing.id, { dirty: undefined })
      return existing
    }
    const active = activeTab.value
    return newTab({ code: content, filePath: path, connectionId: active?.kind === 'code' ? active.connectionId : null })
  }

  /** File → Open (.php). */
  async function openFile(): Promise<TabState | null> {
    try {
      const file = await api.invoke('file:open')
      return file ? openFileContent(file.path, file.content) : null
    } catch (err) {
      useUiStore().error(err, 'Could not open the file')
      return null
    }
  }

  /** Save (or Save As) a tab's code. Resolves with the path, or null when cancelled / failed. */
  async function saveFile(id: string | null = activeTabId.value, options: { as?: boolean } = {}): Promise<string | null> {
    const tab = byId(id)
    if (!tab || tab.kind !== 'code') return null
    const editor = getEditor(tab.id)
    const code = editor ? editor.getCode() : tab.code
    const targetPath = options.as ? undefined : tab.filePath
    const defaultName = tab.filePath ? basename(tab.filePath) : sanitizeFileName(displayTitle(tab))
    try {
      const saved = await api.invoke('file:save', code, targetPath, defaultName)
      if (!saved) return null
      const previous = tab.filePath
      patchTab(tab.id, { code, filePath: saved, dirty: undefined })
      patchTab(tab.id, { title: autoTitle(byId(tab.id) ?? tab) })
      if (watching.value[tab.id] && previous !== saved) await api.invoke('file:watch', tab.id, saved)
      return saved
    } catch (err) {
      useUiStore().error(err, 'Could not save the file')
      return null
    }
  }

  /** Watch the tab's file and re-run on external changes (asks to save untitled tabs first). */
  async function toggleWatch(id: string | null = activeTabId.value): Promise<boolean> {
    const tab = byId(id)
    if (!tab || tab.kind !== 'code') return false
    const ui = useUiStore()
    try {
      if (watching.value[tab.id]) {
        await api.invoke('file:watch', tab.id, null)
        setRecord(watching, tab.id, undefined)
        ui.toast({ message: 'Stopped watching the file.', key: 'watch' })
        return false
      }
      const path = tab.filePath ?? (await saveFile(tab.id))
      if (!path) return false
      await api.invoke('file:watch', tab.id, path)
      setRecord(watching, tab.id, true)
      ui.toast({ level: 'success', message: `Watching ${basename(path)} — the code runs whenever the file changes.`, key: 'watch' })
      return true
    } catch (err) {
      ui.error(err, 'Could not watch the file')
      return false
    }
  }

  // -- session ------------------------------------------------------------------------------------------------

  function snapshot(): SessionState {
    return { tabs: cloneJson(tabs.value), activeTabId: activeTabId.value }
  }

  async function saveSessionNow(): Promise<void> {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    if (!initialized.value) return
    try {
      await api.invoke('session:save', snapshot())
    } catch (err) {
      console.warn('Could not save the session:', api.errorText(err))
    }
  }

  function scheduleSessionSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void saveSessionNow(), SESSION_SAVE_DELAY_MS)
  }

  function sanitizeRestored(tab: TabState): TabState | null {
    if (!tab || typeof tab.id !== 'string' || (tab.kind !== 'code' && tab.kind !== 'welcome')) return null
    const clean: TabState = {
      id: tab.id,
      kind: tab.kind,
      title: typeof tab.title === 'string' ? tab.title : '',
      code: typeof tab.code === 'string' ? tab.code : '',
      connectionId: typeof tab.connectionId === 'string' ? tab.connectionId : null,
      outputMode: tab.outputMode === 'cli' ? 'cli' : 'detail',
      showQueries: tab.showQueries === true
    }
    if (tab.customTitle) clean.customTitle = tab.customTitle
    if (tab.filePath) clean.filePath = tab.filePath
    if (tab.dirty) clean.dirty = true
    return clean
  }

  function subscribeEvents(): void {
    if (unsubscribers.length) return
    unsubscribers.push(
      api.on('run:progress', (event) => {
        if (runIds.value[event.tabId] !== event.runId) return
        const next = (streamed.value[event.tabId] ?? '') + event.chunk
        setRecord(streamed, event.tabId, next.length > MAX_STREAMED_CHARS ? next.slice(-MAX_STREAMED_CHARS) : next)
      }),
      api.on('file:changed', ({ tabId, path, content }) => {
        const tab = byId(tabId)
        if (!tab || tab.filePath !== path) return
        if (tab.code !== content) replaceCode(tab.id, content)
        patchTab(tab.id, { dirty: undefined })
        void run({ tabId: tab.id, auto: true })
      }),
      api.on('file:opened', ({ path, content }) => {
        openFileContent(path, content)
      }),
      api.on('app:openPath', ({ path }) => {
        void (async () => {
          try {
            const connections = useConnectionsStore()
            const conn = connections.findByPath(path) ?? (await connections.openLocal(path))
            const active = activeTab.value
            const reuse = active?.kind === 'code' && active.code.trim() === '' && active.connectionId === null
            openProject(conn, { newTab: !reuse })
          } catch (err) {
            useUiStore().error(err, `Could not open ${path}`)
          }
        })()
      })
    )
  }

  /**
   * Restore the session (settings.restoreSession) or start fresh, add the "Get started" tab (settings.welcomeTab)
   * and start persisting. Call once after the settings are loaded.
   */
  async function init(): Promise<void> {
    if (initialized.value) return
    subscribeEvents()
    const settings = useSettingsStore().settings
    let session: SessionState | null = null
    try {
      session = await api.invoke('session:load')
    } catch (err) {
      console.warn('Could not load the session:', api.errorText(err))
    }
    // Events (CLI / Finder opens) may already have created tabs while the session was loading.
    const early = tabs.value
    const restored: TabState[] = []
    if (settings.restoreSession && session) {
      for (const raw of session.tabs) {
        const tab = sanitizeRestored(raw)
        if (tab && !restored.some((t) => t.id === tab.id)) restored.push(tab)
      }
    }
    let list = [...restored, ...early.filter((t) => !restored.some((r) => r.id === t.id))]
    const hasCode = list.some((t) => t.kind === 'code')
    let active = early.length ? activeTabId.value : session && restored.some((t) => t.id === session?.activeTabId) ? session.activeTabId : null
    if (!settings.welcomeTab && hasCode) list = list.filter((t) => t.kind !== 'welcome')
    if (settings.welcomeTab && !list.some((t) => t.kind === 'welcome')) {
      const welcome = makeWelcomeTab()
      list = [welcome, ...list]
      if (!hasCode) active = welcome.id
    }
    if (list.length === 0) list = [makeCodeTab({ code: WELCOME_CODE })]
    for (const tab of list) if (tab.kind === 'code' && !tab.customTitle && !tab.filePath) tab.title = autoTitle(tab)
    tabs.value = list
    activeTabId.value = active && list.some((t) => t.id === active) ? active : list[0].id
    initialized.value = true

    stopSessionWatch = watch(
      () => [tabs.value, activeTabId.value],
      () => scheduleSessionSave(),
      { deep: true }
    )
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => void saveSessionNow())
    }
  }

  function dispose(): void {
    for (const off of unsubscribers.splice(0)) off()
    stopSessionWatch?.()
    stopSessionWatch = null
    if (saveTimer) clearTimeout(saveTimer)
    for (const timer of autoRunTimers.values()) clearTimeout(timer)
    autoRunTimers.clear()
  }

  return {
    // state
    tabs,
    activeTabId,
    results,
    running,
    runIds,
    runStartedAt,
    streamed,
    watching,
    closedTabs,
    initialized,
    // getters
    activeTab,
    activeResult,
    codeTabs,
    anyRunning,
    byId,
    isRunning,
    resultOf,
    streamedOf,
    autoTitle,
    displayTitle,
    // tabs
    activate,
    newTab,
    openWelcome,
    canClose,
    closeTab,
    closeOthers,
    closeToRight,
    closeAll,
    removeTabs,
    duplicateTab,
    reopenClosedTab,
    renameTab,
    nextTab,
    previousTab,
    moveTab,
    setConnection,
    openProject,
    openSandbox,
    setOutputMode,
    toggleQueries,
    setCode,
    replaceCode,
    insertCode,
    openCode,
    // running
    run,
    cancel,
    clearOutput,
    // files
    openFile,
    openFileContent,
    saveFile,
    toggleWatch,
    // session
    init,
    snapshot,
    saveSessionNow,
    dispose
  }
})

export type TabsStore = ReturnType<typeof useTabsStore>
