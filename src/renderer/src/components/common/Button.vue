<script setup lang="ts">
import { computed, type Component } from 'vue'
import Spinner from './Spinner.vue'

/**
 * Button. Variants: primary (filled accent), secondary (accent outline on soft fill), default (neutral border),
 * ghost (no chrome), danger (filled red). Slot: label; `icon` / `iconRight` are lucide components.
 */
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'default' | 'ghost' | 'danger'
    size?: 'xs' | 'sm' | 'md' | 'lg'
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    loading?: boolean
    block?: boolean
    icon?: Component
    iconRight?: Component
  }>(),
  { variant: 'default', size: 'md', type: 'button', disabled: false, loading: false, block: false, icon: undefined, iconRight: undefined }
)

const variantClass = computed(
  () =>
    ({
      primary: 'bg-accent text-on-accent shadow-sm shadow-accent/20 hover:brightness-110 active:brightness-95',
      secondary: 'border border-accent/45 bg-accent-soft text-accent hover:border-accent hover:bg-accent/15',
      default: 'border border-line bg-surface text-fg shadow-xs hover:border-accent/40 hover:bg-hover',
      ghost: 'text-fg hover:bg-hover active:bg-active',
      danger: 'bg-danger text-white shadow-sm shadow-danger/20 hover:brightness-110 active:brightness-95'
    })[props.variant]
)

const sizeClass = computed(
  () =>
    ({
      xs: 'h-6 gap-1 rounded-md px-2 text-[11px]',
      sm: 'h-7 gap-1.5 rounded-md px-2.5 text-xs',
      md: 'h-8 gap-2 rounded-lg px-3.5 text-[13px]',
      lg: 'h-10 gap-2 rounded-lg px-5 text-sm'
    })[props.size]
)

const iconSize = computed(() => ({ xs: 12, sm: 14, md: 15, lg: 16 })[props.size])
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :class="[
      'no-drag inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-[background-color,border-color,filter,color] duration-100 select-none',
      'disabled:pointer-events-none disabled:opacity-50',
      variantClass,
      sizeClass,
      block ? 'w-full' : ''
    ]"
  >
    <Spinner v-if="loading" :size="iconSize" />
    <component :is="icon" v-else-if="icon" :size="iconSize" :stroke-width="2" />
    <slot />
    <component :is="iconRight" v-if="iconRight" :size="iconSize" :stroke-width="2" />
  </button>
</template>
