import { api } from './api'
import { installCommands } from './commands'
import { useAppStore } from './stores/app'
import { useConnectionsStore } from './stores/connections'
import { useSettingsStore } from './stores/settings'
import { useTabsStore } from './stores/tabs'
import { useUiStore } from './stores/ui'
import { effectiveThemeId, loadCustomThemes, osDark, startThemeSync, themeSettingsMigration } from './themes'
import { platform } from './utils/platform'

/**
 * Startup, in two phases so the first paint already has the right theme:
 *  1. `prepare()` (before mount): settings + theme.
 *  2. `start()` (after mount): commands, events, app info, recent projects, session restore.
 * Requires an active Pinia.
 */

export async function prepare(): Promise<void> {
  if (typeof document !== 'undefined') document.documentElement.dataset.platform = platform
  const settings = useSettingsStore()
  await settings.load()
  // Settings of older versions may name a built-in theme that was replaced: store the current id.
  const migration = themeSettingsMigration(settings.settings)
  if (migration) void settings.update(migration)
  const customThemes = loadCustomThemes()
  // A custom theme only exists once its file is loaded: wait for it, or the app mounts with the default theme first.
  if (effectiveThemeId(settings.settings, osDark.value).startsWith('custom:')) await customThemes
  startThemeSync(() => settings.settings)
}

export async function start(): Promise<void> {
  const ui = useUiStore()
  installCommands()
  api.on('app:notice', ({ level, message }) => {
    ui.toast({ level: level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info', message })
  })
  await Promise.all([useAppStore().load(), useConnectionsStore().load()])
  await useTabsStore().init()
}
