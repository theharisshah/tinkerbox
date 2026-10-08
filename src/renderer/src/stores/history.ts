import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { HistoryEntry } from '@shared/types'
import { api } from '../api'
import { groupByDay, type DayGroup } from '../utils/format'
import { useUiStore } from './ui'

/** Code execution history (main keeps `historyLimit` entries; newest first). */
export const useHistoryStore = defineStore('history', () => {
  const entries = ref<HistoryEntry[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  let unsubscribe: (() => void) | null = null
  let inflight: Promise<HistoryEntry[]> | null = null

  /** Entries grouped by local day (TODAY / YESTERDAY / date). */
  const byDay = computed<DayGroup<HistoryEntry>[]>(() => groupByDay(entries.value, (e) => e.ranAt))

  function subscribe(): void {
    if (unsubscribe) return
    unsubscribe = api.on('history:changed', () => {
      // Only keep the list fresh once someone has looked at it.
      if (loaded.value) void load()
    })
  }

  function load(): Promise<HistoryEntry[]> {
    subscribe()
    if (inflight) return inflight
    loading.value = true
    inflight = api
      .invoke('history:list')
      .then((list) => {
        entries.value = [...list].sort((a, b) => b.ranAt - a.ranAt)
        loaded.value = true
        return entries.value
      })
      .catch((err: unknown) => {
        useUiStore().error(err, 'Could not load the history')
        return entries.value
      })
      .finally(() => {
        loading.value = false
        inflight = null
      })
    return inflight
  }

  async function remove(id: string): Promise<void> {
    const before = entries.value
    entries.value = before.filter((e) => e.id !== id)
    try {
      await api.invoke('history:delete', id)
    } catch (err) {
      entries.value = before
      useUiStore().error(err, 'Could not delete the entry')
    }
  }

  async function clear(): Promise<void> {
    const before = entries.value
    entries.value = []
    try {
      await api.invoke('history:clear')
    } catch (err) {
      entries.value = before
      useUiStore().error(err, 'Could not clear the history')
    }
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return { entries, loaded, loading, byDay, load, remove, delete: remove, clear, dispose }
})

export type HistoryStore = ReturnType<typeof useHistoryStore>
