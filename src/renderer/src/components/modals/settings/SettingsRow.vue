<script setup lang="ts">
/**
 * One settings row: label + description on the left, the control (default slot) on the right. `stacked` puts the
 * control under the text (wide inputs); slot `below` adds full-width content under the row.
 */
withDefaults(defineProps<{ label: string; description?: string; stacked?: boolean; disabled?: boolean; for?: string }>(), {
  description: undefined,
  stacked: false,
  disabled: false,
  for: undefined
})
</script>

<template>
  <div :class="['px-4 py-3', disabled ? 'opacity-55' : '']">
    <div :class="stacked ? 'flex flex-col gap-2.5' : 'flex items-center gap-6'">
      <div class="min-w-0 flex-1">
        <label :for="$props.for" class="block text-[13px] font-medium text-fg">{{ label }}</label>
        <p v-if="description || $slots.description" class="mt-0.5 text-xs leading-relaxed text-muted">
          {{ description }}<slot name="description" />
        </p>
      </div>
      <div :class="stacked ? 'w-full' : 'flex shrink-0 items-center gap-2'">
        <slot />
      </div>
    </div>
    <slot name="below" />
  </div>
</template>
