import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef, type Component } from 'vue'
import type { DumpNode, Snippet } from '@shared/types'
import { uid } from '../utils/id'
import { useSettingsStore } from './settings'

/**
 * UI state that is not persisted per se: the modal stack, toasts, the context menu, popovers, zen mode and the
 * inline tab rename. Visibility toggles that ARE persisted (sidebar, output, layout) live in the settings and are
 * exposed here as convenience getters/actions.
 */

// ---------------------------------------------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------------------------------------------

export type SettingsPage = 'general' | 'appearance' | 'behaviour' | 'output' | 'shortcuts' | 'advanced' | 'updates' | 'about'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button. */
  danger?: boolean
}

export interface PromptOptions {
  title: string
  message?: string
  label?: string
  value?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Return an error message to block confirming. */
  validate?: (value: string) => string | null
}

/** Props passed to each modal component (spread with v-bind). */
export interface ModalPropsMap {
  settings: { page?: SettingsPage }
  /** Open Anything. `query` pre-fills the input (e.g. "#" snippets, "/" recent folders, ">" commands). */
  palette: { query?: string }
  history: Record<string, never>
  snippets: { connectionId?: string | null }
  /** Create (no `snippet`) or edit a snippet. */
  snippetSave: { code: string; connectionId: string | null; snippet?: Snippet }
  themes: Record<string, never>
  logs: { connectionId: string | null }
  panels: { connectionId: string | null }
  php: { connectionId: string | null }
  wrapped: { year?: number }
  share: { code: string; connectionId?: string | null }
  tablePreview: { value: DumpNode; title?: string }
  objectGraph: { value: DumpNode; title?: string }
  htmlPreview: { html: string; title?: string; tabId?: string }
  /** Confirmation (no `prompt`) or text prompt (`prompt` set). Prefer ui.confirm() / ui.prompt(). */
  confirm: ConfirmOptions & { prompt?: Omit<PromptOptions, 'title' | 'message' | 'confirmLabel' | 'cancelLabel'> }
}

export type ModalName = keyof ModalPropsMap

export const MODAL_NAMES: readonly ModalName[] = [
  'settings',
  'palette',
  'history',
  'snippets',
  'snippetSave',
  'themes',
  'logs',
  'panels',
  'php',
  'wrapped',
  'share',
  'tablePreview',
  'objectGraph',
  'htmlPreview',
  'confirm'
]

export interface ModalEntry<N extends ModalName = ModalName> {
  id: string
  name: N
  props: ModalPropsMap[N]
}

export interface OpenModalOptions {
  /** Open on top of the current modal(s) instead of replacing them (confirmations, nested dialogs). */
  stack?: boolean
}

// ---------------------------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------------------------

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface ToastAction {
  label: string
  run: () => void | Promise<void>
}

export interface ToastOptions {
  level?: ToastLevel
  title?: string
  message: string
  /** Milliseconds; 0 = stays until dismissed. Default 10 000. */
  timeout?: number
  actions?: ToastAction[]
  /** Toasts with the same key replace each other (e.g. "auto-run"). */
  key?: string
}

export interface Toast extends Required<Pick<ToastOptions, 'level' | 'message' | 'timeout'>> {
  id: string
  title?: string
  actions: ToastAction[]
  key?: string
  createdAt: number
}

export const TOAST_TIMEOUT_MS = 10_000
const MAX_TOASTS = 5

// ---------------------------------------------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------------------------------------------

export type MenuItem =
  | {
      type?: 'item'
      label: string
      icon?: Component
      /** Electron accelerator shown on the right (display only). */
      shortcut?: string
      danger?: boolean
      disabled?: boolean
      checked?: boolean
      /** Called after the menu closed; a returned promise is awaited for error reporting. */
      action: () => unknown
    }
  | { type: 'separator' }
  | { type: 'header'; label: string }

export interface ContextMenuState {
  x: number
  y: number
  items: MenuItem[]
}

export const useUiStore = defineStore('ui', () => {
  const modals = ref<ModalEntry[]>([])
  /** Entry ids of modals holding unsaved input (a snippet draft …); opening another panel does not discard them. */
  const dirtyModals = ref<string[]>([])
  const resolvers = new Map<string, { resolve: (value: unknown) => void; fallback: unknown }>()

  const toasts = ref<Toast[]>([])
  const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const contextMenu = shallowRef<ContextMenuState | null>(null)
  /** Id of the open popover ('recentFolders', …) — only one at a time. */
  const popover = ref<string | null>(null)
  const zen = ref(false)
  /** Tab currently being renamed inline in the tab bar. */
  const renamingTabId = ref<string | null>(null)

  // -- modals -------------------------------------------------------------------------------------------------

  const top = computed<ModalEntry | null>(() => modals.value[modals.value.length - 1] ?? null)
  /** Name of the top-most modal, or null. */
  const modal = computed<ModalName | null>(() => top.value?.name ?? null)
  /** Props of the top-most modal ({} when none). */
  const modalProps = computed<Record<string, unknown>>(() => (top.value?.props as Record<string, unknown>) ?? {})
  const anyModalOpen = computed(() => modals.value.length > 0)

  function isModalOpen(name: ModalName): boolean {
    return modals.value.some((m) => m.name === name)
  }

  function settle(id: string, result: unknown): void {
    const r = resolvers.get(id)
    if (!r) return
    resolvers.delete(id)
    r.resolve(result === undefined ? r.fallback : result)
  }

  /**
   * Open a modal. By default it replaces the open modal(s) (dismissing them) — except modals with unsaved input
   * (see setModalDirty), which stay underneath; `{ stack: true }` opens it on top of everything.
   * Resolves with the value the modal passes to `emit('close', value)` (undefined when dismissed).
   */
  function openModal<N extends ModalName>(name: N, props?: ModalPropsMap[N], options: OpenModalOptions = {}): Promise<unknown> {
    return openWithFallback(name, props, options, undefined)
  }

  function openWithFallback<N extends ModalName>(
    name: N,
    props: ModalPropsMap[N] | undefined,
    options: OpenModalOptions,
    fallback: unknown
  ): Promise<unknown> {
    closeContextMenu()
    popover.value = null
    if (!options.stack) dismissReplaceable()
    const entry: ModalEntry = { id: uid('modal'), name, props: (props ?? {}) as ModalPropsMap[N] }
    modals.value = [...modals.value, entry]
    return new Promise((resolve) => {
      resolvers.set(entry.id, { resolve, fallback })
    })
  }

  /**
   * Close a modal by entry id or name (default: the top-most one). `result` is handed to the opener's promise.
   */
  function closeModal(idOrName?: string, result?: unknown): void {
    const list = modals.value
    let index = list.length - 1
    if (idOrName !== undefined) {
      index = -1
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].id === idOrName || list[i].name === idOrName) {
          index = i
          break
        }
      }
    }
    if (index < 0) return
    const entry = list[index]
    modals.value = list.filter((_, i) => i !== index)
    forgetDirty([entry.id])
    settle(entry.id, result)
  }

  function closeAllModals(): void {
    const list = modals.value
    modals.value = []
    forgetDirty(list.map((entry) => entry.id))
    for (const entry of list) settle(entry.id, undefined)
  }

  /** Dismiss the modals a new (non-stacked) one replaces: everything above the top-most modal with unsaved input. */
  function dismissReplaceable(): void {
    const list = modals.value
    let keep = 0
    for (let i = list.length - 1; i >= 0; i--) {
      if (dirtyModals.value.includes(list[i].id)) {
        keep = i + 1
        break
      }
    }
    const closing = list.slice(keep)
    if (closing.length === 0) return
    modals.value = list.slice(0, keep)
    forgetDirty(closing.map((entry) => entry.id))
    for (const entry of closing) settle(entry.id, undefined)
  }

  function forgetDirty(ids: string[]): void {
    if (dirtyModals.value.some((id) => ids.includes(id))) dirtyModals.value = dirtyModals.value.filter((id) => !ids.includes(id))
  }

  /**
   * Mark the top-most open modal with this name as holding unsaved input (or not). Panels opened while it is open are
   * stacked on top of it instead of discarding it.
   */
  function setModalDirty(name: ModalName, dirty: boolean): void {
    const entry = [...modals.value].reverse().find((m) => m.name === name)
    if (!entry) return
    const marked = dirtyModals.value.includes(entry.id)
    if (dirty && !marked) dirtyModals.value = [...dirtyModals.value, entry.id]
    else if (!dirty && marked) forgetDirty([entry.id])
  }

  function isModalDirty(idOrName: string): boolean {
    return modals.value.some((m) => (m.id === idOrName || m.name === idOrName) && dirtyModals.value.includes(m.id))
  }

  /** Close the modal when it is the top-most one, otherwise open it (replacing others). */
  function toggleModal<N extends ModalName>(name: N, props?: ModalPropsMap[N]): void {
    if (top.value?.name === name) closeModal(top.value.id)
    else void openModal(name, props)
  }

  /** Ask for confirmation (stacked on top of any open modal). Resolves false when dismissed. */
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return openWithFallback('confirm', { ...options }, { stack: true }, false).then((v) => v === true)
  }

  /** Ask for a line of text. Resolves null when cancelled. */
  function prompt(options: PromptOptions): Promise<string | null> {
    const { title, message, confirmLabel, cancelLabel, ...input } = options
    return openWithFallback(
      'confirm',
      { title, message, confirmLabel: confirmLabel ?? 'OK', cancelLabel, prompt: { ...input } },
      { stack: true },
      null
    ).then((v) => (typeof v === 'string' ? v : null))
  }

  // -- toasts -------------------------------------------------------------------------------------------------

  function dismissToast(id: string): void {
    const timer = toastTimers.get(id)
    if (timer) clearTimeout(timer)
    toastTimers.delete(id)
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  function scheduleDismiss(t: Toast, ms: number): void {
    const prev = toastTimers.get(t.id)
    if (prev) clearTimeout(prev)
    if (ms <= 0) return
    toastTimers.set(
      t.id,
      setTimeout(() => dismissToast(t.id), ms)
    )
  }

  /** Show a toast (top-end, 10 s by default). Returns its id. */
  function toast(options: ToastOptions | string): string {
    const o: ToastOptions = typeof options === 'string' ? { message: options } : options
    const t: Toast = {
      id: uid('toast'),
      level: o.level ?? 'info',
      title: o.title,
      message: o.message,
      timeout: o.timeout ?? TOAST_TIMEOUT_MS,
      actions: (o.actions ?? []).map((a) => markRaw({ ...a })),
      key: o.key,
      createdAt: Date.now()
    }
    let list = toasts.value
    if (t.key) {
      for (const old of list.filter((x) => x.key === t.key)) dismissToast(old.id)
      list = toasts.value
    }
    while (list.length >= MAX_TOASTS) {
      dismissToast(list[0].id)
      list = toasts.value
    }
    toasts.value = [...list, t]
    scheduleDismiss(t, t.timeout)
    return t.id
  }

  /** Pause auto-dismiss (hover). */
  function holdToast(id: string): void {
    const timer = toastTimers.get(id)
    if (timer) clearTimeout(timer)
    toastTimers.delete(id)
  }

  /** Resume auto-dismiss with the remaining time. */
  function releaseToast(id: string, remainingMs: number): void {
    const t = toasts.value.find((x) => x.id === id)
    if (t && t.timeout > 0) scheduleDismiss(t, Math.max(800, remainingMs))
  }

  /** Toast for a failed action: "<prefix>: <error message>". */
  function error(err: unknown, prefix?: string): string {
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    const message = raw.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '')
    return toast({ level: 'error', message: prefix ? `${prefix}: ${message}` : message })
  }

  // -- context menu & popovers --------------------------------------------------------------------------------

  /** Open the context menu at the mouse position (or explicit coordinates). */
  function openContextMenu(at: MouseEvent | { x: number; y: number }, items: MenuItem[]): void {
    if (at instanceof Event) at.preventDefault()
    const x = 'clientX' in at ? at.clientX : at.x
    const y = 'clientY' in at ? at.clientY : at.y
    popover.value = null
    contextMenu.value = { x, y, items: items.map((i) => (i.type === 'separator' || i.type === 'header' ? i : markRaw({ ...i }))) }
  }

  function closeContextMenu(): void {
    contextMenu.value = null
  }

  function openPopover(id: string): void {
    contextMenu.value = null
    popover.value = id
  }

  function closePopover(id?: string): void {
    if (id === undefined || popover.value === id) popover.value = null
  }

  // -- zen & rename -------------------------------------------------------------------------------------------

  function setZen(on: boolean): void {
    zen.value = on
  }

  function toggleZen(): boolean {
    zen.value = !zen.value
    return zen.value
  }

  function startRename(tabId: string | null): void {
    renamingTabId.value = tabId
  }

  // -- persisted visibility (settings) ------------------------------------------------------------------------

  /** Left icon sidebar (the "toolbar" setting): settings.showToolbar, hidden in zen mode. */
  const showSidebar = computed(() => useSettingsStore().settings.showToolbar && !zen.value)
  /** Output pane: settings.showOutput, hidden in zen mode. */
  const showOutput = computed(() => useSettingsStore().settings.showOutput && !zen.value)
  /** Tab bar, status bar and title-bar controls (hidden in zen mode). */
  const showChrome = computed(() => !zen.value)

  /**
   * Toggle a persisted pane. Zen mode hides every pane regardless of the setting, so there the toggle leaves zen
   * mode and only flips the setting when the pane would otherwise stay hidden — never silently persisting a change
   * the user cannot see.
   */
  function togglePane(key: 'showToolbar' | 'showOutput'): Promise<boolean> {
    const settings = useSettingsStore()
    if (zen.value) {
      zen.value = false
      if (settings.settings[key]) return Promise.resolve(true)
    }
    return settings.toggle(key)
  }

  function toggleSidebar(): Promise<boolean> {
    return togglePane('showToolbar')
  }

  function toggleOutput(): Promise<boolean> {
    return togglePane('showOutput')
  }

  async function toggleLayout(): Promise<'vertical' | 'horizontal'> {
    const settings = useSettingsStore()
    const next = settings.settings.layout === 'vertical' ? 'horizontal' : 'vertical'
    await settings.set('layout', next)
    return next
  }

  return {
    // state
    modals,
    toasts,
    contextMenu,
    popover,
    zen,
    renamingTabId,
    // getters
    showSidebar,
    showOutput,
    showChrome,
    modal,
    modalProps,
    topModal: top,
    anyModalOpen,
    // actions
    isModalOpen,
    openModal,
    closeModal,
    closeAllModals,
    toggleModal,
    setModalDirty,
    isModalDirty,
    confirm,
    prompt,
    toast,
    dismissToast,
    holdToast,
    releaseToast,
    error,
    openContextMenu,
    closeContextMenu,
    openPopover,
    closePopover,
    setZen,
    toggleZen,
    startRename,
    toggleSidebar,
    toggleOutput,
    toggleLayout
  }
})

export type UiStore = ReturnType<typeof useUiStore>
