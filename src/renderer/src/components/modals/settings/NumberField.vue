<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * Compact number input. Commits on blur / Enter (clamped to min/max, rounded to `step` decimals when `integer`);
 * invalid input snaps back to the current value.
 */
const props = withDefaults(
  defineProps<{ min?: number; max?: number; step?: number; integer?: boolean; suffix?: string; width?: string; disabled?: boolean; ariaLabel?: string }>(),
  { min: undefined, max: undefined, step: 1, integer: false, suffix: undefined, width: '84px', disabled: false, ariaLabel: undefined }
)
const model = defineModel<number>({ required: true })
const draft = ref(String(model.value))

watch(model, (value) => {
  draft.value = String(value)
})

function commit(): void {
  let value = Number(draft.value.replace(',', '.'))
  if (draft.value.trim() === '' || !Number.isFinite(value)) {
    draft.value = String(model.value)
    return
  }
  if (props.integer) value = Math.round(value)
  if (props.min !== undefined) value = Math.max(props.min, value)
  if (props.max !== undefined) value = Math.min(props.max, value)
  draft.value = String(value)
  if (value !== model.value) model.value = value
}
</script>

<template>
  <div
    class="no-drag inline-flex h-8 items-center rounded-lg border border-line bg-input text-[13px] text-fg shadow-xs transition-colors focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15 hover:border-accent/40"
    :class="disabled ? 'opacity-50' : ''"
  >
    <input
      v-model="draft"
      type="number"
      inputmode="decimal"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :aria-label="ariaLabel"
      class="tabular h-full bg-transparent px-2.5 text-right outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      :style="{ width }"
      @change="commit"
      @blur="commit"
      @keydown.enter.prevent="commit"
    />
    <span v-if="suffix" class="pr-2.5 text-xs text-muted">{{ suffix }}</span>
  </div>
</template>
