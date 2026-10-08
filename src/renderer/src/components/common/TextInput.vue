<script setup lang="ts">
import { ref, type Component } from 'vue'
import { FolderOpen, X } from 'lucide-vue-next'
import { api } from '../../api'
import { useUiStore } from '../../stores/ui'

/**
 * Text field (v-model string). Options: leading `icon`, `clearable` (×), `folderPicker` (folder button that fills
 * the value from the directory dialog), monospace, `error` text. Emits enter / escape. Exposes focus() / select().
 */
const props = withDefaults(
  defineProps<{
    placeholder?: string
    type?: 'text' | 'search' | 'password' | 'url' | 'number' | 'email'
    icon?: Component
    clearable?: boolean
    folderPicker?: boolean
    pickerTitle?: string
    monospace?: boolean
    disabled?: boolean
    readonly?: boolean
    size?: 'sm' | 'md' | 'lg'
    error?: string | null
    autofocus?: boolean
    spellcheck?: boolean
  }>(),
  {
    placeholder: undefined,
    type: 'text',
    icon: undefined,
    clearable: false,
    folderPicker: false,
    pickerTitle: 'Choose a folder',
    monospace: false,
    disabled: false,
    readonly: false,
    size: 'md',
    error: null,
    autofocus: false,
    spellcheck: false
  }
)

const emit = defineEmits<{ enter: [value: string]; escape: [event: KeyboardEvent]; picked: [path: string] }>()
const model = defineModel<string>({ default: '' })
const input = ref<HTMLInputElement | null>(null)

async function pickFolder(): Promise<void> {
  try {
    const dir = await api.invoke('dialog:openDirectory', props.pickerTitle)
    if (dir) {
      model.value = dir
      emit('picked', dir)
    }
  } catch (err) {
    useUiStore().error(err, 'Could not open the folder picker')
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.isComposing) emit('enter', model.value)
  else if (event.key === 'Escape') emit('escape', event)
}

defineExpose({
  focus: () => input.value?.focus(),
  select: () => input.value?.select(),
  el: input
})
</script>

<template>
  <div class="w-full">
    <div
      :class="[
        'no-drag flex w-full items-center gap-2 rounded-lg border bg-input text-fg shadow-xs transition-colors',
        'focus-within:ring-3',
        error ? 'border-danger focus-within:ring-danger/15' : 'border-line hover:border-accent/40 focus-within:border-accent focus-within:ring-accent/15',
        disabled ? 'opacity-50' : '',
        size === 'sm' ? 'h-7 px-2 text-xs' : size === 'lg' ? 'h-11 px-3.5 text-[15px]' : 'h-8 px-2.5 text-[13px]'
      ]"
    >
      <component :is="icon" v-if="icon" :size="size === 'lg' ? 18 : 15" class="shrink-0 text-muted" />
      <input
        ref="input"
        v-model="model"
        :type="type"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        :autofocus="autofocus"
        :spellcheck="spellcheck"
        autocomplete="off"
        :class="['h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted/80', monospace ? 'font-mono text-[0.95em]' : '']"
        @keydown="onKeydown"
      />
      <button
        v-if="clearable && model"
        type="button"
        aria-label="Clear"
        class="flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
        @click="model = ''"
      >
        <X :size="13" />
      </button>
      <slot name="suffix" />
      <button
        v-if="folderPicker"
        type="button"
        aria-label="Choose folder"
        title="Choose folder…"
        :disabled="disabled"
        class="-mr-1 flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted hover:bg-hover hover:text-accent"
        @click="pickFolder"
      >
        <FolderOpen :size="15" />
      </button>
    </div>
    <p v-if="error" class="mt-1 text-xs text-danger">{{ error }}</p>
  </div>
</template>
