<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { BookmarkPlus, CircleCheck, CircleX, CornerDownLeft, History, Plus, Search, SearchX, Trash2 } from 'lucide-vue-next'
import type { HistoryEntry } from '@shared/types'
import { isImplicitConnection, useConnectionsStore } from '@/stores/connections'
import { useHistoryStore } from '@/stores/history'
import { useTabsStore } from '@/stores/tabs'
import { useUiStore } from '@/stores/ui'
import { formatDateTime, formatDuration, formatTime, pluralize } from '@/utils/format'
import { modKeyLabel } from '@/utils/platform'
import Badge from '../../common/Badge.vue'
import Button from '../../common/Button.vue'
import EmptyState from '../../common/EmptyState.vue'
import Kbd from '../../common/Kbd.vue'
import Modal from '../../common/Modal.vue'
import Select from '../../common/Select.vue'
import Spinner from '../../common/Spinner.vue'
import TextInput from '../../common/TextInput.vue'
import CodePreview from './CodePreview.vue'
import { codePreviewLine, filterHistory, groupHistory, historyProjects, selectionAfterRemoval, stepIndex } from './history'

/**
 * History (⌘Y / Ctrl+I): every run, newest first, grouped by day. Project filter + fuzzy search on top, list on the
 * left, read-only code and actions on the right. Enter opens in the current tab (switching to the entry's project),
 * ⌘Enter in a new tab.
 */
defineEmits<{ close: [result?: unknown] }>()

const ALL = '__all__'
/** Rows rendered at most (the history can hold up to 10 000 entries). */
const RENDER_LIMIT = 500

const history = useHistoryStore()
const connections = useConnectionsStore()
const tabs = useTabsStore()
const ui = useUiStore()

const query = ref('')
const project = ref<string>(ALL)
const selectedId = ref<string | null>(null)
const search = ref<InstanceType<typeof TextInput> | null>(null)
const list = ref<HTMLElement | null>(null)
const mod = modKeyLabel()

const projects = computed(() => historyProjects(history.entries))
const projectOptions = computed(() => [
  { value: ALL, label: 'All Projects' },
  ...projects.value.map((p) => ({ value: p.id, label: `${p.name} (${p.count})` }))
])

const filtered = computed(() => filterHistory(history.entries, { connectionId: project.value === ALL ? null : project.value, query: query.value }))
const visible = computed(() => filtered.value.slice(0, RENDER_LIMIT))
const groups = computed(() => groupHistory(visible.value))
const selected = computed<HistoryEntry | null>(() => visible.value.find((e) => e.id === selectedId.value) ?? null)

// Keep a valid selection when the list changes (filter, search, deletions, new runs).
watch(
  visible,
  (entries) => {
    if (!entries.some((e) => e.id === selectedId.value)) selectedId.value = entries[0]?.id ?? null
  },
  { immediate: true }
)

// A filter value that no longer exists (entries deleted) falls back to all projects.
watch(projects, (list) => {
  if (project.value !== ALL && !list.some((p) => p.id === project.value)) project.value = ALL
})

function projectColor(entry: HistoryEntry): string | undefined {
  return isImplicitConnection(entry.connectionId) ? undefined : connections.color(entry.connectionId)
}

function select(id: string): void {
  selectedId.value = id
  void nextTick(() => {
    list.value?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  })
}

function move(delta: number): void {
  const entries = visible.value
  const index = stepIndex(
    entries.findIndex((e) => e.id === selectedId.value),
    delta,
    entries.length
  )
  if (index >= 0) select(entries[index].id)
}

/** Connection to switch the tab to: the entry's project when it still exists, else keep the tab's project. */
function targetConnection(entry: HistoryEntry): string | undefined {
  const id = entry.connectionId
  if (!id) return undefined
  return isImplicitConnection(id) || connections.byId(id) ? id : undefined
}

function open(entry: HistoryEntry | null, newTab = false, close?: () => void): void {
  if (!entry) return
  tabs.openCode(entry.code, { connectionId: targetConnection(entry), newTab })
  close?.()
}

function createSnippet(entry: HistoryEntry | null): void {
  if (!entry) return
  void ui.openModal('snippetSave', { code: entry.code, connectionId: entry.connectionId || null }, { stack: true })
}

async function remove(entry: HistoryEntry | null): Promise<void> {
  if (!entry) return
  const next = selectionAfterRemoval(visible.value, entry.id)
  await history.remove(entry.id)
  if (next) select(next)
}

async function clearAll(): Promise<void> {
  const count = history.entries.length
  if (count === 0) return
  const ok = await ui.confirm({
    title: 'Clear the history?',
    message: `${pluralize(count, 'run')} will be removed from the history. This cannot be undone.`,
    confirmLabel: 'Clear history',
    danger: true
  })
  if (ok) await history.clear()
}

function isField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['BUTTON', 'SELECT', 'TEXTAREA', 'A'].includes(target.tagName)
}

function onKeydown(event: KeyboardEvent, close: () => void): void {
  if (event.defaultPrevented || event.isComposing) return
  const withMod = event.metaKey || event.ctrlKey
  if (withMod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    search.value?.focus()
    search.value?.select()
    return
  }
  if (isField(event.target)) return
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'PageDown':
      event.preventDefault()
      move(10)
      break
    case 'PageUp':
      event.preventDefault()
      move(-10)
      break
    case 'Enter':
      if (!selected.value) return
      event.preventDefault()
      open(selected.value, withMod, close)
      break
  }
}

onMounted(() => {
  void history.load()
})
</script>

<template>
  <Modal
    title="History"
    size="xl"
    height="min(700px, calc(100vh - 64px))"
    :padded="false"
    initial-focus="[data-history-search]"
    @close="$emit('close')"
  >
    <template #actions>
      <Button v-if="history.entries.length" size="sm" variant="ghost" :icon="Trash2" data-testid="history-clear" @click="clearAll">
        Clear history
      </Button>
    </template>

    <div class="flex h-full min-h-0 flex-col" @keydown="onKeydown($event, () => $emit('close'))">
      <div class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <Select v-model="project" :options="projectOptions" aria-label="Filter by project" class="w-[200px] shrink-0" />
        <div class="min-w-0 flex-1" data-history-search>
          <TextInput ref="search" v-model="query" :icon="Search" placeholder="Search code, projects and results…" clearable autofocus>
            <template #suffix><Kbd accelerator="CmdOrCtrl+F" size="xs" subtle /></template>
          </TextInput>
        </div>
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- List -->
        <div ref="list" class="w-[44%] max-w-[460px] min-w-[280px] shrink-0 overflow-auto border-r border-line pb-2" role="listbox" aria-label="History entries">
          <div v-if="history.loading && !history.loaded" class="flex justify-center p-10"><Spinner :size="20" /></div>
          <EmptyState
            v-else-if="history.entries.length === 0"
            :icon="History"
            title="Nothing here yet"
            description="Every piece of code you run is kept here, so you can go back to it later."
            compact
          />
          <EmptyState v-else-if="visible.length === 0" :icon="SearchX" title="No matching runs" description="Try another search or project." compact />
          <template v-for="group in groups" :key="group.key">
            <div class="sticky top-0 z-[1] bg-surface/95 px-4 pt-3 pb-1.5 text-[10.5px] font-bold tracking-wider text-muted backdrop-blur-sm">
              {{ group.label }}
            </div>
            <div
              v-for="entry in group.items"
              :key="entry.id"
              role="option"
              :aria-selected="entry.id === selectedId"
              :data-entry="entry.id"
              :class="[
                'mx-2 flex items-start gap-2.5 rounded-lg px-2.5 py-2',
                entry.id === selectedId ? 'bg-accent-soft' : 'hover:bg-hover'
              ]"
              @click="select(entry.id)"
              @dblclick="open(entry, false, () => $emit('close'))"
            >
              <CircleCheck v-if="entry.ok" :size="15" class="mt-0.5 shrink-0 text-success" aria-label="Succeeded" />
              <CircleX v-else :size="15" class="mt-0.5 shrink-0 text-danger" aria-label="Failed" />
              <div class="min-w-0 flex-1">
                <div class="truncate font-mono text-[12px] text-fg">{{ codePreviewLine(entry.code) || '(empty)' }}</div>
                <div class="mt-1 flex items-center gap-2 text-[11px] text-muted">
                  <Badge size="xs" :color="projectColor(entry)" class="max-w-[150px] truncate">{{ entry.connectionName || 'Unknown' }}</Badge>
                  <span class="tabular">{{ formatTime(entry.ranAt) }}</span>
                  <span class="tabular ml-auto">{{ formatDuration(entry.durationMs) }}</span>
                </div>
              </div>
            </div>
          </template>
          <p v-if="filtered.length > visible.length" class="px-4 pt-3 text-center text-xs text-muted">
            Showing the {{ RENDER_LIMIT }} most recent of {{ filtered.length }} matches — search to narrow it down.
          </p>
        </div>

        <!-- Detail -->
        <div class="flex min-w-0 flex-1 flex-col">
          <template v-if="selected">
            <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-5 pt-4 pb-3 text-xs text-muted">
              <Badge :color="projectColor(selected)">{{ selected.connectionName || 'Unknown' }}</Badge>
              <span class="tabular">{{ formatDateTime(selected.ranAt) }}</span>
              <span class="tabular">{{ formatDuration(selected.durationMs) }}</span>
              <Badge :variant="selected.ok ? 'success' : 'danger'" size="xs" dot>{{ selected.ok ? 'Succeeded' : 'Failed' }}</Badge>
            </div>
            <div
              v-if="selected.preview"
              :class="[
                'selectable mx-5 mb-3 truncate rounded-lg border px-3 py-1.5 font-mono text-[12px]',
                selected.ok ? 'border-line bg-app-alt/60 text-fg' : 'border-danger/30 bg-danger/8 text-danger'
              ]"
              :title="selected.preview"
            >
              {{ selected.preview }}
            </div>
            <div class="mx-5 min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-editor px-3 py-2.5">
              <CodePreview :code="selected.code" />
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2 px-5 py-3">
              <Button variant="primary" :icon="CornerDownLeft" data-testid="history-open" @click="open(selected, false, () => $emit('close'))">
                Open <span class="font-normal opacity-75">↵</span>
              </Button>
              <Button :icon="Plus" @click="open(selected, true, () => $emit('close'))">
                Open in new tab <span class="font-normal text-muted">{{ mod }}↵</span>
              </Button>
              <Button :icon="BookmarkPlus" @click="createSnippet(selected)">Create snippet</Button>
              <span class="flex-1" />
              <button
                type="button"
                class="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold text-danger transition-colors hover:bg-danger/10"
                data-testid="history-delete"
                @click="remove(selected)"
              >
                <Trash2 :size="15" /> Delete
              </button>
            </div>
          </template>
          <div v-else class="flex flex-1 items-center justify-center p-6 text-[13px] text-muted">Select a run to see its code.</div>
        </div>
      </div>
    </div>
  </Modal>
</template>
