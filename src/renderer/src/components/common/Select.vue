<script setup lang="ts" generic="T extends string | number">
import { computed, useAttrs } from 'vue'
import { ChevronsUpDown } from 'lucide-vue-next'
import type { SelectOption } from './types'

/**
 * Styled native select (v-model). Options: `{ value, label }[]` or plain strings. `class` / `style` go on the
 * wrapper; every other attribute (aria-label, id, name, data-*) on the native <select> so it is labelled.
 */
defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    options: ReadonlyArray<SelectOption<T> | T>
    placeholder?: string
    disabled?: boolean
    size?: 'sm' | 'md'
    block?: boolean
  }>(),
  { placeholder: undefined, disabled: false, size: 'md', block: false }
)

const model = defineModel<T>()

const attrs = useAttrs()
const selectAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})

const normalized = computed<SelectOption<T>[]>(() =>
  props.options.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) }))
)

function onChange(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value
  const match = normalized.value.find((o) => String(o.value) === raw)
  if (match) model.value = match.value
}
</script>

<template>
  <div :class="['relative', block ? 'w-full' : 'inline-block', $attrs.class]" :style="$attrs.style as string | undefined">
    <select
      v-bind="selectAttrs"
      :value="model === undefined ? '' : String(model)"
      :disabled="disabled"
      :class="[
        'no-drag w-full appearance-none rounded-lg border border-line bg-input pr-8 text-fg shadow-xs transition-colors',
        'hover:border-accent/40 focus:border-accent focus:ring-3 focus:ring-accent/15 disabled:opacity-50',
        size === 'sm' ? 'h-7 pl-2.5 text-xs' : 'h-8 pl-3 text-[13px]'
      ]"
      @change="onChange"
    >
      <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
      <option v-for="o in normalized" :key="String(o.value)" :value="String(o.value)" :disabled="o.disabled">{{ o.label }}</option>
    </select>
    <ChevronsUpDown :size="14" class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" />
  </div>
</template>
