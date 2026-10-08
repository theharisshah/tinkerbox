<script setup lang="ts">
/**
 * Table Preview: a list of arrays / objects / models as a sortable, searchable table. Rows are virtualized;
 * click / ⇧-click / ⌘-click select rows, right-click copies them as a PHP array or JSON, Export saves CSV.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Braces, Download, FileJson, Search, Sheet } from 'lucide-vue-next'
import type { DumpNode } from '@shared/types'
import { api } from '../../api'
import { useUiStore } from '../../stores/ui'
import { pluralize } from '../../utils/format'
import { isMac } from '../../utils/platform'
import Button from '../common/Button.vue'
import EmptyState from '../common/EmptyState.vue'
import Modal from '../common/Modal.vue'
import TextInput from '../common/TextInput.vue'
import { copyText } from './actions'
import { cellText, compareCells, rowsToJson, rowsToPhp, tabulate, toCsv, type TableRow } from './lib/serialize'

const props = defineProps<{ value: DumpNode; title?: string }>()
defineEmits<{ close: [result?: unknown] }>()

const ui = useUiStore()
const ROW_HEIGHT = 30
const OVERSCAN = 12

const table = computed(() => tabulate(props.value))
const columns = computed(() => table.value?.columns ?? [])
const query = ref('')
const sortColumn = ref<string | null>(null)
const sortDir = ref<1 | -1>(1)
const selected = ref(new Set<TableRow>())
const anchor = ref<TableRow | null>(null)

/** Lowercased searchable text per row (computed once). */
const haystacks = computed(() => {
  const map = new Map<TableRow, string>()
  for (const row of table.value?.rows ?? []) {
    map.set(row, [String(row.key), ...columns.value.map((c) => cellText(row.cells[c]))].join('\u0000').toLowerCase())
  }
  return map
})

const filtered = computed<TableRow[]>(() => {
  const rows = table.value?.rows ?? []
  const q = query.value.trim().toLowerCase()
  if (!q) return rows
  const terms = q.split(/\s+/)
  return rows.filter((row) => {
    const text = haystacks.value.get(row) ?? ''
    return terms.every((t) => text.includes(t))
  })
})

const sorted = computed<TableRow[]>(() => {
  const col = sortColumn.value
  if (!col) return filtered.value
  const dir = sortDir.value
  return [...filtered.value].sort((a, b) => {
    const result = compareCells(a.cells[col], b.cells[col])
    if (result !== 0) return result * dir
    return 0
  })
})

const totalRows = computed(() => table.value?.rows.length ?? 0)
const notDumped = computed(() => Math.max(0, (table.value?.total ?? 0) - totalRows.value))

/** Column widths from a sample of the content (fixed layout keeps virtualized rows steady). */
const widths = computed(() => {
  const sample = (table.value?.rows ?? []).slice(0, 300)
  const keyChars = Math.max(1, ...sample.map((r) => String(r.key).length))
  return {
    key: Math.min(90, Math.max(40, keyChars * 8 + 24)),
    cols: columns.value.map((c) => {
      let chars = c.length + 2
      for (const row of sample) chars = Math.max(chars, Math.min(48, cellText(row.cells[c]).length))
      return Math.min(380, Math.max(70, chars * 7.4 + 26))
    })
  }
})
const tableWidth = computed(() => widths.value.key + widths.value.cols.reduce((a, b) => a + b, 0))

// -- virtualization ------------------------------------------------------------------------------------------------

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewport = ref(600)
let observer: ResizeObserver | null = null

onMounted(() => {
  if (!scroller.value) return
  viewport.value = scroller.value.clientHeight
  observer = new ResizeObserver(() => {
    if (scroller.value) viewport.value = scroller.value.clientHeight
  })
  observer.observe(scroller.value)
})
onBeforeUnmount(() => observer?.disconnect())

const windowStart = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN))
const windowEnd = computed(() => Math.min(sorted.value.length, Math.ceil((scrollTop.value + viewport.value) / ROW_HEIGHT) + OVERSCAN))
const visibleRows = computed(() => sorted.value.slice(windowStart.value, windowEnd.value).map((row, i) => ({ row, index: windowStart.value + i })))
const padTop = computed(() => windowStart.value * ROW_HEIGHT)
const padBottom = computed(() => Math.max(0, (sorted.value.length - windowEnd.value) * ROW_HEIGHT))

function onScroll(): void {
  if (scroller.value) scrollTop.value = scroller.value.scrollTop
}

watch([query, sortColumn, sortDir], () => {
  if (scroller.value) scroller.value.scrollTop = 0
  scrollTop.value = 0
})

// -- sorting & selection -------------------------------------------------------------------------------------------

function sortBy(column: string): void {
  if (sortColumn.value !== column) {
    sortColumn.value = column
    sortDir.value = 1
  } else if (sortDir.value === 1) {
    sortDir.value = -1
  } else {
    sortColumn.value = null
  }
}

function select(row: TableRow, event: MouseEvent): void {
  const next = new Set(selected.value)
  const toggle = isMac ? event.metaKey : event.ctrlKey
  if (event.shiftKey && anchor.value) {
    const list = sorted.value
    const a = list.indexOf(anchor.value)
    const b = list.indexOf(row)
    if (a >= 0 && b >= 0) {
      if (!toggle) next.clear()
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(list[i])
      selected.value = next
      return
    }
  }
  if (toggle) {
    if (next.has(row)) next.delete(row)
    else next.add(row)
  } else {
    next.clear()
    next.add(row)
  }
  anchor.value = row
  selected.value = next
}

function rowsFor(row: TableRow): TableRow[] {
  if (!selected.value.has(row)) return [row]
  return sorted.value.filter((r) => selected.value.has(r))
}

function openRowMenu(row: TableRow, event: MouseEvent): void {
  if (!selected.value.has(row)) {
    selected.value = new Set([row])
    anchor.value = row
  }
  const rows = rowsFor(row)
  const what = rows.length === 1 ? 'row' : `${rows.length} rows`
  ui.openContextMenu(event, [
    { type: 'header', label: rows.length === 1 ? `Row ${row.key}` : `${rows.length} rows` },
    { label: 'Copy as PHP array', icon: Braces, action: () => copyText(rowsToPhp(rows), `Copied ${what} as a PHP array.`) },
    { label: 'Copy as JSON', icon: FileJson, action: () => copyText(rowsToJson(rows), `Copied ${what} as JSON.`) },
    { type: 'separator' },
    { label: 'Copy as CSV', icon: Sheet, action: () => copyText(toCsv({ columns: columns.value }, rows), `Copied ${what} as CSV.`) }
  ])
}

function onKeydown(event: KeyboardEvent): void {
  const mod = isMac ? event.metaKey : event.ctrlKey
  if (mod && event.key.toLowerCase() === 'a' && !(event.target instanceof HTMLInputElement)) {
    event.preventDefault()
    selected.value = new Set(sorted.value)
  }
  if (mod && event.key.toLowerCase() === 'c' && selected.value.size && !(event.target instanceof HTMLInputElement)) {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    event.preventDefault()
    const rows = sorted.value.filter((r) => selected.value.has(r))
    void copyText(rowsToJson(rows), `Copied ${pluralize(rows.length, 'row')} as JSON.`)
  }
}

// -- export --------------------------------------------------------------------------------------------------------

const exporting = ref(false)

function fileName(): string {
  const base = (props.title || 'table').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'table'
  return `${base}.csv`
}

async function exportCsv(): Promise<void> {
  if (!table.value) return
  exporting.value = true
  try {
    const path = await api.invoke('file:save', toCsv(table.value, sorted.value), undefined, fileName())
    if (path) ui.toast({ level: 'success', message: `Exported ${pluralize(sorted.value.length, 'row')} to ${path}` })
  } catch (err) {
    ui.error(err, 'Could not export the table')
  } finally {
    exporting.value = false
  }
}

// -- cells ---------------------------------------------------------------------------------------------------------

function cellClass(node: DumpNode | undefined): string {
  if (!node) return 'text-muted/50'
  switch (node.t) {
    case 'null':
      return 'text-code-null italic'
    case 'bool':
      return 'text-code-bool'
    case 'int':
    case 'float':
      return 'text-code-number text-right tabular'
    case 'string':
      return 'text-fg'
    case 'enum':
      return 'text-code-keyword'
    default:
      return 'text-muted'
  }
}

function cellDisplay(node: DumpNode | undefined): string {
  if (!node) return ''
  if (node.t === 'null') return 'null'
  const text = cellText(node)
  return text.length > 300 ? text.slice(0, 299) + '…' : text
}
</script>

<template>
  <Modal
    :title="title || 'Table Preview'"
    size="xl"
    height="80vh"
    :padded="false"
    body-class="flex flex-col"
    initial-focus="[data-table-search]"
    @close="$emit('close')"
  >
    <template #title>
      <span class="flex items-center gap-2">
        Table Preview
        <span v-if="title" class="truncate font-mono text-[12px] font-normal text-muted">{{ title }}</span>
      </span>
    </template>

    <EmptyState v-if="!table" :icon="Sheet" title="Nothing to tabulate" description="Table Preview needs a list of arrays, objects or models." />

    <template v-else>
      <div class="flex shrink-0 items-center gap-3 px-5 pt-3 pb-2.5">
        <div class="w-72" data-table-search>
          <TextInput v-model="query" placeholder="Search..." :icon="Search" clearable size="sm" />
        </div>
        <span class="font-sans text-[12px] text-muted tabular">
          <template v-if="query.trim()">{{ filtered.length.toLocaleString() }} of </template>{{ pluralize(totalRows, 'entry', 'entries') }}
          <span v-if="selected.size > 1"> · {{ selected.size.toLocaleString() }} selected</span>
          <span v-if="notDumped" class="text-warning" :title="'The dump was cut at Settings → Output → max items'">
            · {{ notDumped.toLocaleString() }} not dumped</span
          >
        </span>
        <span class="flex-1" />
        <Button size="sm" :icon="Download" :loading="exporting" @click="exportCsv">Export</Button>
      </div>

      <div
        ref="scroller"
        class="selectable relative min-h-0 flex-1 overflow-auto border-t border-line font-mono text-[12.5px]"
        tabindex="0"
        @scroll="onScroll"
        @keydown="onKeydown"
      >
        <table class="table-fixed border-separate border-spacing-0" :style="{ width: `${tableWidth}px`, minWidth: '100%' }">
          <colgroup>
            <col :style="{ width: `${widths.key}px` }" />
            <!-- The last column has no fixed width so it absorbs spare room (fixed layout would otherwise widen every
                 column, the # key column included, when the table is narrower than the modal). -->
            <col v-for="(c, i) in columns" :key="c" :style="i < columns.length - 1 ? { width: `${widths.cols[i]}px` } : undefined" />
          </colgroup>
          <thead class="sticky top-0 z-10">
            <tr class="bg-surface">
              <th class="border-b border-line bg-surface px-3 py-1.5 text-left font-sans text-[11px] font-semibold text-muted select-none">#</th>
              <th
                v-for="c in columns"
                :key="c"
                class="cursor-pointer border-b border-l border-line bg-surface px-3 py-1.5 text-left font-sans text-[11.5px] font-semibold text-fg select-none hover:bg-hover"
                :aria-sort="sortColumn === c ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'"
                @click="sortBy(c)"
              >
                <span class="flex items-center gap-1">
                  <span class="truncate" :title="c">{{ c }}</span>
                  <ArrowUp v-if="sortColumn === c && sortDir === 1" :size="12" class="shrink-0 text-accent" />
                  <ArrowDown v-else-if="sortColumn === c" :size="12" class="shrink-0 text-accent" />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="padTop" :style="{ height: `${padTop}px` }"><td :colspan="columns.length + 1" /></tr>
            <tr
              v-for="{ row, index } in visibleRows"
              :key="index"
              :class="['cursor-default', selected.has(row) ? 'bg-accent-soft' : index % 2 ? 'bg-fg/[0.025]' : '', 'hover:bg-hover']"
              :style="{ height: `${ROW_HEIGHT}px` }"
              @click="select(row, $event)"
              @contextmenu.prevent="openRowMenu(row, $event)"
            >
              <td class="truncate border-b border-line/60 px-3 text-muted tabular">{{ row.key }}</td>
              <td
                v-for="c in columns"
                :key="c"
                :class="['truncate border-b border-l border-line/60 px-3', cellClass(row.cells[c])]"
                :title="row.cells[c] ? cellText(row.cells[c]) : ''"
              >
                {{ cellDisplay(row.cells[c]) }}
              </td>
            </tr>
            <tr v-if="padBottom" :style="{ height: `${padBottom}px` }"><td :colspan="columns.length + 1" /></tr>
          </tbody>
        </table>
        <p v-if="sorted.length === 0" class="py-10 text-center font-sans text-[13px] text-muted">No entries match “{{ query }}”.</p>
      </div>
      <div class="shrink-0 border-t border-line px-5 py-2 font-sans text-[11.5px] text-muted select-none">
        Click a column to sort · ⇧-click to select a range · right-click a row to copy it as a PHP array or JSON
      </div>
    </template>
  </Modal>
</template>
