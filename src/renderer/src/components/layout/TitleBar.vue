<script setup lang="ts">
import { computed } from 'vue'
import { CodeXml, Layers } from 'lucide-vue-next'
import { useSettingsStore } from '../../stores/settings'
import { useTabsStore } from '../../stores/tabs'
import { useUiStore } from '../../stores/ui'
import { isMac } from '../../utils/platform'
import IconButton from '../common/IconButton.vue'
import Tooltip from '../common/Tooltip.vue'

/**
 * Window title bar: drag region (macOS traffic lights inset on the left, Windows/Linux window controls overlay on
 * the right), centered "Tinkerbox - <tab>", output controls of the active code tab on the right.
 */
const tabs = useTabsStore()
const ui = useUiStore()
const settings = useSettingsStore()

const tab = computed(() => tabs.activeTab)
const title = computed(() => {
  const name = tab.value ? tabs.displayTitle(tab.value) : ''
  return name ? `Tinkerbox - ${name}` : 'Tinkerbox'
})
const isCode = computed(() => tab.value?.kind === 'code')
const mode = computed(() => tab.value?.outputMode ?? 'detail')
</script>

<template>
  <header
    class="drag-region relative flex h-10 shrink-0 items-center bg-titlebar"
    :class="isMac ? 'pl-[84px]' : 'pr-[140px] pl-3'"
  >
    <div v-if="!isMac" class="flex items-center gap-2 text-[13px] font-semibold text-fg">
      <img src="../../assets/logo.svg" alt="" class="size-5" draggable="false" />
    </div>
    <div class="pointer-events-none absolute inset-x-0 top-0 flex h-10 items-center justify-center px-[220px]">
      <span class="truncate text-[13px] font-semibold tracking-tight text-muted" data-testid="window-title">{{ title }}</span>
    </div>
    <div class="flex-1" />
    <div v-if="isCode && ui.showChrome" class="relative z-10 flex items-center gap-1 pr-3">
      <Tooltip
        v-if="mode === 'detail'"
        text="Watch the SQL queries that run in the background"
        :shortcut="settings.accelerator('toggleQueries')"
        placement="bottom"
      >
        <button
          type="button"
          :aria-pressed="tab?.showQueries"
          :class="[
            'no-drag mr-1 h-7 rounded-lg px-2.5 text-[11px] font-bold tracking-wider transition-colors',
            tab?.showQueries ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg'
          ]"
          @click="tab && tabs.toggleQueries(tab.id)"
        >
          SQL
        </button>
      </Tooltip>
      <IconButton
        :icon="Layers"
        label="Cards"
        command="outputDetail"
        size="sm"
        :active="mode === 'detail'"
        @click="tabs.setOutputMode(tab?.id ?? null, 'detail')"
      />
      <IconButton
        :icon="CodeXml"
        label="CLI Mode"
        command="toggleCliMode"
        size="sm"
        :active="mode === 'cli'"
        @click="tabs.setOutputMode(tab?.id ?? null, 'cli')"
      />
    </div>
  </header>
</template>
