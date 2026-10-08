<script setup lang="ts">
/**
 * Object Graph: boxes for objects / models (scalar attributes listed inside), "name (count)" boxes for arrays,
 * collections and to-many relations, connected left → right. Wheel zooms around the pointer, dragging pans,
 * clicking a box expands / collapses its children (the box stays under the pointer), Fit centers everything.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { ChevronsDownUp, ChevronsUpDown, Maximize, Minus, Network, Plus } from 'lucide-vue-next'
import type { DumpNode } from '@shared/types'
import IconButton from '../common/IconButton.vue'
import Modal from '../common/Modal.vue'
import { GRAPH_METRICS, buildGraph, initialExpanded, layoutGraph, type GraphField, type GraphNode, type LayoutBox } from './lib/graph'

const props = defineProps<{ value: DumpNode; title?: string }>()
defineEmits<{ close: [result?: unknown] }>()

const M = GRAPH_METRICS
const graph = shallowRef(buildGraph(props.value))
const expanded = ref(initialExpanded(graph.value, 2))
const layout = computed(() => layoutGraph(graph.value, (id) => expanded.value.has(id)))
const boxes = computed(() => Object.values(layout.value.boxes))
const nodeCount = computed(() => Object.keys(graph.value.nodes).length)

const view = reactive({ x: 40, y: 40, k: 1 })
const canvas = ref<HTMLElement | null>(null)
const size = reactive({ w: 900, h: 600 })
let observer: ResizeObserver | null = null

// -- view ------------------------------------------------------------------------------------------------------------

function clampScale(k: number): number {
  return Math.min(2.5, Math.max(0.15, k))
}

function zoomAt(factor: number, cx = size.w / 2, cy = size.h / 2): void {
  const k = clampScale(view.k * factor)
  const ratio = k / view.k
  view.x = cx - (cx - view.x) * ratio
  view.y = cy - (cy - view.y) * ratio
  view.k = k
}

function fit(): void {
  const pad = 40
  const w = Math.max(1, layout.value.width)
  const h = Math.max(1, layout.value.height)
  const k = clampScale(Math.min(1.1, (size.w - pad * 2) / w, (size.h - pad * 2) / h))
  view.k = k
  view.x = (size.w - w * k) / 2
  view.y = (size.h - h * k) / 2
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const rect = canvas.value?.getBoundingClientRect()
  if (!rect) return
  // Pinch gestures arrive as ctrl+wheel with small deltas; mouse wheels as larger steps.
  const speed = event.ctrlKey ? 0.01 : 0.0018
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
  zoomAt(Math.exp(-delta * speed), event.clientX - rect.left, event.clientY - rect.top)
}

let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; pointer: number } | null = null
let suppressClick = false

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false, pointer: event.pointerId }
  suppressClick = false
}

function onPointerMove(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointer) return
  const dx = event.clientX - drag.x
  const dy = event.clientY - drag.y
  if (!drag.moved && Math.hypot(dx, dy) > 3) {
    drag.moved = true
    canvas.value?.setPointerCapture(event.pointerId)
  }
  if (drag.moved) {
    view.x = drag.vx + dx
    view.y = drag.vy + dy
  }
}

function onPointerUp(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointer) return
  suppressClick = drag.moved
  if (drag.moved && canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId)
  drag = null
}

// -- expand / collapse ------------------------------------------------------------------------------------------------

function toggle(node: GraphNode): void {
  if (suppressClick) {
    suppressClick = false
    return
  }
  if (!node.children.length) return
  const before = layout.value.boxes[node.id]
  const next = new Set(expanded.value)
  if (next.has(node.id)) next.delete(node.id)
  else next.add(node.id)
  expanded.value = next
  // Keep the clicked box where it was on screen.
  const after = layout.value.boxes[node.id]
  if (before && after) {
    view.x += (before.x - after.x) * view.k
    view.y += (before.y - after.y) * view.k
  }
}

function expandAll(): void {
  expanded.value = new Set(Object.values(graph.value.nodes).filter((n) => n.children.length).map((n) => n.id))
  void nextTick(fit)
}

function collapseAll(): void {
  expanded.value = new Set([graph.value.root])
  void nextTick(fit)
}

// -- drawing ----------------------------------------------------------------------------------------------------------

const FIELD_CLASS: Record<string, string> = {
  string: 'fill-code-string',
  int: 'fill-code-number',
  float: 'fill-code-number',
  bool: 'fill-code-bool',
  null: 'fill-code-null',
  enum: 'fill-code-keyword',
  summary: 'fill-code-string',
  ref: 'fill-code-meta',
  closure: 'fill-code-keyword',
  'max-depth': 'fill-muted'
}

function fieldClass(field: GraphField): string {
  return FIELD_CLASS[field.type] ?? 'fill-muted'
}

function clipText(text: string, box: LayoutBox, used = 0, charWidth = M.charWidth): string {
  const max = Math.floor((box.w - M.padX * 2) / charWidth) - used
  if (max <= 1) return ''
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function headerFill(node: GraphNode): string {
  if (node.kind === 'model') return 'fill-accent/15'
  if (node.kind === 'group') return 'fill-code-key/10'
  if (node.kind === 'more') return 'fill-transparent'
  return 'fill-fg/5'
}

function nodeOf(id: string): GraphNode {
  return graph.value.nodes[id]
}

const gridSize = computed(() => 24 * view.k)

function onKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const step = event.shiftKey ? 160 : 60
  switch (event.key) {
    case '+':
    case '=':
      zoomAt(1.2)
      break
    case '-':
    case '_':
      zoomAt(1 / 1.2)
      break
    case '0':
      fit()
      break
    case 'ArrowLeft':
      view.x += step
      break
    case 'ArrowRight':
      view.x -= step
      break
    case 'ArrowUp':
      view.y += step
      break
    case 'ArrowDown':
      view.y -= step
      break
    default:
      return
  }
  event.preventDefault()
}

onMounted(() => {
  if (!canvas.value) return
  const measure = (): void => {
    if (!canvas.value) return
    size.w = canvas.value.clientWidth
    size.h = canvas.value.clientHeight
  }
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(canvas.value)
  canvas.value.addEventListener('wheel', onWheel, { passive: false })
  void nextTick(fit)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  canvas.value?.removeEventListener('wheel', onWheel)
})
</script>

<template>
  <Modal
    size="full"
    :padded="false"
    body-class="flex flex-col"
    aria-label="Object Graph"
    initial-focus="[data-graph-canvas]"
    @close="$emit('close')"
  >
    <template #title>
      <span class="flex items-center gap-2">
        Object Graph
        <span v-if="title" class="truncate font-mono text-[12px] font-normal text-muted">{{ title }}</span>
      </span>
    </template>
    <template #actions>
      <span class="mr-1 font-sans text-[11.5px] text-muted tabular">{{ Math.round(view.k * 100) }}%</span>
      <IconButton :icon="Minus" label="Zoom out" size="sm" @click="zoomAt(1 / 1.2)" />
      <IconButton :icon="Plus" label="Zoom in" size="sm" @click="zoomAt(1.2)" />
      <IconButton :icon="Maximize" label="Fit to screen" size="sm" @click="fit" />
      <IconButton :icon="ChevronsUpDown" label="Expand all" size="sm" @click="expandAll" />
      <IconButton :icon="ChevronsDownUp" label="Collapse all" size="sm" @click="collapseAll" />
    </template>

    <div
      ref="canvas"
      data-graph-canvas
      tabindex="0"
      aria-label="Object graph canvas: + / - zoom, 0 fits, arrow keys pan"
      class="relative min-h-0 flex-1 cursor-grab outline-none touch-none overflow-hidden border-t border-line bg-app-alt select-none active:cursor-grabbing"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
    >
      <svg class="absolute inset-0 h-full w-full" role="img" :aria-label="`Object graph with ${nodeCount} nodes`">
        <defs>
          <pattern id="tw-graph-grid" :width="gridSize" :height="gridSize" patternUnits="userSpaceOnUse" :x="view.x % gridSize" :y="view.y % gridSize">
            <circle :cx="1" :cy="1" :r="Math.max(0.6, 1.1 * Math.min(1, view.k))" class="fill-muted/35" />
          </pattern>
          <marker id="tw-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" class="fill-muted/60" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill="url(#tw-graph-grid)" />
        <g :transform="`translate(${view.x} ${view.y}) scale(${view.k})`" class="font-mono">
          <g v-for="edge in layout.edges" :key="`${edge.from}>${edge.to}`">
            <path :d="edge.path" class="fill-none stroke-muted/45" stroke-width="1.4" marker-end="url(#tw-graph-arrow)" />
            <text v-if="edge.label" :x="edge.lx" :y="edge.ly" text-anchor="end" class="fill-muted text-[10.5px]">{{ edge.label }}</text>
          </g>
          <g
            v-for="box in boxes"
            :key="box.id"
            :transform="`translate(${box.x} ${box.y})`"
            :class="nodeOf(box.id).children.length ? 'cursor-pointer' : ''"
            @click.stop="toggle(nodeOf(box.id))"
          >
            <title>{{ nodeOf(box.id).subtitle || nodeOf(box.id).title }}{{ nodeOf(box.id).children.length ? ' — click to expand / collapse' : '' }}</title>
            <rect
              :width="box.w"
              :height="box.h"
              rx="9"
              :class="[
                nodeOf(box.id).kind === 'more' ? 'fill-surface/60 stroke-line' : 'fill-surface',
                box.id === graph.root ? 'stroke-accent' : 'stroke-line',
                'transition-colors hover:stroke-accent'
              ]"
              :stroke-width="box.id === graph.root ? 1.6 : 1.1"
              :stroke-dasharray="nodeOf(box.id).kind === 'more' ? '4 3' : undefined"
            />
            <path
              :d="`M 0 9 a 9 9 0 0 1 9 -9 h ${box.w - 18} a 9 9 0 0 1 9 9 v ${M.headerHeight + (nodeOf(box.id).subtitle ? M.subtitleHeight : 0) - 9} h ${-box.w} z`"
              :class="headerFill(nodeOf(box.id))"
              pointer-events="none"
            />
            <text :x="M.padX" :y="19" class="text-[12.5px] font-semibold" :class="nodeOf(box.id).kind === 'group' ? 'fill-code-key' : nodeOf(box.id).kind === 'more' ? 'fill-muted' : 'fill-code-class'">
              {{ clipText(nodeOf(box.id).title, box, nodeOf(box.id).children.length ? 3 : 0) }}
            </text>
            <text v-if="nodeOf(box.id).subtitle" :x="M.padX" :y="M.headerHeight + 8" class="fill-muted text-[10px]">
              {{ clipText(nodeOf(box.id).subtitle ?? '', box, 0, 6.05) }}
            </text>
            <g v-if="nodeOf(box.id).children.length">
              <circle :cx="box.w - 14" :cy="15" r="8" :class="expanded.has(box.id) ? 'fill-fg/5' : 'fill-accent'" />
              <text
                :x="box.w - 14"
                :y="expanded.has(box.id) ? 19 : 18.5"
                text-anchor="middle"
                :class="['font-sans text-[11px] font-bold', expanded.has(box.id) ? 'fill-muted' : 'fill-on-accent']"
              >
                {{ expanded.has(box.id) ? '−' : nodeOf(box.id).children.length > 9 ? '+' : `${nodeOf(box.id).children.length}` }}
              </text>
            </g>
            <g :transform="`translate(0 ${M.headerHeight + (nodeOf(box.id).subtitle ? M.subtitleHeight : 0) + 4})`">
              <text
                v-for="(field, i) in nodeOf(box.id).fields"
                :key="i"
                :x="M.padX"
                :y="i * M.lineHeight + 12"
                class="text-[12px]"
              >
                <tspan class="fill-code-property">{{ clipText(field.key, box) }}</tspan
                ><tspan class="fill-muted">: </tspan
                ><tspan :class="fieldClass(field)">{{ clipText(field.value, box, Math.min(field.key.length, 40) + 2) }}</tspan>
              </text>
              <text
                v-if="nodeOf(box.id).hiddenFields > 0"
                :x="M.padX"
                :y="nodeOf(box.id).fields.length * M.lineHeight + 12"
                class="fill-muted text-[11px] italic"
              >
                … {{ nodeOf(box.id).hiddenFields }} more
              </text>
            </g>
          </g>
        </g>
      </svg>

      <div
        v-if="graph.omitted"
        class="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-surface/90 px-2.5 py-1 font-sans text-[11.5px] text-muted shadow-sm ring-1 ring-line"
      >
        {{ graph.omitted.toLocaleString() }} more values are not drawn (graph size limit)
      </div>
      <div class="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1.5 rounded-lg bg-surface/90 px-2.5 py-1 font-sans text-[11.5px] text-muted shadow-sm ring-1 ring-line">
        <Network :size="12" /> Scroll to zoom · drag to pan · click a box to expand or collapse
      </div>
    </div>
  </Modal>
</template>
