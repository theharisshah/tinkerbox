<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useUiStore } from '../../stores/ui'
import { computePosition, type Placement } from '../../utils/position'

/**
 * Anchored floating panel. Slot `trigger` (scoped: { open, toggle }) is the anchor; the default slot (scoped:
 * { close }) is the panel. `trigger`: 'click' toggles, 'hover' opens after a delay (and stays open while the
 * pointer is over the panel), 'manual' only follows v-model:open. With `id`, only one popover with an id is open
 * at a time (ui.popover). Closes on outside click and ESC.
 */
defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    placement?: Placement
    trigger?: 'click' | 'hover' | 'manual'
    offset?: number
    id?: string
    openDelay?: number
    closeDelay?: number
    panelClass?: string
    block?: boolean
  }>(),
  { placement: 'bottom-start', trigger: 'click', offset: 6, id: undefined, openDelay: 280, closeDelay: 220, panelClass: '', block: false }
)

const open = defineModel<boolean>('open', { default: false })
const ui = useUiStore()
const anchor = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const pos = ref({ x: -9999, y: -9999 })
let openTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

function clearTimers(): void {
  if (openTimer) clearTimeout(openTimer)
  if (closeTimer) clearTimeout(closeTimer)
  openTimer = closeTimer = null
}

function setOpen(value: boolean): void {
  clearTimers()
  open.value = value
}

function toggle(): void {
  setOpen(!open.value)
}

function close(): void {
  setOpen(false)
}

function place(): void {
  const a = anchor.value
  const p = panel.value
  if (!a || !p) return
  const result = computePosition(a.getBoundingClientRect(), { width: p.offsetWidth, height: p.offsetHeight }, props.placement, props.offset)
  pos.value = { x: result.x, y: result.y }
}

function onDocumentDown(event: MouseEvent): void {
  const target = event.target as Node | null
  if (!target) return
  if (anchor.value?.contains(target) || panel.value?.contains(target)) return
  close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault()
    event.stopPropagation()
    close()
  }
}

function onResize(): void {
  if (open.value) place()
}

watch(open, async (value) => {
  if (value) {
    if (props.id) ui.openPopover(props.id)
    pos.value = { x: -9999, y: -9999 }
    await nextTick()
    place()
    document.addEventListener('mousedown', onDocumentDown, true)
    // Capture phase: runs before an enclosing Modal's window listener, so ESC closes only the popover.
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('resize', onResize)
  } else {
    if (props.id) ui.closePopover(props.id)
    document.removeEventListener('mousedown', onDocumentDown, true)
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('resize', onResize)
  }
})

// Another popover (or a context menu / modal) took over.
watch(
  () => ui.popover,
  (current) => {
    if (props.id && open.value && current !== props.id) close()
  }
)

function onAnchorEnter(): void {
  if (props.trigger !== 'hover') return
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
  if (open.value) return
  openTimer = setTimeout(() => setOpen(true), props.openDelay)
}

function onLeave(): void {
  if (props.trigger !== 'hover') return
  if (openTimer) clearTimeout(openTimer)
  openTimer = null
  if (!open.value) return
  closeTimer = setTimeout(() => setOpen(false), props.closeDelay)
}

function onPanelEnter(): void {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
}

function onAnchorClick(): void {
  if (props.trigger === 'click') toggle()
}

onBeforeUnmount(() => {
  clearTimers()
  document.removeEventListener('mousedown', onDocumentDown, true)
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', onResize)
  if (props.id && open.value) ui.closePopover(props.id)
})

defineExpose({ open: () => setOpen(true), close, toggle, reposition: place })
</script>

<template>
  <span
    ref="anchor"
    v-bind="$attrs"
    :class="block ? 'flex' : 'inline-flex'"
    @mouseenter="onAnchorEnter"
    @mouseleave="onLeave"
    @click="onAnchorClick"
  >
    <slot name="trigger" :open="open" :toggle="toggle" />
  </span>
  <Teleport to="body">
    <Transition name="tw-pop">
      <div
        v-if="open"
        ref="panel"
        :class="[
          'fixed z-[500] overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-xl shadow-black/15',
          panelClass
        ]"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
        @mouseenter="onPanelEnter"
        @mouseleave="onLeave"
      >
        <slot :close="close" />
      </div>
    </Transition>
  </Teleport>
</template>
