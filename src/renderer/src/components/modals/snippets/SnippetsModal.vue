<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bookmark,
  CircleQuestionMark,
  CornerDownLeft,
  Globe,
  LockKeyhole,
  Pencil,
  Plus,
  Search,
  SearchX,
  TextCursorInput,
  TextSearch,
  Trash2
} from 'lucide-vue-next'
import type { Snippet } from '@shared/types'
import { getEditor } from '@/editorBridge'
import { useConnectionsStore } from '@/stores/connections'
import { useSnippetsStore } from '@/stores/snippets'
import { useTabsStore } from '@/stores/tabs'
import { useUiStore } from '@/stores/ui'
import { highlightSegments } from '@/utils/fuzzy'
import { modKeyLabel } from '@/utils/platform'
import Badge from '../../common/Badge.vue'
import Button from '../../common/Button.vue'
import EmptyState from '../../common/EmptyState.vue'
import Kbd from '../../common/Kbd.vue'
import Modal from '../../common/Modal.vue'
import Popover from '../../common/Popover.vue'
import SegmentedControl from '../../common/SegmentedControl.vue'
import Spinner from '../../common/Spinner.vue'
import TextInput from '../../common/TextInput.vue'
import type { Segment } from '../../common/types'
import CodePreview from '../history/CodePreview.vue'
import { stepIndex } from '../history/history'
import { filterSnippets, isReadOnlySnippet, scopeCounts, snippetOpenConnection, snippetProjectId, type SnippetScope } from './snippets'

/**
 * Snippets (⌘B): user snippets + read-only project snippets (.tinkerbox/snippets) of the current project.
 * Enter opens in the current tab (switching to the snippet's project), ⌘Enter in a new tab, ⇧Enter inserts at the
 * cursor of the current tab.
 */
const props = withDefaults(defineProps<{ connectionId?: string | null }>(), { connectionId: null })
const emit = defineEmits<{ close: [result?: unknown] }>()

const snippets = useSnippetsStore()
const connections = useConnectionsStore()
const tabs = useTabsStore()
const ui = useUiStore()
const mod = modKeyLabel()

const scope = ref<SnippetScope>('all')
const query = ref('')
const filterText = ref('')
const selectedId = ref<string | null>(null)
const search = ref<InstanceType<typeof TextInput> | null>(null)
const filterInput = ref<InstanceType<typeof TextInput> | null>(null)
const list = ref<HTMLElement | null>(null)

/** Concrete id of the current project (snippets assigned to it show under the project segment). */
const projectId = computed(() => connections.effectiveId(props.connectionId))
const projectName = computed(() => connections.label(props.connectionId))
const counts = computed(() => scopeCounts(snippets.snippets, projectId.value))

const scopeOptions = computed<Segment<SnippetScope>[]>(() => [
  { value: 'all', label: `All ${counts.value.all}` },
  { value: 'project', label: `${projectName.value} ${counts.value.project}`, title: `Snippets of ${projectName.value}` },
  { value: 'filter', label: 'Filter', icon: TextSearch, title: 'Only snippets containing a text' }
])

const results = computed(() =>
  filterSnippets(snippets.snippets, {
    scope: scope.value,
    projectId: projectId.value,
    filterText: filterText.value,
    query: query.value,
    projectLabel: (id) => connections.label(id)
  })
)
const selected = computed<Snippet | null>(() => results.value.find((r) => r.item.id === selectedId.value)?.item ?? null)

watch(
  results,
  (list) => {
    if (!list.some((r) => r.item.id === selectedId.value)) selectedId.value = list[0]?.item.id ?? null
  },
  { immediate: true }
)

watch(scope, async (value) => {
  if (value === 'filter') {
    await nextTick()
    filterInput.value?.focus()
  }
})

function assignedLabel(s: Snippet): string {
  const project = snippetProjectId(s)
  if (s.source === 'project') return project ? connections.label(project) : projectName.value
  return project ? connections.label(project) : 'Global'
}

function assignedColor(s: Snippet): string | undefined {
  const project = snippetProjectId(s)
  return project ? connections.color(project) : undefined
}

function select(id: string): void {
  selectedId.value = id
  void nextTick(() => {
    list.value?.querySelector<HTMLElement>(`[data-snippet="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  })
}

function move(delta: number): void {
  const items = results.value
  const index = stepIndex(
    items.findIndex((r) => r.item.id === selectedId.value),
    delta,
    items.length
  )
  if (index >= 0) select(items[index].item.id)
}

/** Open the snippet: current tab (switching to its project) or a new tab. */
function open(s: Snippet | null, newTab = false): void {
  if (!s) return
  tabs.openCode(s.code, { connectionId: snippetOpenConnection(s, newTab, props.connectionId), newTab })
  emit('close')
}

/** Insert the snippet at the cursor of the current tab. */
function insert(s: Snippet | null): void {
  if (!s) return
  const tab = tabs.activeTab
  if (!tab || tab.kind !== 'code') {
    open(s, true)
    return
  }
  tabs.insertCode(tab.id, s.code)
  emit('close')
}

async function edit(s: Snippet | null): Promise<void> {
  if (!s || isReadOnlySnippet(s)) return
  const saved = (await ui.openModal('snippetSave', { code: s.code, connectionId: props.connectionId, snippet: s }, { stack: true })) as Snippet | undefined
  if (saved?.id) select(saved.id)
}

const hasCodeTab = computed(() => tabs.activeTab?.kind === 'code')

async function createFromTab(): Promise<void> {
  const tab = tabs.activeTab
  const code = tab?.kind === 'code' ? (getEditor(tab.id)?.getCode() ?? tab.code) : ''
  const saved = (await ui.openModal('snippetSave', { code, connectionId: props.connectionId }, { stack: true })) as Snippet | undefined
  if (saved?.id) {
    scope.value = 'all'
    query.value = ''
    select(saved.id)
  }
}

async function remove(s: Snippet | null): Promise<void> {
  if (!s || isReadOnlySnippet(s)) return
  const ok = await ui.confirm({ title: `Delete “${s.name}”?`, message: 'The snippet is removed for good.', confirmLabel: 'Delete', danger: true })
  if (!ok) return
  try {
    await snippets.remove(s.id)
  } catch (err) {
    ui.error(err, 'Could not delete the snippet')
  }
}

function isField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['BUTTON', 'SELECT', 'TEXTAREA', 'A'].includes(target.tagName)
}

function onKeydown(event: KeyboardEvent): void {
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
    case 'Enter':
      if (!selected.value) return
      event.preventDefault()
      if (event.shiftKey && !withMod) insert(selected.value)
      else open(selected.value, withMod)
      break
  }
}

onMounted(() => {
  void snippets.load(props.connectionId)
})
</script>

<template>
  <Modal
    title="Snippets"
    size="xl"
    height="min(700px, calc(100vh - 64px))"
    :padded="false"
    initial-focus="[data-snippets-search]"
    @close="$emit('close')"
  >
    <template #actions>
      <Button
        size="sm"
        variant="ghost"
        :icon="Plus"
        :title="hasCodeTab ? 'Save the code of the current tab as a snippet' : 'Write a new snippet'"
        data-testid="snippets-create"
        @click="createFromTab"
      >
        {{ hasCodeTab ? 'Save current code' : 'New snippet' }}
      </Button>
      <Button size="sm" variant="ghost" :icon="ArrowDownToLine" title="Import snippets from a JSON export" @click="snippets.importFile()">Import</Button>
      <Button size="sm" variant="ghost" :icon="ArrowUpFromLine" title="Export your snippets to a JSON file" @click="snippets.exportFile()">Export</Button>
      <Popover placement="bottom-end" panel-class="w-[340px]">
        <template #trigger>
          <button
            type="button"
            aria-label="How snippets work"
            class="flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <CircleQuestionMark :size="16" />
          </button>
        </template>
        <div class="space-y-3 p-4 text-[13px] leading-relaxed text-fg">
          <p class="font-semibold">Reusable pieces of code</p>
          <p class="text-muted">
            Save code you run often. A snippet can belong to a project — opening it switches the tab to that project — or be
            global.
          </p>
          <ul class="space-y-1.5 text-xs">
            <li class="flex items-center justify-between gap-3"><span>Open in the current tab</span><Kbd :keys="['↵']" size="xs" /></li>
            <li class="flex items-center justify-between gap-3"><span>Open in a new tab</span><Kbd :keys="[mod, '↵']" size="xs" /></li>
            <li class="flex items-center justify-between gap-3"><span>Insert at the cursor</span><Kbd :keys="['⇧', '↵']" size="xs" /></li>
            <li class="flex items-center justify-between gap-3"><span>Search</span><Kbd accelerator="CmdOrCtrl+F" size="xs" /></li>
          </ul>
          <p class="border-t border-line pt-3 text-xs text-muted">
            <span class="font-semibold text-fg">Project snippets</span> live in
            <code class="font-mono text-[11px]">.tinkerbox/snippets/*.php</code> inside the project. Describe them with
            <code class="font-mono text-[11px]">@label</code> and <code class="font-mono text-[11px]">@description</code> in a
            docblock. They are read-only here — edit the files instead.
          </p>
        </div>
      </Popover>
    </template>

    <div class="flex h-full min-h-0 flex-col" @keydown="onKeydown">
      <div class="flex shrink-0 flex-col gap-2 border-b border-line px-4 py-2.5">
        <div class="flex items-center gap-2">
          <SegmentedControl v-model="scope" :options="scopeOptions" class="max-w-[50%] shrink-0 overflow-hidden" />
          <div class="min-w-0 flex-1" data-snippets-search>
            <TextInput ref="search" v-model="query" :icon="Search" placeholder="Search snippets…" clearable autofocus>
              <template #suffix><Kbd accelerator="CmdOrCtrl+F" size="xs" subtle /></template>
            </TextInput>
          </div>
        </div>
        <TextInput
          v-if="scope === 'filter'"
          ref="filterInput"
          v-model="filterText"
          :icon="TextSearch"
          size="sm"
          placeholder="Only show snippets whose label, description or code contains…"
          clearable
        />
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- List -->
        <div ref="list" class="w-[40%] max-w-[400px] min-w-[260px] shrink-0 overflow-auto border-r border-line p-2" role="listbox" aria-label="Snippets">
          <div v-if="snippets.loading && !snippets.loaded" class="flex justify-center p-10"><Spinner :size="20" /></div>
          <EmptyState
            v-else-if="snippets.snippets.length === 0"
            :icon="Bookmark"
            title="No snippets yet"
            :description="`Save code you use often with “${hasCodeTab ? 'Save current code' : 'New snippet'}” above and bring it back with a keystroke.`"
            compact
          />
          <EmptyState v-else-if="results.length === 0" :icon="SearchX" title="No matching snippets" description="Try another search or filter." compact />
          <div
            v-for="r in results"
            :key="r.item.id"
            role="option"
            :aria-selected="r.item.id === selectedId"
            :data-snippet="r.item.id"
            :class="['flex items-center gap-2 rounded-lg px-2.5 py-2', r.item.id === selectedId ? 'bg-accent-soft' : 'hover:bg-hover']"
            @click="select(r.item.id)"
            @dblclick="open(r.item)"
          >
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px] font-semibold text-fg">
                <template v-for="(seg, k) in highlightSegments(r.item.name, r.keyIndex === 0 ? r.indices : [])" :key="k">
                  <mark v-if="seg.match" class="bg-transparent text-accent">{{ seg.text }}</mark>
                  <template v-else>{{ seg.text }}</template>
                </template>
              </div>
              <div v-if="r.item.description" class="truncate text-xs text-muted">{{ r.item.description }}</div>
            </div>
            <LockKeyhole v-if="isReadOnlySnippet(r.item)" :size="12" class="shrink-0 text-muted" aria-label="Defined in project snippets" />
            <Badge size="xs" :color="assignedColor(r.item)" class="max-w-[120px] truncate">{{ assignedLabel(r.item) }}</Badge>
          </div>
        </div>

        <!-- Detail -->
        <div class="flex min-w-0 flex-1 flex-col">
          <template v-if="selected">
            <div class="shrink-0 px-5 pt-4 pb-3">
              <div class="flex items-start gap-3">
                <h3 class="selectable min-w-0 flex-1 text-[16px] font-semibold tracking-tight break-words text-fg">{{ selected.name }}</h3>
                <Badge :color="assignedColor(selected)">
                  <Globe v-if="!snippetProjectId(selected) && selected.source === 'user'" :size="11" />
                  {{ assignedLabel(selected) }}
                </Badge>
              </div>
              <p v-if="selected.description" class="selectable mt-1 text-[13px] leading-relaxed text-muted">{{ selected.description }}</p>
              <p v-if="isReadOnlySnippet(selected)" class="mt-2 flex items-center gap-1.5 text-xs text-muted">
                <LockKeyhole :size="12" /> Defined in project snippets (<code class="font-mono">.tinkerbox/snippets</code>) — read-only.
              </p>
              <p v-else-if="snippetProjectId(selected)" class="mt-2 text-xs text-muted">Opening it switches the tab to {{ assignedLabel(selected) }}.</p>
            </div>
            <div class="mx-5 min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-editor px-3 py-2.5">
              <CodePreview :code="selected.code" />
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2 px-5 py-3">
              <Button variant="primary" :icon="CornerDownLeft" data-testid="snippet-open" @click="open(selected)">
                Open <span class="font-normal opacity-75">↵</span>
              </Button>
              <Button :icon="Plus" @click="open(selected, true)">New tab <span class="font-normal text-muted">{{ mod }}↵</span></Button>
              <Button :icon="TextCursorInput" data-testid="snippet-insert" @click="insert(selected)">
                Insert <span class="font-normal text-muted">⇧↵</span>
              </Button>
              <span class="flex-1" />
              <template v-if="!isReadOnlySnippet(selected)">
                <Button variant="ghost" :icon="Pencil" @click="edit(selected)">Edit</Button>
                <button
                  type="button"
                  class="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold text-danger transition-colors hover:bg-danger/10"
                  data-testid="snippet-delete"
                  @click="remove(selected)"
                >
                  <Trash2 :size="15" /> Delete
                </button>
              </template>
            </div>
          </template>
          <div v-else class="flex flex-1 items-center justify-center p-6 text-[13px] text-muted">Select a snippet to see its code.</div>
        </div>
      </div>
    </div>
  </Modal>
</template>
