<script setup lang="ts" generic="T extends string | number">
import type { Segment } from './types'

/** Pill segmented control (v-model). Segments can be text, icon or both. */
withDefaults(defineProps<{ options: ReadonlyArray<Segment<T>>; size?: 'sm' | 'md'; block?: boolean }>(), {
  size: 'md',
  block: false
})

const model = defineModel<T>()
</script>

<template>
  <div
    role="radiogroup"
    :class="['no-drag inline-flex items-center gap-0.5 rounded-lg bg-fg/6 p-0.5', block ? 'flex w-full' : '']"
  >
    <button
      v-for="o in options"
      :key="String(o.value)"
      type="button"
      role="radio"
      :aria-checked="model === o.value"
      :title="o.title ?? o.label"
      :disabled="o.disabled"
      :class="[
        'inline-flex items-center justify-center gap-1.5 rounded-md font-semibold transition-all duration-100 disabled:opacity-40',
        size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-3 text-xs',
        block ? 'flex-1' : '',
        model === o.value ? 'bg-surface text-fg shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg'
      ]"
      @click="model = o.value"
    >
      <component :is="o.icon" v-if="o.icon" :size="size === 'sm' ? 13 : 14" />
      <span v-if="o.label">{{ o.label }}</span>
    </button>
  </div>
</template>
