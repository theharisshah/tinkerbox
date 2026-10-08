import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Snippet } from '@shared/types'
import { api } from '../api'
import { uid } from '../utils/id'
import { cloneJson } from '../utils/merge'
import { useUiStore } from './ui'

export interface SnippetInput {
  id?: string
  name: string
  description?: string
  code: string
  /** '' / null = global. */
  connectionId?: string | null
}

/**
 * Snippets: user snippets (snippets.json) + read-only project snippets of the current connection
 * (<project>/.tinkerbox/snippets/*.php, `source: 'project'`).
 */
export const useSnippetsStore = defineStore('snippets', () => {
  const snippets = ref<Snippet[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  /** Connection the list (project snippets) was loaded for. */
  const connectionId = ref<string | null>(null)
  let seq = 0

  const userSnippets = computed(() => snippets.value.filter((s) => s.source === 'user'))
  const projectSnippets = computed(() => snippets.value.filter((s) => s.source === 'project'))

  function byId(id: string): Snippet | undefined {
    return snippets.value.find((s) => s.id === id)
  }

  /** Load user snippets + the project snippets of `connId` (defaults to the last used connection). */
  async function load(connId: string | null | undefined = connectionId.value): Promise<Snippet[]> {
    const mine = ++seq
    connectionId.value = connId ?? null
    loading.value = true
    try {
      const list = await api.invoke('snippets:list', connId ?? null)
      if (mine === seq) {
        snippets.value = list
        loaded.value = true
      }
    } catch (err) {
      if (mine === seq) useUiStore().error(err, 'Could not load snippets')
    } finally {
      if (mine === seq) loading.value = false
    }
    return snippets.value
  }

  /** Create or update a user snippet. */
  async function save(input: SnippetInput): Promise<Snippet> {
    const now = Date.now()
    const existing = input.id ? byId(input.id) : undefined
    if (existing?.source === 'project') throw new Error('Project snippets are read-only. Edit the file in .tinkerbox/snippets instead.')
    const snippet: Snippet = {
      id: existing?.id ?? input.id ?? uid('snip'),
      name: input.name.trim() || 'Untitled snippet',
      description: input.description?.trim() || undefined,
      code: input.code,
      connectionId: input.connectionId ?? '',
      source: 'user',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    if (snippet.description === undefined) delete snippet.description
    const saved = await api.invoke('snippets:save', cloneJson(snippet))
    snippets.value = existing ? snippets.value.map((s) => (s.id === saved.id ? saved : s)) : [saved, ...snippets.value]
    return saved
  }

  async function remove(id: string): Promise<void> {
    const before = snippets.value
    snippets.value = before.filter((s) => s.id !== id)
    try {
      await api.invoke('snippets:delete', id)
    } catch (err) {
      snippets.value = before
      throw err
    }
  }

  /** Import a JSON export (open dialog). Resolves with the number of imported snippets. */
  async function importFile(): Promise<number> {
    const ui = useUiStore()
    try {
      const count = await api.invoke('snippets:import')
      if (count > 0) {
        ui.toast({ level: 'success', message: `Imported ${count} snippet${count === 1 ? '' : 's'}.` })
        await load()
      }
      return count
    } catch (err) {
      ui.error(err, 'Import failed')
      return 0
    }
  }

  /** Export user snippets to JSON (save dialog). Resolves with the path, or null when cancelled. */
  async function exportFile(): Promise<string | null> {
    const ui = useUiStore()
    try {
      const path = await api.invoke('snippets:export')
      if (path) ui.toast({ level: 'success', message: `Snippets exported to ${path}` })
      return path
    } catch (err) {
      ui.error(err, 'Export failed')
      return null
    }
  }

  return {
    snippets,
    loaded,
    loading,
    connectionId,
    userSnippets,
    projectSnippets,
    byId,
    load,
    save,
    remove,
    delete: remove,
    importFile,
    exportFile
  }
})

export type SnippetsStore = ReturnType<typeof useSnippetsStore>
