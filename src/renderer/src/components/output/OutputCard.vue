<script setup lang="ts">
/**
 * Rounded Cards view card. Top-right: hover actions (slot `actions`) and the location label — "Line N" (reveals
 * the line in the editor) or "file.php:12" for dumps from project files (opens the preferred editor).
 */
import { computed } from 'vue'
import { basename } from '../../utils/platform'
import { displayPath, openInEditor, revealLine } from './actions'

const props = withDefaults(
  defineProps<{
    tabId?: string
    connectionId?: string | null
    /** 1-based editor line (user code) or file line (with `file`). */
    line?: number
    /** Project / absolute file of a dump call outside the editor code. */
    file?: string
    /** Static label shown instead of a line (e.g. "Return value"). */
    label?: string
    tone?: 'default' | 'warning' | 'danger' | 'muted' | 'live'
    /** Smaller padding (diagnostics, notes). */
    compact?: boolean
  }>(),
  {
    tabId: undefined,
    connectionId: null,
    line: undefined,
    file: undefined,
    label: undefined,
    tone: 'default',
    compact: false
  }
)

const fileLabel = computed(() => (props.file ? displayPath(props.file, props.connectionId) : ''))
const location = computed(() => {
  if (props.file) return `${basename(fileLabel.value)}${props.line ? `:${props.line}` : ''}`
  if (props.line) return `Line ${props.line}`
  return ''
})
const locationTitle = computed(() => {
  if (props.file) return `${fileLabel.value}${props.line ? `:${props.line}` : ''} — open in your editor`
  return props.line ? 'Show this line in the editor' : ''
})

const toneClass = computed(
  () =>
    ({
      default: 'border-line bg-surface',
      warning: 'border-warning/35 bg-[color-mix(in_srgb,var(--tw-warning)_8%,var(--tw-surface))]',
      danger: 'border-danger/35 bg-surface',
      muted: 'border-line/70 bg-surface/60',
      live: 'border-accent/40 bg-surface'
    })[props.tone]
)

function onLocation(): void {
  if (props.file) void openInEditor(props.file, props.line, props.connectionId)
  else revealLine(props.tabId, props.line)
}
</script>

<template>
  <section
    :class="['group/card relative flow-root rounded-xl border shadow-[0_1px_2px_rgb(0_0_0/0.04)]', toneClass, compact ? 'px-3 py-2' : 'px-4 py-3']"
  >
    <!-- Floated so the first content line wraps around the label; actions overlay the content on hover. -->
    <div :class="['relative float-right ml-3 flex items-center', compact ? '-mt-0.5 -mr-1.5' : '-mt-1.5 -mr-2.5']">
      <div
        v-if="$slots.actions"
        class="pointer-events-none absolute top-1/2 right-full z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-lg bg-surface px-0.5 opacity-0 shadow-sm ring-1 ring-line transition-opacity duration-100 group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100 group-hover/card:pointer-events-auto group-hover/card:opacity-100"
      >
        <slot name="actions" />
      </div>
      <button
        v-if="location"
        type="button"
        :title="locationTitle"
        class="max-w-[220px] truncate rounded-md px-1.5 py-0.5 font-sans text-[11px] leading-4 font-medium text-muted tabular transition-colors hover:bg-accent-soft hover:text-accent"
        @click="onLocation"
      >
        {{ location }}
      </button>
      <span v-else-if="label" class="rounded-md px-1.5 py-0.5 font-sans text-[11px] leading-4 font-medium text-muted select-none">{{ label }}</span>
      <span v-else class="block h-5" />
    </div>
    <div class="min-w-0">
      <slot />
    </div>
  </section>
</template>
