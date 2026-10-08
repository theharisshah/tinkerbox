import { computed, type WritableComputedRef } from 'vue'
import type { Settings } from '@shared/types'
import { useSettingsStore } from '@/stores/settings'

/** Two-way binding to one top-level setting; every write persists immediately through the settings store. */
export function useSetting<K extends keyof Settings>(key: K): WritableComputedRef<Settings[K]> {
  const store = useSettingsStore()
  return computed<Settings[K]>({
    get: () => store.settings[key],
    set: (value) => {
      if (store.settings[key] !== value) void store.set(key, value)
    }
  })
}
