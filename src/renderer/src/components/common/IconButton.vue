<script setup lang="ts">
import { computed, type Component } from 'vue'
import type { CommandId } from '@shared/ipc'
import { useSettingsStore } from '../../stores/settings'
import type { Placement } from '../../utils/position'
import Tooltip from './Tooltip.vue'

/**
 * Icon-only button with a tooltip (label + shortcut). `command` resolves the shortcut from the settings;
 * `shortcut` takes an explicit accelerator. `active` draws it in the accent color.
 */
const props = withDefaults(
  defineProps<{
    icon: Component
    label: string
    command?: CommandId
    shortcut?: string
    active?: boolean
    disabled?: boolean
    size?: 'xs' | 'sm' | 'md' | 'lg'
    variant?: 'ghost' | 'soft'
    tooltipPlacement?: Placement
    noTooltip?: boolean
    iconSize?: number
    strokeWidth?: number
  }>(),
  {
    command: undefined,
    shortcut: undefined,
    active: false,
    disabled: false,
    size: 'md',
    variant: 'ghost',
    tooltipPlacement: 'bottom',
    noTooltip: false,
    iconSize: undefined,
    strokeWidth: 1.85
  }
)

defineEmits<{ click: [event: MouseEvent] }>()

const settings = useSettingsStore()
const accel = computed(() => props.shortcut ?? (props.command ? settings.accelerator(props.command) : ''))
const box = computed(() => ({ xs: 'size-6 rounded-md', sm: 'size-7 rounded-md', md: 'size-8 rounded-lg', lg: 'size-9 rounded-xl' })[props.size])
const glyph = computed(() => props.iconSize ?? { xs: 13, sm: 15, md: 17, lg: 19 }[props.size])
</script>

<template>
  <Tooltip :text="label" :shortcut="accel" :placement="tooltipPlacement" :disabled="noTooltip || disabled">
    <button
      type="button"
      :aria-label="label"
      :aria-pressed="active || undefined"
      :disabled="disabled"
      :class="[
        'no-drag relative inline-flex shrink-0 items-center justify-center transition-colors duration-100',
        'disabled:pointer-events-none disabled:opacity-40',
        box,
        active
          ? 'bg-accent-soft text-accent'
          : variant === 'soft'
            ? 'bg-fg/5 text-muted hover:bg-hover hover:text-fg'
            : 'text-muted hover:bg-hover hover:text-fg active:bg-active'
      ]"
      @click="$emit('click', $event)"
    >
      <slot>
        <component :is="icon" :size="glyph" :stroke-width="strokeWidth" />
      </slot>
      <slot name="badge" />
    </button>
  </Tooltip>
</template>
