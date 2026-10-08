<script setup lang="ts">
/**
 * Symfony VarDumper-style tree of a dumped value (Cards view). Owns the expand / collapse state of every
 * container (keyed by path), reference highlighting and paging; DumpValue renders the nodes recursively.
 */
import { computed, nextTick, onBeforeUnmount, provide, reactive, ref, watch } from 'vue'
import type { DumpNode } from '@shared/types'
import { useSettingsStore } from '../../stores/settings'
import { openHtmlPreview, openInEditor, revealLine } from './actions'
import { DUMP_TREE, type DumpTreeContext } from './treeContext'
import DumpValue from './DumpValue.vue'
import { ancestorPaths, expandablePaths, htmlTitle, objectPaths, type HtmlNode } from './lib/dump'

const props = withDefaults(defineProps<{ value: DumpNode; tabId?: string; connectionId?: string | null }>(), {
  tabId: undefined,
  connectionId: null
})

const settings = useSettingsStore()
const overrides = reactive(new Map<string, boolean>())
const sections = reactive(new Map<string, boolean>())
const limits = reactive(new Map<string, number>())
const highlightId = ref<number | null>(null)
const root = ref<HTMLElement | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | null = null

const paths = computed(() => objectPaths(props.value))

watch(
  () => props.value,
  () => {
    overrides.clear()
    sections.clear()
    limits.clear()
  }
)

function defaultOpen(depth: number): boolean {
  if (depth === 0) return true
  // Expanded trees stay bounded: very deep levels open on demand.
  return !settings.settings.collapseNested && depth < 6
}

function isOpen(path: string, depth: number): boolean {
  return overrides.get(path) ?? defaultOpen(depth)
}

function toggle(path: string, node: DumpNode, depth: number, event?: MouseEvent): void {
  const next = !isOpen(path, depth)
  if (event?.altKey) {
    for (const p of expandablePaths(node, path)) overrides.set(p, next)
  } else {
    overrides.set(path, next)
  }
}

function revealObject(id: number): void {
  const path = paths.value.get(id)
  if (!path) return
  for (const ancestor of ancestorPaths(path)) overrides.set(ancestor, true)
  // Make sure paged containers render the target element.
  const parts = path.split('.')
  for (let i = 1; i < parts.length; i++) {
    const m = /^i(\d+)$/.exec(parts[i])
    if (!m) continue
    const parent = parts.slice(0, i).join('.')
    const index = Number(m[1])
    if ((limits.get(parent) ?? 0) <= index) limits.set(parent, index + 1)
  }
  highlightId.value = id
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    if (highlightId.value === id) highlightId.value = null
  }, 1400)
  void nextTick(() => {
    const el = root.value?.querySelector<HTMLElement>(`[data-dump-path="${path}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

const context: DumpTreeContext = {
  isOpen,
  toggle,
  sectionOpen: (key, fallback = false) => sections.get(key) ?? fallback,
  toggleSection: (key, fallback = false) => sections.set(key, !(sections.get(key) ?? fallback)),
  limitOf: (path, fallback) => Math.max(limits.get(path) ?? 0, fallback),
  showMore: (path, step, fallback) => limits.set(path, Math.max(limits.get(path) ?? 0, fallback) + step),
  highlightId,
  revealObject,
  openLocation: (file, line) => {
    if (file) void openInEditor(file, line, props.connectionId ?? null)
    else revealLine(props.tabId, line)
  },
  openHtml: (node: HtmlNode) => openHtmlPreview(node.html, htmlTitle(node), props.tabId)
}
provide(DUMP_TREE, context)

onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer)
})
</script>

<template>
  <div ref="root" class="dump-tree selectable font-mono leading-[1.6] break-words text-fg">
    <DumpValue :node="value" path="r" :depth="0" />
  </div>
</template>

<style scoped>
.dump-tree :deep(.dump-toggle) {
  display: inline-block;
  width: 1.1em;
  text-align: center;
  user-select: none;
  -webkit-user-select: none;
  cursor: pointer;
  color: var(--tw-text-muted);
  border-radius: 4px;
}

.dump-tree :deep(.dump-toggle:hover) {
  color: var(--tw-accent);
  background: var(--tw-hover);
}

.dump-tree :deep(.dump-children) {
  padding-left: 2ch;
  border-left: 1px dashed transparent;
}

.dump-tree :deep(.dump-children:hover) {
  border-left-color: color-mix(in srgb, var(--tw-border) 80%, transparent);
}
</style>
