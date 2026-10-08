<script setup lang="ts">
/** Pill switch (v-model boolean). Optional `label` / `description` rendered to the left. */
withDefaults(defineProps<{ label?: string; description?: string; disabled?: boolean; size?: 'sm' | 'md' }>(), {
  label: undefined,
  description: undefined,
  disabled: false,
  size: 'md'
})

const model = defineModel<boolean>({ default: false })

function flip(disabled: boolean): void {
  if (!disabled) model.value = !model.value
}
</script>

<template>
  <label :class="['inline-flex items-center gap-3', disabled ? 'opacity-50' : '', label ? 'w-full justify-between' : '']">
    <span v-if="label || description" class="min-w-0">
      <span v-if="label" class="block text-[13px] font-medium text-fg">{{ label }}</span>
      <span v-if="description" class="block text-xs text-muted">{{ description }}</span>
    </span>
    <button
      type="button"
      role="switch"
      :aria-checked="model"
      :aria-label="label"
      :disabled="disabled"
      :class="[
        'no-drag relative inline-flex shrink-0 items-center rounded-full transition-colors duration-150',
        size === 'sm' ? 'h-[18px] w-8' : 'h-[22px] w-10',
        model ? 'bg-accent' : 'bg-fg/18'
      ]"
      @click="flip(disabled)"
    >
      <span
        :class="[
          'inline-block rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-150',
          size === 'sm' ? 'size-3.5' : 'size-[18px]',
          model ? (size === 'sm' ? 'translate-x-[16px]' : 'translate-x-[20px]') : 'translate-x-[2px]'
        ]"
      />
    </button>
  </label>
</template>
