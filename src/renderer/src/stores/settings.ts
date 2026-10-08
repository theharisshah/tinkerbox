import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { CommandId, DeepPartial } from '@shared/ipc'
import { acceleratorFor } from '@shared/shortcuts'
import type { Settings } from '@shared/types'
import { api } from '../api'
import { cloneJson, deepMerge } from '../utils/merge'
import { platform } from '../utils/platform'
import { useUiStore } from './ui'

/**
 * Settings mirror. `update()` applies the patch locally first (optimistic) and reconciles with the main process'
 * answer; a failed update reverts and toasts. Changes made elsewhere arrive through 'settings:changed'.
 */
export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>(cloneJson(DEFAULT_SETTINGS))
  const loaded = ref(false)
  /** Number of updates in flight; 'settings:changed' events are ignored meanwhile (the answer wins). */
  let pending = 0
  let seq = 0
  let unsubscribe: (() => void) | null = null

  /** Effective shortcut for a command (user override or platform default); '' = none. */
  function accelerator(id: CommandId): string {
    return acceleratorFor(id, platform, settings.value.shortcuts)
  }

  const shortcuts = computed(() => settings.value.shortcuts)

  function subscribe(): void {
    if (unsubscribe) return
    unsubscribe = api.on('settings:changed', (next) => {
      if (pending > 0) return
      settings.value = next
    })
  }

  async function load(): Promise<Settings> {
    subscribe()
    try {
      settings.value = await api.invoke('settings:get')
    } catch (err) {
      console.error('Could not load settings:', err)
      useUiStore().error(err, 'Could not load settings')
    } finally {
      loaded.value = true
    }
    return settings.value
  }

  /** Optimistic deep-merge update. Resolves with the saved settings (or the reverted ones on failure). */
  async function update(patch: DeepPartial<Settings>): Promise<Settings> {
    const before = settings.value
    const mine = ++seq
    settings.value = deepMerge(before, cloneJson(patch))
    pending++
    try {
      const saved = await api.invoke('settings:update', cloneJson(patch))
      if (mine === seq) settings.value = saved
      return settings.value
    } catch (err) {
      if (mine === seq) settings.value = before
      useUiStore().error(err, 'Could not save settings')
      return settings.value
    } finally {
      pending--
    }
  }

  /** Set one top-level setting. */
  function set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings> {
    return update({ [key]: value } as DeepPartial<Settings>)
  }

  /** Flip a boolean setting; resolves with the new value. */
  async function toggle(key: { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings]): Promise<boolean> {
    const next = !settings.value[key]
    await set(key, next as Settings[typeof key])
    return settings.value[key] as boolean
  }

  async function reset(): Promise<Settings> {
    try {
      settings.value = await api.invoke('settings:reset')
    } catch (err) {
      useUiStore().error(err, 'Could not reset settings')
    }
    return settings.value
  }

  /** Override a command's shortcut: an accelerator, '' = no shortcut, null = back to the default. */
  function setShortcut(id: CommandId, accel: string | null): Promise<Settings> {
    const patch = { shortcuts: { [id]: accel } } as unknown as DeepPartial<Settings>
    return update(patch)
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return { settings, loaded, shortcuts, accelerator, load, update, set, toggle, reset, setShortcut, dispose }
})

export type SettingsStore = ReturnType<typeof useSettingsStore>
