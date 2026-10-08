<script setup lang="ts">
import { computed } from 'vue'
import { acceleratorParts } from '../../utils/accelerator'
import { platform } from '../../utils/platform'

/**
 * Keyboard shortcut in key caps. Pass an Electron `accelerator` ("CmdOrCtrl+Shift+P" → ⇧ ⌘ P on macOS) or
 * explicit `keys` (["⌘", "Enter"]).
 */
const props = withDefaults(defineProps<{ accelerator?: string; keys?: string[]; size?: 'xs' | 'sm' | 'md'; subtle?: boolean }>(), {
  accelerator: '',
  keys: undefined,
  size: 'sm',
  subtle: false
})

const parts = computed(() => props.keys ?? acceleratorParts(props.accelerator, platform))
const sizeClass = computed(
  () =>
    ({
      xs: 'min-w-[16px] h-[16px] px-1 text-[10px]',
      sm: 'min-w-[20px] h-[20px] px-1.5 text-[11px]',
      md: 'min-w-[24px] h-[24px] px-2 text-xs'
    })[props.size]
)
</script>

<template>
  <span v-if="parts.length" class="inline-flex items-center gap-0.5 align-middle">
    <kbd
      v-for="(part, i) in parts"
      :key="i"
      :class="[
        sizeClass,
        'inline-flex items-center justify-center rounded-[5px] font-medium leading-none tabular',
        subtle ? 'bg-fg/8 text-current' : 'border border-line border-b-2 bg-surface text-muted'
      ]"
      >{{ part }}</kbd
    >
  </span>
</template>
