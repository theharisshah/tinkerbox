<script setup lang="ts">
/**
 * One node of a DumpTree (recursive). VarDumper conventions: `array:N [`, `"key" => value`, `Class {#id`,
 * `+public`, `#protected`, `-private`, `+"dynamic"`; models group attributes / relations / meta.
 */
import { computed, inject } from 'vue'
import { Eye } from 'lucide-vue-next'
import type { DumpItem, DumpNode, DumpProperty } from '@shared/types'
import { pluralize } from '../../utils/format'
import { DUMP_PAGE, DUMP_TREE, STRING_PAGE } from './treeContext'
import { escapeSegments, groupProps, hasHtml, isExpandable, splitClass, type PropGroup } from './lib/dump'

defineOptions({ name: 'DumpValue' })

const props = defineProps<{ node: DumpNode; path: string; depth: number }>()
const ctx = inject(DUMP_TREE)!

const node = computed(() => props.node)
const open = computed(() => ctx.isOpen(props.path, props.depth))
const expandable = computed(() => isExpandable(props.node))

function toggle(event: MouseEvent): void {
  if (!expandable.value) return
  // Keep text selection gestures (drag-select over a header) from toggling.
  const selection = window.getSelection()
  if (selection && selection.type === 'Range' && !selection.isCollapsed && event.detail > 0 && !(event.target as HTMLElement).closest('.dump-toggle')) return
  ctx.toggle(props.path, props.node, props.depth, event)
}

// -- strings ---------------------------------------------------------------------------------------------------

const stringNode = computed(() => (props.node.t === 'string' ? props.node : null))
const stringLimit = computed(() => ctx.limitOf(`${props.path}~s`, STRING_PAGE))
const stringShown = computed(() => {
  const s = stringNode.value
  if (!s) return ''
  return s.v.length > stringLimit.value ? s.v.slice(0, stringLimit.value) : s.v
})
const stringSegments = computed(() => (stringNode.value?.binary ? [{ text: stringShown.value, escape: false }] : escapeSegments(stringShown.value)))
const stringHidden = computed(() => (stringNode.value ? Math.max(0, stringNode.value.v.length - stringShown.value.length) : 0))

// -- containers ------------------------------------------------------------------------------------------------

interface Entry {
  item: DumpItem
  index: number
}

const items = computed<DumpItem[]>(() => {
  const n = props.node
  if (n.t === 'array') return n.items
  if (n.t === 'object') return n.items ?? []
  return []
})
const itemLimit = computed(() => ctx.limitOf(props.path, DUMP_PAGE))
const shownItems = computed<Entry[]>(() => items.value.slice(0, itemLimit.value).map((item, index) => ({ item, index })))
const hiddenItems = computed(() => Math.max(0, items.value.length - itemLimit.value))
const totalCount = computed(() => {
  const n = props.node
  if (n.t === 'array') return n.count
  if (n.t === 'object') return n.count ?? n.items?.length ?? 0
  return 0
})
const truncatedItems = computed(() => {
  const n = props.node
  const notDumped = totalCount.value - items.value.length
  if (notDumped > 0) return notDumped
  return (n.t === 'array' || n.t === 'object') && n.truncated ? -1 : 0
})

interface IndexedGroup extends PropGroup {
  entries: Array<{ prop: DumpProperty; index: number }>
}

const groups = computed<IndexedGroup[]>(() => {
  const n = props.node
  if (n.t !== 'object') return []
  const indexOf = new Map<DumpProperty, number>()
  n.props.forEach((p, i) => indexOf.set(p, i))
  return groupProps(n).map((g) => ({ ...g, entries: g.props.map((prop) => ({ prop, index: indexOf.get(prop) ?? 0 })) }))
})
const labelGroups = computed(() => groups.value.length > 1 || (groups.value.length === 1 && groups.value[0].id !== 'props' && groups.value[0].id !== 'meta'))

const cls = computed(() => {
  const n = props.node
  return n.t === 'object' || n.t === 'ref' || n.t === 'enum' || (n.t === 'max-depth' && n.class) ? splitClass((n as { class: string }).class) : null
})

const objectSummary = computed<{ kind: 'chip' | 'string' | 'date' | 'sql' | 'muted' | 'danger'; text: string } | null>(() => {
  const n = props.node
  if (n.t !== 'object') return null
  switch (n.kind) {
    case 'model':
      return n.summary ? { kind: 'chip', text: n.summary } : null
    case 'collection':
      return { kind: 'chip', text: pluralize(n.count ?? n.items?.length ?? 0, 'item') }
    case 'datetime':
      return n.summary ? { kind: 'date', text: n.summary } : null
    case 'builder':
      return n.summary ? { kind: 'sql', text: n.summary.length > 160 ? n.summary.slice(0, 159) + '…' : n.summary } : null
    case 'stringable':
      return n.summary !== undefined ? { kind: 'string', text: n.summary.length > 200 ? n.summary.slice(0, 199) + '…' : n.summary } : null
    case 'exception':
      return n.summary ? { kind: 'danger', text: n.summary.length > 200 ? n.summary.slice(0, 199) + '…' : n.summary } : null
    case 'html':
      return n.summary ? { kind: 'muted', text: n.summary } : null
    default:
      return n.summary ? { kind: 'muted', text: n.summary } : null
  }
})

const htmlNode = computed(() => (hasHtml(props.node) ? props.node : null))
const highlighted = computed(() => props.node.t === 'object' && ctx.highlightId.value === props.node.id)
const metaKey = computed(() => `${props.path}~meta`)
/** Meta-only objects (Carbon, builders, paginators…) show their meta values right away; models fold them. */
const metaDefaultOpen = computed(() => props.node.t === 'object' && props.node.kind !== 'model' && groups.value.every((g) => g.id === 'meta'))

function propPrefix(p: DumpProperty): string {
  switch (p.vis) {
    case 'public':
    case 'dynamic':
      return '+'
    case 'protected':
      return '#'
    case 'private':
      return '-'
    default:
      return ''
  }
}

function propTitle(p: DumpProperty): string {
  if (p.vis === 'private' && p.declaringClass) return `private (declared in ${p.declaringClass})`
  return p.vis === 'attribute' ? 'attribute' : p.vis === 'relation' ? 'loaded relation' : p.vis
}

function closureLocation(n: Extract<DumpNode, { t: 'closure' }>): string {
  if (n.file) return `${n.file}${n.line ? `:${n.line}` : ''}`
  return n.line ? `line ${n.line}` : ''
}
</script>

<template>
  <!-- scalars -->
  <span v-if="node.t === 'null'" class="text-code-null">null</span>
  <span v-else-if="node.t === 'bool'" class="text-code-bool">{{ node.v ? 'true' : 'false' }}</span>
  <span v-else-if="node.t === 'int' || node.t === 'float'" class="text-code-number">{{ node.v }}</span>

  <!-- strings -->
  <span v-else-if="node.t === 'string'" class="whitespace-pre-wrap">
    <span class="text-code-string"
      ><span v-if="node.binary" class="text-code-meta">b</span>"<template v-for="(seg, i) in stringSegments" :key="i"
        ><span v-if="seg.escape" class="text-code-meta">{{ seg.text }}</span
        ><template v-else>{{ seg.text }}</template></template
      >"</span
    ><span v-if="stringHidden > 0" class="select-none"
      >…<button
        type="button"
        class="ml-1 rounded px-1 font-sans text-[0.8em] text-accent hover:bg-hover"
        @click="ctx.showMore(`${path}~s`, stringHidden, stringShown.length)"
      >
        show {{ stringHidden.toLocaleString() }} more characters
      </button></span
    ><span
      v-if="node.truncated"
      class="text-muted"
      :title="`Truncated: the string has ${node.len.toLocaleString()} ${node.binary ? 'bytes' : 'characters'} (Settings → Output → max string length)`"
      >…<span class="ml-1 text-[0.82em] select-none">({{ node.len.toLocaleString() }})</span></span
    >
  </span>

  <!-- arrays -->
  <span v-else-if="node.t === 'array'">
    <template v-if="node.count === 0"><span class="text-muted">[]</span></template>
    <template v-else>
      <span class="cursor-pointer" @click="toggle"><span class="text-code-keyword">array:{{ node.count }}</span> <span class="text-muted">[</span></span
      ><span class="dump-toggle" role="button" :aria-expanded="open" :title="open ? 'Collapse (⌥-click: all)' : 'Expand (⌥-click: all)'" @click.stop="toggle">{{
        open ? '▾' : '▸'
      }}</span>
      <template v-if="open">
        <div class="dump-children">
          <div v-for="{ item, index } in shownItems" :key="index">
            <span v-if="typeof item.k === 'number'" class="text-code-number">{{ item.k }}</span
            ><span v-else class="text-code-key">"{{ item.k }}"</span><span class="text-muted"> => </span
            ><DumpValue :node="item.v" :path="`${path}.i${index}`" :depth="depth + 1" />
          </div>
          <div v-if="hiddenItems > 0" class="select-none">
            <button type="button" class="rounded px-1 font-sans text-[0.85em] text-accent hover:bg-hover" @click="ctx.showMore(path, 500, itemLimit)">
              … show {{ Math.min(500, hiddenItems).toLocaleString() }} more of {{ hiddenItems.toLocaleString() }}
            </button>
          </div>
          <div v-if="truncatedItems !== 0" class="text-code-comment italic select-none" title="Not dumped (Settings → Output → max items)">
            …{{ truncatedItems > 0 ? `${truncatedItems.toLocaleString()} more` : '' }}
          </div>
        </div>
        <span class="text-muted">]</span>
      </template>
      <span v-else class="text-muted">]</span>
    </template>
  </span>

  <!-- objects -->
  <span v-else-if="node.t === 'object'">
    <span
      :data-dump-path="path"
      :class="['rounded-sm transition-colors', expandable ? 'cursor-pointer' : '', highlighted ? 'bg-accent/15 ring-1 ring-accent/40' : '']"
      @click="toggle"
      ><span v-if="cls?.ns" class="text-code-class opacity-60">{{ cls.ns }}</span><span class="font-medium text-code-class">{{ cls?.name }}</span></span
    >
    <template v-if="objectSummary">
      <span
        v-if="objectSummary.kind === 'chip'"
        class="mx-1 rounded-md bg-accent-soft px-1.5 py-px align-[0.08em] font-sans text-[0.78em] font-semibold text-accent"
        >{{ objectSummary.text }}</span
      >
      <span v-else-if="objectSummary.kind === 'date' || objectSummary.kind === 'string'" class="ml-[1ch] text-code-string">{{
        objectSummary.kind === 'string' ? `"${objectSummary.text}"` : objectSummary.text
      }}</span>
      <span v-else-if="objectSummary.kind === 'sql'" class="ml-[1ch] text-code-keyword" :title="node.summary">{{ objectSummary.text }}</span>
      <span v-else-if="objectSummary.kind === 'danger'" class="ml-[1ch] text-danger">{{ objectSummary.text }}</span>
      <span v-else class="ml-[1ch] text-muted italic">{{ objectSummary.text }}</span>
    </template>
    <button
      v-if="htmlNode"
      type="button"
      class="mx-1 inline-flex items-center gap-1 rounded-md bg-accent-soft px-1.5 py-px align-[0.05em] font-sans text-[0.78em] font-semibold text-accent select-none hover:bg-accent hover:text-on-accent"
      title="HTML Preview"
      @click.stop="ctx.openHtml(htmlNode)"
    >
      <Eye :size="12" :stroke-width="2.2" /> Preview
    </button>
    <span class="text-muted"> {</span><span class="text-code-meta">#{{ node.id }}</span>
    <template v-if="expandable">
      <span class="dump-toggle" role="button" :aria-expanded="open" :title="open ? 'Collapse (⌥-click: all)' : 'Expand (⌥-click: all)'" @click.stop="toggle">{{
        open ? '▾' : '▸'
      }}</span>
      <template v-if="open">
        <div class="dump-children">
          <template v-for="group in groups" :key="group.id">
            <template v-if="group.id === 'meta'">
              <div v-if="!metaDefaultOpen" class="select-none">
                <span class="cursor-pointer text-code-comment italic hover:text-fg" @click="ctx.toggleSection(metaKey)"
                  >{{ ctx.sectionOpen(metaKey) ? '▾' : '▸' }} meta</span
                >
              </div>
              <template v-if="metaDefaultOpen || ctx.sectionOpen(metaKey)">
                <div v-for="{ prop, index } in group.entries" :key="index">
                  <span class="text-code-meta" :title="propTitle(prop)">{{ prop.name }}</span><span class="text-muted">: </span
                  ><DumpValue :node="prop.v" :path="`${path}.p${index}`" :depth="depth + 1" />
                </div>
              </template>
            </template>
            <template v-else>
              <div v-if="labelGroups" class="text-code-comment italic select-none">// {{ group.label }}</div>
              <div v-for="{ prop, index } in group.entries" :key="index">
                <span class="text-muted">{{ propPrefix(prop) }}</span
                ><span class="text-code-property" :title="propTitle(prop)">{{ prop.vis === 'dynamic' ? `"${prop.name}"` : prop.name }}</span
                ><span class="text-muted">: </span><DumpValue :node="prop.v" :path="`${path}.p${index}`" :depth="depth + 1" />
              </div>
            </template>
          </template>
          <template v-if="items.length || totalCount">
            <div v-if="groups.length" class="text-code-comment italic select-none">// {{ pluralize(totalCount, 'item') }}</div>
            <div v-for="{ item, index } in shownItems" :key="`i${index}`">
              <span v-if="typeof item.k === 'number'" class="text-code-number">{{ item.k }}</span
              ><span v-else class="text-code-key">"{{ item.k }}"</span><span class="text-muted"> => </span
              ><DumpValue :node="item.v" :path="`${path}.i${index}`" :depth="depth + 1" />
            </div>
            <div v-if="hiddenItems > 0" class="select-none">
              <button type="button" class="rounded px-1 font-sans text-[0.85em] text-accent hover:bg-hover" @click="ctx.showMore(path, 500, itemLimit)">
                … show {{ Math.min(500, hiddenItems).toLocaleString() }} more of {{ hiddenItems.toLocaleString() }}
              </button>
            </div>
          </template>
          <div v-if="truncatedItems !== 0" class="text-code-comment italic select-none" title="Not dumped (Settings → Output → max items / depth)">
            …{{ truncatedItems > 0 ? `${truncatedItems.toLocaleString()} more` : '' }}
          </div>
        </div>
        <span class="text-muted">}</span>
      </template>
      <span v-else class="text-muted">}</span>
    </template>
    <span v-else class="text-muted">}</span>
  </span>

  <!-- references -->
  <span v-else-if="node.t === 'ref'" class="whitespace-nowrap">
    <span v-if="cls?.ns" class="text-code-class opacity-60">{{ cls.ns }}</span><span class="font-medium text-code-class">{{ cls?.name }}</span
    ><span class="text-muted"> {</span
    ><span
      class="cursor-pointer text-code-meta underline decoration-dotted underline-offset-2 hover:text-accent"
      :title="`Same object as #${node.id} above (click to show it)`"
      @mouseenter="ctx.highlightId.value = node.id"
      @mouseleave="ctx.highlightId.value = null"
      @click="ctx.revealObject(node.id)"
      >#{{ node.id }}</span
    ><span class="text-muted">}</span><span class="ml-0.5 text-muted select-none" aria-hidden="true">↑</span>
  </span>

  <!-- enums -->
  <span v-else-if="node.t === 'enum'">
    <span v-if="cls?.ns" class="text-code-class opacity-60">{{ cls.ns }}</span><span class="font-medium text-code-class">{{ cls?.name }}</span
    ><span class="text-muted">::</span><span class="text-code-keyword">{{ node.case }}</span>
    <template v-if="node.value !== undefined">
      <span class="text-muted"> = </span
      ><span :class="typeof node.value === 'number' ? 'text-code-number' : 'text-code-string'">{{
        typeof node.value === 'number' ? node.value : `&quot;${node.value}&quot;`
      }}</span>
    </template>
  </span>

  <!-- closures -->
  <span v-else-if="node.t === 'closure'">
    <span class="font-medium text-code-class">Closure</span> <span class="text-code-keyword">{{ node.signature }}</span>
    <button
      v-if="closureLocation(node)"
      type="button"
      class="ml-1 font-sans text-[0.82em] text-muted underline decoration-dotted underline-offset-2 select-none hover:text-accent"
      :title="node.file ? 'Open in your editor' : 'Show in the editor'"
      @click="ctx.openLocation(node.file, node.line)"
    >
      {{ closureLocation(node) }}
    </button>
  </span>

  <!-- resources -->
  <span v-else-if="node.t === 'resource'"
    ><span class="text-code-keyword">{{ node.type }} resource</span> <span class="text-code-meta">@{{ node.id }}</span></span
  >

  <!-- depth limit -->
  <span v-else-if="node.t === 'max-depth'" class="text-muted italic" title="Maximum depth reached (Settings → Output → max depth)">
    <template v-if="node.class"
      ><span class="text-code-class not-italic opacity-80">{{ node.class }}</span> {…}</template
    >
    <template v-else>{{ node.type }}{{ node.count !== undefined ? `:${node.count}` : '' }} […]</template>
  </span>
</template>
