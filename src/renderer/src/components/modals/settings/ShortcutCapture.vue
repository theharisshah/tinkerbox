<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { platform } from '@/utils/platform'
import Kbd from '../../common/Kbd.vue'
import { captureShortcut, heldModifiers } from './shortcuts'

/**
 * Key-capture button of the Shortcuts page. Click → "Press keys…"; the next valid combination is emitted as an
 * accelerator ('change'), plain Backspace emits '' (no shortcut), plain Escape or clicking elsewhere cancels.
 * While capturing, every key press is swallowed so app shortcuts and the native menu do not fire.
 */
const props = defineProps<{ accelerator: string; capturing: boolean; conflict?: boolean; label: string }>()
const emit = defineEmits<{ start: []; stop: []; change: [accelerator: string] }>()

const button = ref<HTMLButtonElement | null>(null)
const held = ref<string[]>([])
const hint = ref('')

function swallow(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.capturing || event.isComposing) return
  swallow(event)
  if (event.repeat) return
  const outcome = captureShortcut(event, platform)
  switch (outcome.action) {
    case 'cancel':
      emit('stop')
      break
    case 'clear':
      emit('change', '')
      emit('stop')
      break
    case 'pending':
      held.value = outcome.modifiers
      hint.value = ''
      break
    case 'invalid':
      held.value = []
      hint.value = outcome.reason
      break
    case 'set':
      emit('change', outcome.accelerator)
      emit('stop')
      break
  }
}

function onKeyup(event: KeyboardEvent): void {
  if (!props.capturing) return
  swallow(event)
  held.value = heldModifiers(event, platform)
}

function onPointerDown(event: PointerEvent): void {
  if (button.value && event.target instanceof Node && button.value.contains(event.target)) return
  emit('stop')
}

function listen(on: boolean): void {
  if (on) {
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('keyup', onKeyup, true)
    window.addEventListener('pointerdown', onPointerDown, true)
  } else {
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('keyup', onKeyup, true)
    window.removeEventListener('pointerdown', onPointerDown, true)
  }
}

watch(
  () => props.capturing,
  async (on) => {
    held.value = []
    hint.value = ''
    listen(on)
    if (on) {
      await nextTick()
      button.value?.focus()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => listen(false))

function toggle(): void {
  if (props.capturing) emit('stop')
  else emit('start')
}
</script>

<template>
  <div class="flex items-center gap-2">
    <span v-if="capturing && hint" class="max-w-[220px] text-right text-[11px] leading-tight text-warning">{{ hint }}</span>
    <button
      ref="button"
      type="button"
      :aria-label="capturing ? `Press the new shortcut for ${label}` : `Change the shortcut for ${label}`"
      :aria-pressed="capturing"
      :class="[
        'no-drag inline-flex h-8 min-w-[112px] items-center justify-center gap-1 rounded-lg border px-2.5 text-xs transition-colors',
        capturing
          ? 'border-accent bg-accent-soft text-accent ring-3 ring-accent/15'
          : conflict
            ? 'border-warning/60 bg-warning/8 hover:border-warning'
            : 'border-line bg-input hover:border-accent/40'
      ]"
      data-testid="shortcut-capture"
      @click="toggle"
    >
      <template v-if="capturing">
        <Kbd v-if="held.length" :keys="held" size="xs" />
        <span class="font-semibold">{{ held.length ? '…' : 'Press keys…' }}</span>
      </template>
      <Kbd v-else-if="accelerator" :accelerator="accelerator" size="xs" />
      <span v-else class="text-muted">Not set</span>
    </button>
  </div>
</template>
