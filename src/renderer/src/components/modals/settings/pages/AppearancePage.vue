<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Columns2, Moon, Palette, Rows2, Sun } from 'lucide-vue-next'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { useUiStore } from '@/stores/ui'
import { allThemes, customThemesRef, getTheme, osDark, themeForSettings, type ThemeDefinition } from '@/themes'
import { useSettingsStore } from '@/stores/settings'
import { formatAccelerator } from '@/utils/accelerator'
import { platform } from '@/utils/platform'
import Button from '../../../common/Button.vue'
import SegmentedControl from '../../../common/SegmentedControl.vue'
import Select from '../../../common/Select.vue'
import TextInput from '../../../common/TextInput.vue'
import Toggle from '../../../common/Toggle.vue'
import type { SelectOption } from '../../../common/types'
import NumberField from '../NumberField.vue'
import SettingsGroup from '../SettingsGroup.vue'
import SettingsRow from '../SettingsRow.vue'
import { useSetting } from '../useSetting'

const settings = useSettingsStore()
const ui = useUiStore()

const syncThemeWithOs = useSetting('syncThemeWithOs')
const darkTheme = useSetting('darkTheme')
const lightTheme = useSetting('lightTheme')
const editorFontSize = useSetting('editorFontSize')
const outputFontSize = useSetting('outputFontSize')
const lineHeight = useSetting('lineHeight')
const fontLigatures = useSetting('fontLigatures')
const indentGuides = useSetting('indentGuides')
const lineNumbers = useSetting('lineNumbers')
const minimap = useSetting('minimap')
const wordWrap = useSetting('wordWrap')
const layout = useSetting('layout')
const showToolbar = useSetting('showToolbar')
const alwaysOnTop = useSetting('alwaysOnTop')
const autoHideOutput = useSetting('autoHideOutput')

const current = computed(() => themeForSettings(settings.settings, osDark.value))
const zoomKeys = computed(() =>
  [settings.accelerator('zoomIn'), settings.accelerator('zoomOut')].map((a) => formatAccelerator(a, platform)).filter(Boolean).join(' / ')
)
const layoutKey = computed(() => formatAccelerator(settings.accelerator('toggleLayout'), platform))

function themeOptions(dark: boolean, selected: string): SelectOption<string>[] {
  // Re-evaluated when custom themes change.
  void customThemesRef.value
  const matching = allThemes().filter((t) => t.dark === dark)
  const chosen = getTheme(selected)
  const list: ThemeDefinition[] = chosen && !matching.some((t) => t.id === chosen.id) ? [chosen, ...matching] : matching
  return list.map((t) => ({ value: t.id, label: t.custom ? `${t.name} (custom)` : t.name }))
}

const darkOptions = computed(() => themeOptions(true, darkTheme.value))
const lightOptions = computed(() => themeOptions(false, lightTheme.value))
const darkValue = computed({ get: () => getTheme(darkTheme.value)?.id ?? darkTheme.value, set: (v: string) => (darkTheme.value = v) })
const lightValue = computed({ get: () => getTheme(lightTheme.value)?.id ?? lightTheme.value, set: (v: string) => (lightTheme.value = v) })

const fontFamily = useSetting('editorFontFamily')
const fontDraft = ref(fontFamily.value)
watch(fontFamily, (v) => {
  if (v !== fontDraft.value) fontDraft.value = v
})

function commitFont(): void {
  const next = fontDraft.value.trim() || DEFAULT_SETTINGS.editorFontFamily
  fontDraft.value = next
  if (next !== fontFamily.value) fontFamily.value = next
}

function openThemes(): void {
  void ui.openModal('themes', {}, { stack: true })
}

const layoutOptions = [
  { value: 'vertical' as const, label: 'Side by side', icon: Columns2 },
  { value: 'horizontal' as const, label: 'Stacked', icon: Rows2 }
]
</script>

<template>
  <div class="flex flex-col gap-7">
    <SettingsGroup title="Theme">
      <SettingsRow label="Theme" :description="syncThemeWithOs ? `Following your OS — ${osDark ? 'dark' : 'light'} right now.` : 'Colors of the editor and the whole window.'">
        <span class="flex items-center gap-1.5 text-[13px] font-medium text-fg" data-testid="current-theme">
          <component :is="current.dark ? Moon : Sun" :size="13" class="text-muted" />
          {{ current.name }}
        </span>
        <Button variant="secondary" size="sm" :icon="Palette" data-testid="select-theme" @click="openThemes">Select</Button>
      </SettingsRow>
      <SettingsRow label="Sync with OS" description="Switch between a dark and a light theme when your system appearance changes.">
        <Toggle v-model="syncThemeWithOs" />
      </SettingsRow>
      <template v-if="syncThemeWithOs">
        <SettingsRow label="Dark theme" description="Used while the OS is in dark mode.">
          <Select v-model="darkValue" :options="darkOptions" class="w-[220px]" />
        </SettingsRow>
        <SettingsRow label="Light theme" description="Used while the OS is in light mode.">
          <Select v-model="lightValue" :options="lightOptions" class="w-[220px]" />
        </SettingsRow>
      </template>
    </SettingsGroup>

    <SettingsGroup title="Editor">
      <SettingsRow label="Font family" description="Any installed monospace font; list fallbacks separated by commas." stacked>
        <div @focusout="commitFont">
          <TextInput v-model="fontDraft" monospace placeholder="'Fira Code', monospace" @enter="commitFont" />
        </div>
      </SettingsRow>
      <SettingsRow label="Font size" :description="`Editor text size.${zoomKeys ? ` ${zoomKeys} zoom the editor and the output together.` : ''}`">
        <NumberField v-model="editorFontSize" :min="6" :max="72" integer suffix="px" aria-label="Editor font size" />
      </SettingsRow>
      <SettingsRow label="Output font size" description="Text size of the output pane.">
        <NumberField v-model="outputFontSize" :min="6" :max="72" integer suffix="px" aria-label="Output font size" />
      </SettingsRow>
      <SettingsRow label="Line height" description="Below 8 it multiplies the font size; 8 and above are pixels.">
        <NumberField v-model="lineHeight" :min="0" :max="100" :step="0.1" aria-label="Line height" />
      </SettingsRow>
      <SettingsRow label="Font ligatures" description="Draw combinations like => and !== as single glyphs (needs a font with ligatures).">
        <Toggle v-model="fontLigatures" />
      </SettingsRow>
      <SettingsRow label="Indentation guides" description="Thin vertical lines at each indentation level.">
        <Toggle v-model="indentGuides" />
      </SettingsRow>
      <SettingsRow label="Line numbers">
        <Toggle v-model="lineNumbers" />
      </SettingsRow>
      <SettingsRow label="Minimap" description="Zoomed-out overview of the code on the right edge.">
        <Toggle v-model="minimap" />
      </SettingsRow>
      <SettingsRow label="Word wrap" description="Wrap long lines instead of scrolling sideways.">
        <Toggle v-model="wordWrap" />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Window">
      <SettingsRow label="Layout" :description="`Where the output goes relative to the editor${layoutKey ? ` (${layoutKey} flips it)` : ''}.`">
        <SegmentedControl v-model="layout" :options="layoutOptions" />
      </SettingsRow>
      <SettingsRow label="Toolbar" description="The icon bar on the left with Run, folders, history and snippets.">
        <Toggle v-model="showToolbar" />
      </SettingsRow>
      <SettingsRow label="Always on top" description="Keep the window above other apps.">
        <Toggle v-model="alwaysOnTop" />
      </SettingsRow>
      <SettingsRow label="Automatically hide output" description="Esc hides the output pane; it comes back with the next run.">
        <Toggle v-model="autoHideOutput" />
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>
