<script setup lang="ts">
/** Indeterminate spinner in the current text color (or `color`). */
withDefaults(defineProps<{ size?: number; strokeWidth?: number; label?: string }>(), {
  size: 16,
  strokeWidth: 2.25,
  label: 'Loading'
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    class="shrink-0 animate-spin"
    role="status"
    :aria-label="label"
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" :stroke-width="strokeWidth" opacity="0.22" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" :stroke-width="strokeWidth" stroke-linecap="round" />
  </svg>
</template>
