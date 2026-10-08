<script setup lang="ts">
import { computed } from 'vue'

/** Small pill. `color` (any CSS color) overrides the variant, e.g. a project's color. */
const props = withDefaults(
  defineProps<{ variant?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; color?: string; size?: 'xs' | 'sm'; dot?: boolean }>(),
  { variant: 'neutral', color: undefined, size: 'sm', dot: false }
)

const variantClass = computed(
  () =>
    ({
      neutral: 'bg-fg/8 text-muted',
      accent: 'bg-accent/14 text-accent',
      success: 'bg-success/14 text-success',
      warning: 'bg-warning/16 text-warning',
      danger: 'bg-danger/14 text-danger'
    })[props.variant]
)

const style = computed(() =>
  props.color ? { color: props.color, backgroundColor: `color-mix(in srgb, ${props.color} 15%, transparent)` } : undefined
)
</script>

<template>
  <span
    :class="[
      'inline-flex shrink-0 items-center gap-1 rounded-full font-semibold whitespace-nowrap',
      size === 'xs' ? 'h-4 px-1.5 text-[10px]' : 'h-5 px-2 text-[11px]',
      color ? '' : variantClass
    ]"
    :style="style"
  >
    <span v-if="dot" class="size-1.5 rounded-full bg-current" />
    <slot />
  </span>
</template>
