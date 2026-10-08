<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { Check, FolderOpen, Moon, Plus, RefreshCw, Sun } from 'lucide-vue-next'
import { api } from '@/api'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import {
  allThemes,
  builtinThemes,
  customThemeList,
  getTheme,
  loadCustomThemes,
  osDark,
  previewTheme,
  themeForSettings,
  type ThemeDefinition
} from '@/themes'
import { cloneJson } from '@/utils/merge'
import Button from '../../common/Button.vue'
import IconButton from '../../common/IconButton.vue'
import Modal from '../../common/Modal.vue'
import Spinner from '../../common/Spinner.vue'
import ThemePreview from './ThemePreview.vue'
import { copyName, themeToJson } from './themeJson'

/**
 * Theme picker: built-in and custom themes on the left, a preview on the right. Selecting a theme previews it live
 * across the app; Save stores it (as the dark or light theme when "Sync with OS" is on), Cancel restores.
 */
const emit = defineEmits<{ close: [result?: string] }>()

const settings = useSettingsStore()
const ui = useUiStore()

const builtins = builtinThemes()
// customThemeList() reads the registry's shallow ref, so this stays reactive.
const customs = computed<readonly ThemeDefinition[]>(() => customThemeList())
const ordered = computed<ThemeDefinition[]>(() => [...builtins, ...customs.value])

const configured = computed(() => themeForSettings(settings.settings, osDark.value))
const selectedId = ref<string>(configured.value.id)
const selected = computed<ThemeDefinition>(() => getTheme(selectedId.value) ?? configured.value)
const reloading = ref(false)
const creating = ref(false)
const listEl = ref<HTMLElement | null>(null)

const sync = computed(() => settings.settings.syncThemeWithOs)
const target = computed(() => (sync.value ? (selected.value.dark ? 'dark' : 'light') : 'theme'))
const targetHint = computed(() =>
  target.value === 'theme'
    ? 'Saved as the app theme.'
    : `Synced with the OS — saved as your ${target.value} theme.`
)

function isConfigured(t: ThemeDefinition): boolean {
  const s = settings.settings
  if (!s.syncThemeWithOs) return getTheme(s.theme)?.id === t.id
  return getTheme(s.darkTheme)?.id === t.id || getTheme(s.lightTheme)?.id === t.id
}

function select(id: string): void {
  selectedId.value = id
  previewTheme(id)
  void nextTick(() => {
    const el = listEl.value?.querySelector<HTMLElement>(`[data-theme-id="${CSS.escape(id)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'nearest' })
    // Keep keyboard focus on the selected theme (only when the list already has focus).
    if (listEl.value?.contains(document.activeElement)) el.focus({ preventScroll: true })
  })
}

function move(delta: number): void {
  const list = ordered.value
  if (list.length === 0) return
  const index = list.findIndex((t) => t.id === selectedId.value)
  const next = Math.min(list.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta))
  select(list[next].id)
}

async function save(): Promise<void> {
  const theme = selected.value
  if (target.value === 'dark') await settings.update({ darkTheme: theme.id })
  else if (target.value === 'light') await settings.update({ lightTheme: theme.id })
  else await settings.update({ theme: theme.id })
  previewTheme(null)
  emit('close', theme.id)
}

function cancel(): void {
  previewTheme(null)
  emit('close')
}

async function reload(): Promise<void> {
  reloading.value = true
  try {
    const list = await loadCustomThemes()
    ui.toast({ key: 'themes-reload', timeout: 3000, message: list.length ? `Loaded ${list.length} custom theme${list.length === 1 ? '' : 's'}.` : 'No custom themes found in the themes folder.' })
    if (!getTheme(selectedId.value)) select(configured.value.id)
  } finally {
    reloading.value = false
  }
}

async function openFolder(): Promise<void> {
  try {
    await api.invoke('themes:openFolder')
  } catch (err) {
    ui.error(err, 'Could not open the themes folder')
  }
}

async function create(): Promise<void> {
  const base = selected.value
  const name = await ui.prompt({
    title: 'New custom theme',
    message: `It starts as a copy of ${base.name}. Edit the JSON file in the themes folder, then press Reload.`,
    label: 'Name',
    value: copyName(base.name, allThemes().map((t) => t.name)),
    confirmLabel: 'Create theme',
    validate: (v) => (v.trim() === '' ? 'Enter a name for the theme.' : null)
  })
  if (!name) return
  creating.value = true
  try {
    const created = await api.invoke('themes:create', name.trim(), cloneJson(themeToJson(base)))
    await loadCustomThemes()
    select(getTheme(created.id) ? created.id : base.id)
    ui.toast({
      level: 'success',
      title: 'Theme created',
      message: created.file ? `Saved as ${created.file}` : `“${created.name}” is ready.`,
      actions: [{ label: 'Open folder', run: openFolder }]
    })
  } catch (err) {
    ui.error(err, 'Could not create the theme')
  } finally {
    creating.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    move(event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key === 'Enter' && target?.dataset.themeId) {
    event.preventDefault()
    void save()
  }
}

// Start previewing the configured theme so arrowing through the list feels immediate; always restore on close.
previewTheme(null)
onBeforeUnmount(() => previewTheme(null))
</script>

<template>
  <Modal title="Themes" size="xl" height="min(640px, calc(100vh - 64px))" :padded="false" initial-focus="[data-theme-selected]" @close="cancel">
    <div class="flex h-full min-h-0" @keydown="onKeydown">
      <div ref="listEl" class="w-[290px] shrink-0 overflow-auto border-r border-line p-3" role="listbox" aria-label="Themes">
        <h3 class="px-2 pt-1 pb-1.5 text-[11px] font-bold tracking-wider text-muted uppercase">Built-in</h3>
        <button
          v-for="t in builtins"
          :key="t.id"
          type="button"
          role="option"
          :aria-selected="t.id === selectedId"
          :data-theme-id="t.id"
          :data-theme-selected="t.id === selectedId ? '' : undefined"
          :class="['flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]', t.id === selectedId ? 'bg-accent-soft font-semibold text-fg' : 'text-fg hover:bg-hover']"
          @click="select(t.id)"
          @dblclick="save"
        >
          <span class="flex size-5 shrink-0 items-center justify-center rounded-md border border-black/10" :style="{ background: t.vars['--tw-editor-bg'] }">
            <span class="size-2 rounded-full" :style="{ background: t.vars['--tw-accent'] }" />
          </span>
          <span class="min-w-0 flex-1 truncate">{{ t.name }}</span>
          <Check v-if="isConfigured(t)" :size="14" class="shrink-0 text-accent" aria-label="Current theme" />
          <component :is="t.dark ? Moon : Sun" :size="13" class="shrink-0 text-muted" :aria-label="t.dark ? 'Dark' : 'Light'" />
        </button>

        <div class="mt-4 flex items-center gap-1 px-2 pb-1.5">
          <h3 class="flex-1 text-[11px] font-bold tracking-wider text-muted uppercase">Custom</h3>
          <IconButton :icon="Plus" size="xs" :label="`New theme based on ${selected.name}`" :disabled="creating" data-testid="theme-create" @click="create" />
          <IconButton :icon="FolderOpen" size="xs" label="Open themes folder" @click="openFolder" />
          <IconButton :icon="RefreshCw" size="xs" label="Reload custom themes" :disabled="reloading" @click="reload" />
        </div>
        <div v-if="reloading || creating" class="flex justify-center py-3"><Spinner :size="16" /></div>
        <button
          v-for="t in customs"
          :key="t.id"
          type="button"
          role="option"
          :aria-selected="t.id === selectedId"
          :data-theme-id="t.id"
          :data-theme-selected="t.id === selectedId ? '' : undefined"
          :class="['flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]', t.id === selectedId ? 'bg-accent-soft font-semibold text-fg' : 'text-fg hover:bg-hover']"
          @click="select(t.id)"
          @dblclick="save"
        >
          <span class="flex size-5 shrink-0 items-center justify-center rounded-md border border-black/10" :style="{ background: t.vars['--tw-editor-bg'] }">
            <span class="size-2 rounded-full" :style="{ background: t.vars['--tw-accent'] }" />
          </span>
          <span class="min-w-0 flex-1 truncate">{{ t.name }}</span>
          <Check v-if="isConfigured(t)" :size="14" class="shrink-0 text-accent" aria-label="Current theme" />
          <component :is="t.dark ? Moon : Sun" :size="13" class="shrink-0 text-muted" />
        </button>
        <p v-if="customs.length === 0 && !reloading" class="px-2 py-1 text-xs leading-relaxed text-muted">
          No custom themes yet. Press <span class="font-semibold text-fg">+</span> to copy the selected theme into the themes
          folder, or put Monaco theme JSON files there and reload.
        </p>
      </div>

      <div class="min-w-0 flex-1 overflow-auto p-5">
        <ThemePreview :theme="selected" />
      </div>
    </div>

    <template #footer>
      <span class="mr-auto text-xs text-muted">{{ targetHint }}</span>
      <Button variant="ghost" @click="cancel">Cancel</Button>
      <Button variant="primary" data-testid="theme-save" @click="save">Save</Button>
    </template>
  </Modal>
</template>
