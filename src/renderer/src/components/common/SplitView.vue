<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

/**
 * Two resizable panes. `layout` uses the settings semantics: 'vertical' = vertical divider (panes side by side,
 * `first` left), 'horizontal' = horizontal divider (`first` on top). `v-model:ratio` is the first pane's fraction;
 * it updates live while dragging and `commit` fires once at the end of a drag / double-click reset (persist there).
 * `showSecond=false` hides the second pane (it stays mounted).
 */
const props = withDefaults(
  defineProps<{
    layout?: 'vertical' | 'horizontal'
    minFirst?: number
    minSecond?: number
    defaultRatio?: number
    minRatio?: number
    maxRatio?: number
    showSecond?: boolean
  }>(),
  { layout: 'vertical', minFirst: 180, minSecond: 160, defaultRatio: 0.55, minRatio: 0.15, maxRatio: 0.85, showSecond: true }
)

const emit = defineEmits<{ commit: [ratio: number] }>()
const ratio = defineModel<number>('ratio', { default: 0.55 })

const container = ref<HTMLElement | null>(null)
const dragging = ref(false)
/** The pointer moved during the current drag (the overlay only appears then; see the template). */
const moved = ref(false)
const isRow = computed(() => props.layout === 'vertical')

const clamped = computed(() => Math.min(props.maxRatio, Math.max(props.minRatio, Number.isFinite(ratio.value) ? ratio.value : props.defaultRatio)))

const firstStyle = computed(() => {
  if (!props.showSecond) return { flex: '1 1 auto' }
  const pct = `${(clamped.value * 100).toFixed(3)}%`
  return isRow.value
    ? { flex: `0 0 ${pct}`, minWidth: `${props.minFirst}px` }
    : { flex: `0 0 ${pct}`, minHeight: `${props.minFirst}px` }
})

const secondStyle = computed(() =>
  isRow.value ? { minWidth: `${props.minSecond}px` } : { minHeight: `${props.minSecond}px` }
)

function ratioAt(event: PointerEvent): number {
  const el = container.value
  if (!el) return clamped.value
  const rect = el.getBoundingClientRect()
  const total = isRow.value ? rect.width : rect.height
  if (total <= 0) return clamped.value
  const offset = isRow.value ? event.clientX - rect.left : event.clientY - rect.top
  const minR = Math.max(props.minRatio, props.minFirst / total)
  const maxR = Math.min(props.maxRatio, 1 - props.minSecond / total)
  return Math.min(Math.max(offset / total, minR), Math.max(minR, maxR))
}

function onMove(event: PointerEvent): void {
  moved.value = true
  ratio.value = Number(ratioAt(event).toFixed(4))
}

function stop(): void {
  if (!dragging.value) return
  dragging.value = false
  moved.value = false
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', stop)
  window.removeEventListener('pointercancel', stop)
  document.body.style.cursor = ''
  emit('commit', clamped.value)
}

function start(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  dragging.value = true
  document.body.style.cursor = isRow.value ? 'col-resize' : 'row-resize'
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
}

function reset(): void {
  ratio.value = props.defaultRatio
  emit('commit', props.defaultRatio)
}

function onKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 0.1 : 0.02
  const dec = isRow.value ? 'ArrowLeft' : 'ArrowUp'
  const inc = isRow.value ? 'ArrowRight' : 'ArrowDown'
  if (event.key !== dec && event.key !== inc) return
  event.preventDefault()
  const next = Math.min(props.maxRatio, Math.max(props.minRatio, clamped.value + (event.key === inc ? step : -step)))
  ratio.value = Number(next.toFixed(4))
  emit('commit', ratio.value)
}

onBeforeUnmount(stop)
</script>

<template>
  <div ref="container" :class="['relative flex h-full w-full min-h-0 min-w-0', isRow ? 'flex-row' : 'flex-col']">
    <div class="relative flex min-h-0 min-w-0 flex-col overflow-hidden" :style="firstStyle">
      <slot name="first" />
    </div>
    <div
      v-show="showSecond"
      role="separator"
      tabindex="0"
      :aria-orientation="isRow ? 'vertical' : 'horizontal'"
      :aria-valuenow="Math.round(clamped * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
      title="Drag to resize · double-click to reset"
      :class="[
        'group relative z-10 shrink-0 bg-line outline-none',
        isRow ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'
      ]"
      @pointerdown="start"
      @dblclick="reset"
      @keydown="onKeydown"
      >
      <span
        :class="[
          'absolute transition-colors duration-150 group-hover:bg-accent/45 group-focus-visible:bg-accent/60',
          isRow ? 'inset-y-0 -left-[3px] w-[7px]' : 'inset-x-0 -top-[3px] h-[7px]',
          dragging ? 'bg-accent/60' : ''
        ]"
      />
    </div>
    <div v-show="showSecond" class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" :style="secondStyle">
      <slot name="second" />
    </div>
    <!-- Keeps iframes / Monaco from swallowing pointer events while dragging. Only once the pointer moves: an overlay
         under a plain click would retarget click / dblclick away from the separator (double-click reset). -->
    <div v-if="dragging && moved" :class="['absolute inset-0 z-20', isRow ? 'cursor-col-resize' : 'cursor-row-resize']" />
  </div>
</template>
