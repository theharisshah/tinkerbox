/** Barrel for the renderer's Pinia stores (see docs/RENDERER.md). */
export { useAppStore, guessHome, type AppStore } from './app'
export { useConnectionsStore, colorForName, isImplicitConnection, type ConnectionsStore } from './connections'
export { useEnvironmentStore, envKey, type EnvironmentStatus, type EnvironmentStore } from './environment'
export { useHistoryStore, type HistoryStore } from './history'
export { useSettingsStore, type SettingsStore } from './settings'
export { useSnippetsStore, type SnippetInput, type SnippetsStore } from './snippets'
export {
  useTabsStore,
  failedRunResult,
  WELCOME_TITLE,
  CLOSED_TABS_LIMIT,
  SESSION_SAVE_DELAY_MS,
  MAX_STREAMED_CHARS,
  type NewTabOptions,
  type OpenCodeOptions,
  type RunArgs,
  type TabsStore
} from './tabs'
export {
  useUiStore,
  MODAL_NAMES,
  TOAST_TIMEOUT_MS,
  type ConfirmOptions,
  type ContextMenuState,
  type MenuItem,
  type ModalEntry,
  type ModalName,
  type ModalPropsMap,
  type OpenModalOptions,
  type PromptOptions,
  type SettingsPage,
  type Toast,
  type ToastAction,
  type ToastLevel,
  type ToastOptions,
  type UiStore
} from './ui'
