<script setup lang="ts">
import type { Component } from 'vue'

/** Centered placeholder for empty lists / panes. Slot: actions (buttons). */
withDefaults(defineProps<{ icon?: Component; title: string; description?: string; compact?: boolean }>(), {
  icon: undefined,
  description: undefined,
  compact: false
})
</script>

<template>
  <div :class="['flex flex-col items-center justify-center text-center', compact ? 'gap-2 p-4' : 'gap-3 p-8']">
    <div
      v-if="icon"
      :class="['flex items-center justify-center rounded-2xl bg-accent-soft text-accent', compact ? 'size-9' : 'size-12']"
    >
      <component :is="icon" :size="compact ? 18 : 22" :stroke-width="1.75" />
    </div>
    <div class="space-y-1">
      <p :class="['font-semibold text-fg', compact ? 'text-sm' : 'text-[15px]']">{{ title }}</p>
      <p v-if="description" class="mx-auto max-w-sm text-[13px] leading-relaxed text-muted">{{ description }}</p>
      <slot name="description" />
    </div>
    <div v-if="$slots.actions" class="mt-1 flex flex-wrap items-center justify-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
