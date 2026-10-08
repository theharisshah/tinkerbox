<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { formatAccelerator } from '../../utils/accelerator'
import { platform } from '../../utils/platform'
import { computePosition, type Placement } from '../../utils/position'

/**
 * Hover / focus tooltip around the default slot. Shows `text` and, when given, the formatted `shortcut`
 * (Electron accelerator, e.g. "CmdOrCtrl+R" → "⌘R"). Slot `content` replaces the text for rich tooltips.
 */
defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{ text?: string; shortcut?: string; placement?: Placement; delay?: number; disabled?: boolean; block?: boolean }>(),
  { text: '', shortcut: '', placement: 'top', delay: 450, disabled: false, block: false }
)

const trigger = ref<HTMLElement | null>(null)
const tip = ref<HTMLElement | null>(null)
const open = ref(false)
const pos = ref({ x: -9999, y: -9999 })
let timer: ReturnType<typeof setTimeout> | null = null

const shortcutLabel = computed(() => (props.shortcut ? formatAccelerator(props.shortcut, platform) : ''))
const hasContent = computed(() => !!props.text || !!shortcutLabel.value)

function clear(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

function show(): void {
  if (props.disabled) return
  clear()
  timer = setTimeout(() => {
    open.value = true
    void nextTick(place)
  }, props.delay)
}

function hide(): void {
  clear()
  open.value = false
  pos.value = { x: -9999, y: -9999 }
}

function place(): void {
  const t = trigger.value
  const el = tip.value
  if (!t || !el) return
  const rect = t.getBoundingClientRect()
  const p = computePosition(rect, { width: el.offsetWidth, height: el.offsetHeight }, props.placement, 6)
  pos.value = { x: p.x, y: p.y }
}

watch(
  () => props.disabled,
  (d) => d && hide()
)
onBeforeUnmount(clear)
</script>

<template>
  <span
    ref="trigger"
    v-bind="$attrs"
    :class="block ? 'flex' : 'inline-flex'"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
    @mousedown="hide"
  >
    <slot />
  </span>
  <Teleport to="body">
    <div
      v-if="open && (hasContent || $slots.content)"
      ref="tip"
      role="tooltip"
      class="pointer-events-none fixed z-[1000] flex max-w-xs items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--tw-text)_92%,var(--tw-bg))] px-2.5 py-1.5 text-xs font-medium leading-snug text-[var(--tw-bg)] shadow-lg"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    >
      <slot name="content">
        <span>{{ text }}</span>
      </slot>
      <span v-if="shortcutLabel" class="rounded bg-[color-mix(in_srgb,var(--tw-bg)_18%,transparent)] px-1.5 py-px font-semibold tabular opacity-90">{{
        shortcutLabel
      }}</span>
    </div>
  </Teleport>
</template>
