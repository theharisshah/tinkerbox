<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  FolderSearch,
  Layers,
  RotateCw,
  ScrollText,
  Search,
  SearchX,
  X
} from 'lucide-vue-next'
import type { LogEntry, LogListing } from '@shared/types'
import { api } from '../../../api'
import { executeCommand } from '../../../commands'
import { useAppStore } from '../../../stores/app'
import { useConnectionsStore } from '../../../stores/connections'
import { useUiStore } from '../../../stores/ui'
import { formatBytes, pluralize, relativeTime } from '../../../utils/format'
import { fileManagerName, modKeyLabel, tildify } from '../../../utils/platform'
import Button from '../../common/Button.vue'
import EmptyState from '../../common/EmptyState.vue'
import IconButton from '../../common/IconButton.vue'
import Modal from '../../common/Modal.vue'
import Popover from '../../common/Popover.vue'
import Select from '../../common/Select.vue'
import Spinner from '../../common/Spinner.vue'
import TextInput from '../../common/TextInput.vue'
import HighlightText from './HighlightText.vue'
import {
  BIG_LOG_BYTES,
  LIMIT_OPTIONS,
  POLLING_OPTIONS,
  capitalize,
  countLevels,
  entryKeys,
  entryToText,
  filterEntries,
  groupLogFiles,
  groupStack,
  hasDetails,
  levelBadgeClass,
  levelDotClass,
  levelFilterLabel,
  logViewerMemory,
  messageHeadline,
  normalizeLevel,
  pickDefaultFile,
  prettyContext
} from './logUtils'

/**
 * Log Viewer (⌘L): log files of the active tab's project grouped by directory, newest-first entries with level
 * filter, search, expandable details (message, JSON context, stack trace with collapsible vendor frames) and
 * optional polling.
 */
const props = defineProps<{ connectionId: string | null }>()
const emit = defineEmits<{ close: [result?: unknown] }>()

const connections = useConnectionsStore()
const app = useAppStore()
const ui = useUiStore()

const projectPath = computed(() => connections.path(props.connectionId))
const projectLabel = computed(() => connections.label(props.connectionId))
const memoryKey = computed(() => connections.effectiveId(props.connectionId) ?? projectPath.value)

const listing = shallowRef<LogListing | null>(null)
const listLoading = ref(false)
const listError = ref<string | null>(null)
const selected = ref<string | null>(null)
const entries = shallowRef<LogEntry[]>([])
const loadedFile = ref<string | null>(null)
const entriesLoading = ref(false)
const entriesError = ref<string | null>(null)
const limit = ref<number>(logViewerMemory.limit)
const polling = ref<number>(logViewerMemory.polling)
const levels = ref<string[]>([])
const query = ref('')
const expanded = ref<Set<string>>(new Set())
const openVendor = ref<Set<string>>(new Set())
const collapsedDirs = ref<Set<string>>(new Set())
const levelMenuOpen = ref(false)
const search = ref<InstanceType<typeof TextInput> | null>(null)
let readToken = 0
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollInFlight = false

const root = computed(() => listing.value?.root || '')
const rootDisplay = computed(() => tildify(root.value || projectPath.value, app.homeDir))
const files = computed(() => listing.value?.files ?? [])
const groups = computed(() => groupLogFiles(files.value))
const selectedFile = computed(() => files.value.find((f) => f.path === selected.value) ?? null)
const isBigFile = computed(() => (selectedFile.value?.size ?? 0) >= BIG_LOG_BYTES)

const keys = computed(() => entryKeys(entries.value))
const levelCounts = computed(() => {
  const counts = countLevels(entries.value)
  // Keep selected levels visible (count 0) so they can be deselected after switching files.
  for (const level of levels.value) if (!counts.some((c) => c.level === level)) counts.push({ level, count: 0 })
  return counts
})
const rows = computed(() => {
  const keep = new Set(filterEntries(entries.value, { levels: levels.value, query: query.value }))
  const list: Array<{ key: string; entry: LogEntry }> = []
  entries.value.forEach((entry, i) => {
    if (keep.has(entry)) list.push({ key: keys.value[i], entry })
  })
  return list
})
const isFiltered = computed(() => levels.value.length > 0 || query.value.trim() !== '')
const countLabel = computed(() => {
  if (!selected.value || loadedFile.value !== selected.value) return ''
  const shown = pluralize(rows.value.length, 'entry', 'entries')
  return isFiltered.value ? `${shown} of ${entries.value.length.toLocaleString('en-US')}` : shown
})

// -- loading --------------------------------------------------------------------------------------------------

async function loadList(silent = false): Promise<void> {
  if (!projectPath.value) return
  if (!silent) {
    listLoading.value = true
    listError.value = null
  }
  try {
    const result = await api.invoke('logs:list', props.connectionId)
    listing.value = result
    listError.value = null
    if (!selected.value || !result.files.some((f) => f.path === selected.value)) {
      selected.value = pickDefaultFile(result.files, logViewerMemory.files.get(memoryKey.value))?.path ?? null
      if (!selected.value) {
        entries.value = []
        loadedFile.value = null
      }
    }
  } catch (err) {
    if (!silent || !listing.value) listError.value = api.errorText(err)
  } finally {
    if (!silent) listLoading.value = false
  }
}

async function readSelected(silent = false): Promise<void> {
  const file = selected.value
  const token = ++readToken
  if (!file) {
    entriesLoading.value = false
    return
  }
  if (!silent) {
    entriesLoading.value = true
    entriesError.value = null
  }
  try {
    const result = await api.invoke('logs:read', { connectionId: props.connectionId, file, limit: limit.value })
    if (token !== readToken) return
    entries.value = result
    loadedFile.value = file
    entriesError.value = null
  } catch (err) {
    if (token !== readToken) return
    if (!silent || loadedFile.value !== file) entriesError.value = api.errorText(err)
  } finally {
    if (token === readToken) entriesLoading.value = false
  }
}

async function refresh(): Promise<void> {
  await loadList()
  await readSelected()
}

watch(selected, (file, previous) => {
  if (file === previous) return
  if (file) logViewerMemory.files.set(memoryKey.value, file)
  expanded.value = new Set()
  openVendor.value = new Set()
  if (file) void readSelected()
})

watch(limit, (value) => {
  logViewerMemory.limit = value
  void readSelected()
})

// -- polling ---------------------------------------------------------------------------------------------------

async function pollTick(): Promise<void> {
  if (pollInFlight || entriesLoading.value || listLoading.value) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  pollInFlight = true
  try {
    await loadList(true)
    await readSelected(true)
  } finally {
    pollInFlight = false
  }
}

function schedulePolling(ms: number): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (ms > 0 && projectPath.value) pollTimer = setInterval(() => void pollTick(), ms)
}

watch(polling, (ms) => {
  logViewerMemory.polling = ms
  schedulePolling(ms)
})

// -- interaction -----------------------------------------------------------------------------------------------

function selectFile(path: string): void {
  if (selected.value === path) void readSelected()
  else selected.value = path
}

function toggleDir(dir: string): void {
  const next = new Set(collapsedDirs.value)
  if (next.has(dir)) next.delete(dir)
  else next.add(dir)
  collapsedDirs.value = next
}

/** Single-line entries expand too: the details make the full text selectable and copyable. */
function toggleEntry(key: string): void {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

function onRowClick(event: MouseEvent, key: string): void {
  // Keep text selections inside an expanded row from toggling it.
  if (window.getSelection()?.toString()) return
  if ((event.target as HTMLElement | null)?.closest('button')) return
  toggleEntry(key)
}

function toggleVendor(id: string): void {
  const next = new Set(openVendor.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openVendor.value = next
}

function toggleLevel(level: string): void {
  levels.value = levels.value.includes(level) ? levels.value.filter((l) => l !== level) : [...levels.value, level]
}

function clearFilters(): void {
  levels.value = []
  query.value = ''
}

async function copyEntry(entry: LogEntry): Promise<void> {
  try {
    await api.copy(entryToText(entry))
    ui.toast({ level: 'success', message: 'Log entry copied to the clipboard.', key: 'logs-copy', timeout: 2500 })
  } catch (err) {
    ui.error(err, 'Could not copy the entry')
  }
}

async function revealRoot(): Promise<void> {
  const target = root.value || projectPath.value
  if (!target) return
  try {
    await api.invoke('shell:revealInFinder', target)
  } catch (err) {
    ui.error(err, 'Could not open the log folder')
  }
}

function openProject(): void {
  emit('close')
  void executeCommand('openFolder')
}

function onSearchEscape(event: KeyboardEvent): void {
  if (query.value) {
    event.preventDefault()
    query.value = ''
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (ui.topModal?.name !== 'logs') return
  const mod = api.platform === 'darwin' ? event.metaKey : event.ctrlKey
  if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    search.value?.focus()
    search.value?.select()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (projectPath.value) void loadList()
  schedulePolling(polling.value)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  readToken++
})
</script>

<template>
  <Modal size="full" hide-header :padded="false" aria-label="Logs" initial-focus="[data-logs-search]" @close="emit('close')">
    <div class="flex h-full min-h-0" data-testid="logs-modal">
      <!-- Files ------------------------------------------------------------------------------------------------>
      <aside class="flex w-[264px] shrink-0 flex-col border-r border-line bg-app-alt">
        <div class="flex items-center gap-1.5 px-3 pt-3 pb-2">
          <IconButton :icon="X" label="Close" size="sm" @click="emit('close')" />
          <h2 class="flex-1 text-[15px] font-semibold tracking-tight text-fg">Logs</h2>
          <IconButton
            v-if="projectPath"
            :icon="RotateCw"
            label="Reload files"
            size="sm"
            :disabled="listLoading"
            @click="refresh"
          />
        </div>
        <div v-if="projectPath" class="px-4 pb-2">
          <p class="truncate text-xs font-semibold text-fg" :title="projectLabel">{{ projectLabel }}</p>
          <p class="truncate font-mono text-[10.5px] text-muted" :title="root || projectPath">{{ rootDisplay }}</p>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div v-if="listLoading && !listing" class="flex items-center gap-2 px-2 py-3 text-xs text-muted">
            <Spinner :size="13" /> Looking for log files…
          </div>
          <p v-else-if="projectPath && listing && files.length === 0" class="px-2 py-3 text-xs text-muted">No log files.</p>
          <div v-for="group in groups" :key="group.dir" class="mt-2 first:mt-0">
            <button
              type="button"
              class="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-[10.5px] font-semibold tracking-wider text-muted hover:text-fg"
              :aria-expanded="!collapsedDirs.has(group.dir)"
              :title="group.dir || root"
              @click="toggleDir(group.dir)"
            >
              <ChevronRight :size="12" :class="['shrink-0 transition-transform', collapsedDirs.has(group.dir) ? '' : 'rotate-90']" />
              <span class="truncate">{{ group.label }}</span>
              <span class="ml-auto font-normal tabular">{{ group.files.length }}</span>
            </button>
            <ul v-show="!collapsedDirs.has(group.dir)" class="mt-0.5 space-y-px">
              <li v-for="file in group.files" :key="file.path">
                <button
                  type="button"
                  :class="[
                    'flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition-colors',
                    file.path === selected ? 'bg-accent-soft text-fg' : 'text-fg hover:bg-hover'
                  ]"
                  :aria-current="file.path === selected ? 'true' : undefined"
                  :title="file.path"
                  @click="selectFile(file.path)"
                >
                  <span class="flex w-full items-center gap-1.5">
                    <FileText :size="13" :class="['shrink-0', file.path === selected ? 'text-accent' : 'text-muted']" />
                    <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium">{{ file.name }}</span>
                  </span>
                  <span class="mt-0.5 flex w-full items-center gap-2 pl-[19px] text-[10.5px] text-muted tabular">
                    <span>{{ formatBytes(file.size) }}</span>
                    <span class="ml-auto">{{ relativeTime(file.modifiedAt) }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </div>
        </div>

        <div class="flex items-center gap-2 border-t border-line px-3 py-2.5">
          <span class="text-xs font-medium text-muted">Polling</span>
          <div class="flex-1" />
          <span v-if="polling > 0" class="size-1.5 animate-pulse rounded-full bg-success" aria-hidden="true" />
          <Select v-model="polling" :options="POLLING_OPTIONS" size="sm" :disabled="!projectPath" aria-label="Polling interval" />
        </div>
      </aside>

      <!-- Entries ---------------------------------------------------------------------------------------------->
      <section class="flex min-w-0 flex-1 flex-col bg-surface">
        <EmptyState
          v-if="!projectPath"
          class="flex-1"
          :icon="ScrollText"
          title="No project selected"
          description="The log viewer reads the log files of the active tab's project. Plain PHP tabs have no project logs — open a project folder to browse its logs."
        >
          <template #actions>
            <Button variant="primary" :icon="FolderOpen" autofocus @click="openProject">Open Local Project…</Button>
          </template>
        </EmptyState>

        <template v-else>
          <header class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="text-[13px] text-muted">File:</span>
              <span class="max-w-[320px] truncate text-[13px] font-semibold text-fg" :title="selectedFile?.path">
                {{ selectedFile?.name ?? '—' }}
              </span>
              <IconButton
                :icon="FolderSearch"
                :label="`Open log folder in ${fileManagerName()}`"
                size="sm"
                :disabled="!root && !projectPath"
                @click="revealRoot"
              />
            </div>
            <div class="flex-1" />
            <span class="text-xs whitespace-nowrap text-muted tabular" data-testid="logs-count">{{ countLabel }}</span>
            <Select v-model="limit" :options="LIMIT_OPTIONS" size="sm" :disabled="!selected" aria-label="Number of entries" />
            <Popover v-model:open="levelMenuOpen" placement="bottom-end" panel-class="w-56 p-1">
              <template #trigger>
                <button
                  type="button"
                  :disabled="!selected"
                  :class="[
                    'no-drag inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium shadow-xs transition-colors disabled:opacity-50',
                    levels.length ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line bg-input text-fg hover:border-accent/40'
                  ]"
                  aria-haspopup="true"
                  :aria-expanded="levelMenuOpen"
                >
                  <Layers :size="13" />
                  <span class="max-w-[140px] truncate">{{ levelFilterLabel(levels) }}</span>
                  <ChevronDown :size="13" class="text-muted" />
                </button>
              </template>
              <div role="menu" aria-label="Levels">
                <button
                  type="button"
                  role="menuitemcheckbox"
                  :aria-checked="levels.length === 0"
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-hover"
                  @click="levels = []"
                >
                  <Check :size="13" :class="levels.length === 0 ? 'text-accent' : 'invisible'" />
                  <span class="flex-1 font-medium">All Levels</span>
                  <span class="text-[11px] text-muted tabular">{{ entries.length.toLocaleString('en-US') }}</span>
                </button>
                <div v-if="levelCounts.length" class="my-1 h-px bg-line" />
                <button
                  v-for="item in levelCounts"
                  :key="item.level"
                  type="button"
                  role="menuitemcheckbox"
                  :aria-checked="levels.includes(item.level)"
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-hover"
                  @click="toggleLevel(item.level)"
                >
                  <Check :size="13" :class="levels.includes(item.level) ? 'text-accent' : 'invisible'" />
                  <span :class="['size-2 shrink-0 rounded-full', levelDotClass(item.level)]" />
                  <span class="flex-1">{{ capitalize(item.level) }}</span>
                  <span class="text-[11px] text-muted tabular">{{ item.count.toLocaleString('en-US') }}</span>
                </button>
              </div>
            </Popover>
            <div class="w-56" data-logs-search>
              <TextInput
                ref="search"
                v-model="query"
                size="sm"
                :icon="Search"
                clearable
                :placeholder="`Search  ${modKeyLabel()}F`"
                @escape="onSearchEscape"
              />
            </div>
          </header>

          <div class="relative min-h-0 flex-1 overflow-y-auto">
            <div v-if="listLoading && !listing" class="flex h-full items-center justify-center gap-2 text-[13px] text-muted">
              <Spinner :size="16" /> Looking for log files…
            </div>
            <EmptyState v-else-if="listError" :icon="ScrollText" title="Could not list the log files" :description="listError">
              <template #actions><Button :icon="RotateCw" @click="refresh">Try again</Button></template>
            </EmptyState>
            <EmptyState
              v-else-if="listing && files.length === 0"
              :icon="ScrollText"
              title="No log files"
              :description="`No log files found in ${rootDisplay}`"
            >
              <template #actions>
                <Button :icon="RotateCw" @click="refresh">Reload</Button>
              </template>
            </EmptyState>
            <div
              v-else-if="entriesLoading && loadedFile !== selected"
              class="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted"
              data-testid="logs-loading"
            >
              <Spinner :size="18" />
              <span>Reading {{ selectedFile?.name ?? 'log file' }}…</span>
              <span v-if="isBigFile" class="text-xs">
                {{ formatBytes(selectedFile?.size ?? 0) }} — only the end of large files is read, this can take a moment.
              </span>
            </div>
            <EmptyState v-else-if="entriesError" :icon="ScrollText" title="Could not read the log file" :description="entriesError">
              <template #actions><Button :icon="RotateCw" @click="readSelected()">Try again</Button></template>
            </EmptyState>
            <EmptyState
              v-else-if="selected && loadedFile === selected && entries.length === 0"
              :icon="FileText"
              title="This log file is empty"
              description="New entries show up here when you reload — or turn on polling."
            />
            <EmptyState v-else-if="isFiltered && rows.length === 0 && entries.length > 0" :icon="SearchX" title="No matching entries" compact>
              <template #actions><Button size="sm" @click="clearFilters">Clear filters</Button></template>
            </EmptyState>

            <template v-else>
              <div v-if="entriesLoading" class="sticky top-0 z-10 h-0.5 w-full overflow-hidden bg-accent/15">
                <div class="h-full w-1/3 animate-pulse bg-accent" />
              </div>
              <ul class="divide-y divide-line/70" data-testid="logs-entries">
                <li v-for="row in rows" :key="row.key" :class="expanded.has(row.key) ? 'bg-app-alt/60' : ''">
                  <div
                    class="group flex cursor-pointer items-center gap-2.5 px-4 py-[7px] hover:bg-hover/60"
                    role="button"
                    tabindex="0"
                    :aria-expanded="expanded.has(row.key)"
                    @click="onRowClick($event, row.key)"
                    @keydown.enter.self.prevent="toggleEntry(row.key)"
                    @keydown.space.self.prevent="toggleEntry(row.key)"
                  >
                    <ChevronRight
                      :size="13"
                      :class="['shrink-0 text-muted transition-transform', expanded.has(row.key) ? 'rotate-90' : '', hasDetails(row.entry) ? '' : 'opacity-30']"
                    />
                    <span
                      :class="[
                        'inline-flex h-[18px] w-[74px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold tracking-wide uppercase',
                        levelBadgeClass(row.entry.level)
                      ]"
                    >
                      {{ normalizeLevel(row.entry.level) }}
                    </span>
                    <span v-if="row.entry.datetime" class="shrink-0 font-mono text-[11px] text-muted tabular">
                      <HighlightText :text="row.entry.datetime" :query="query" />
                    </span>
                    <span v-if="row.entry.env" class="shrink-0 rounded bg-fg/6 px-1.5 py-px text-[10.5px] font-medium text-muted">
                      {{ row.entry.env }}
                    </span>
                    <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                      <HighlightText :text="messageHeadline(row.entry.message)" :query="query" />
                    </span>
                    <button
                      type="button"
                      class="flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
                      title="Copy entry"
                      aria-label="Copy entry"
                      @click.stop="copyEntry(row.entry)"
                    >
                      <Copy :size="13" />
                    </button>
                  </div>

                  <div v-if="expanded.has(row.key)" class="selectable space-y-3 px-4 pt-1 pb-4 pl-[42px]">
                    <section>
                      <h4 class="mb-1 text-[10.5px] font-semibold tracking-wider text-muted uppercase">Message</h4>
                      <pre
                        class="max-h-[320px] overflow-auto rounded-lg border border-line bg-editor p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg"
                      ><HighlightText :text="row.entry.message" :query="query" /></pre>
                    </section>
                    <section v-if="row.entry.context">
                      <h4 class="mb-1 text-[10.5px] font-semibold tracking-wider text-muted uppercase">Context</h4>
                      <pre
                        class="max-h-[320px] overflow-auto rounded-lg border border-line bg-editor p-3 font-mono text-[12px] leading-relaxed text-code-string"
                      ><HighlightText :text="prettyContext(row.entry.context)" :query="query" /></pre>
                    </section>
                    <section v-if="row.entry.stack">
                      <h4 class="mb-1 text-[10.5px] font-semibold tracking-wider text-muted uppercase">Stack trace</h4>
                      <div class="max-h-[420px] overflow-auto rounded-lg border border-line bg-editor py-2 font-mono text-[11.5px] leading-relaxed">
                        <template v-for="(group, gi) in groupStack(row.entry.stack)" :key="gi">
                          <template v-if="!group.vendor">
                            <div v-for="(line, li) in group.lines" :key="li" class="px-3 whitespace-pre text-fg">
                              <HighlightText :text="line" :query="query" />
                            </div>
                          </template>
                          <template v-else>
                            <button
                              type="button"
                              class="mx-2 my-0.5 flex items-center gap-1 rounded px-1 font-sans text-[11px] text-muted hover:bg-hover hover:text-fg"
                              :aria-expanded="openVendor.has(`${row.key}::${gi}`)"
                              @click="toggleVendor(`${row.key}::${gi}`)"
                            >
                              <ChevronRight
                                :size="12"
                                :class="['transition-transform', openVendor.has(`${row.key}::${gi}`) ? 'rotate-90' : '']"
                              />
                              {{ pluralize(group.lines.length, 'vendor frame') }}
                            </button>
                            <template v-if="openVendor.has(`${row.key}::${gi}`)">
                              <div v-for="(line, li) in group.lines" :key="li" class="px-3 whitespace-pre text-muted">
                                <HighlightText :text="line" :query="query" />
                              </div>
                            </template>
                          </template>
                        </template>
                      </div>
                    </section>
                    <div class="flex gap-2">
                      <Button size="xs" :icon="Copy" @click="copyEntry(row.entry)">Copy entry</Button>
                    </div>
                  </div>
                </li>
              </ul>
            </template>
          </div>
        </template>
      </section>
    </div>
  </Modal>
</template>
