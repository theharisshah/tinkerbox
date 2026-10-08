<script setup lang="ts">
import { computed, ref } from 'vue'
import { Bookmark, Bug, FileText, FolderOpen, History, Play, Settings, Square } from 'lucide-vue-next'
import { executeCommand } from '../../commands'
import { useConnectionsStore } from '../../stores/connections'
import { useSettingsStore } from '../../stores/settings'
import { useTabsStore } from '../../stores/tabs'
import { useUiStore } from '../../stores/ui'
import IconButton from '../common/IconButton.vue'
import Popover from '../common/Popover.vue'
import Spinner from '../common/Spinner.vue'
import Tooltip from '../common/Tooltip.vue'
import RecentFolders from './RecentFolders.vue'

/** Left icon sidebar: Run, Open folder (+ recent folders on hover), History, Snippets, Logs … Settings. */
const tabs = useTabsStore()
const ui = useUiStore()
const settings = useSettingsStore()
const connections = useConnectionsStore()

const recentOpen = ref(false)
const hoverRun = ref(false)

const tab = computed(() => tabs.activeTab)
const isCode = computed(() => tab.value?.kind === 'code')
const running = computed(() => tabs.isRunning(tab.value?.id))
const debugging = computed(() => isCode.value && connections.isDebugging(tab.value?.connectionId))
const runLabel = computed(() => (running.value ? 'Stop running code' : debugging.value ? 'Run with Xdebug' : 'Run code'))

function onRun(): void {
  if (!isCode.value) {
    ui.toast({ message: 'Open a code tab to run PHP.', key: 'needs-code-tab', timeout: 3000 })
    return
  }
  void executeCommand('run')
}

function openFolder(): void {
  recentOpen.value = false
  void executeCommand('openFolder')
}
</script>

<template>
  <nav class="flex w-[52px] shrink-0 flex-col items-center bg-sidebar pt-1 pb-3" aria-label="Toolbar">
    <Tooltip :text="runLabel" :shortcut="settings.accelerator('run')" placement="right">
      <button
        type="button"
        :aria-label="runLabel"
        data-testid="run-button"
        :class="[
          'mb-2 flex size-9 items-center justify-center rounded-xl transition-all duration-150',
          running
            ? 'bg-accent-soft text-accent hover:bg-danger/12 hover:text-danger'
            : 'bg-accent text-on-accent shadow-md shadow-accent/30 hover:brightness-110 active:scale-95',
          !isCode && !running ? 'opacity-60' : ''
        ]"
        @mouseenter="hoverRun = true"
        @mouseleave="hoverRun = false"
        @click="onRun"
      >
        <template v-if="running">
          <Square v-if="hoverRun" :size="14" fill="currentColor" :stroke-width="0" />
          <Spinner v-else :size="18" />
        </template>
        <Bug v-else-if="debugging" :size="18" :stroke-width="2.2" />
        <Play v-else :size="17" fill="currentColor" :stroke-width="0" class="translate-x-[1px]" />
      </button>
    </Tooltip>

    <div class="flex flex-col items-center gap-1.5">
      <Popover v-model:open="recentOpen" trigger="hover" placement="right-start" id="recentFolders" :offset="10" :open-delay="350">
        <template #trigger>
          <IconButton
            :icon="FolderOpen"
            label="Open local project"
            command="openFolder"
            size="lg"
            tooltip-placement="right"
            :no-tooltip="recentOpen"
            :active="recentOpen"
            @click="openFolder"
            @contextmenu.prevent="recentOpen = true"
          />
        </template>
        <template #default="{ close }">
          <RecentFolders @done="close" @open-folder="openFolder" />
        </template>
      </Popover>
      <IconButton
        :icon="History"
        label="History of your code executions"
        command="showHistory"
        size="lg"
        tooltip-placement="right"
        :active="ui.modal === 'history'"
        @click="executeCommand('showHistory')"
      />
      <IconButton
        :icon="Bookmark"
        label="Snippets"
        command="showSnippets"
        size="lg"
        tooltip-placement="right"
        :active="ui.modal === 'snippets'"
        @click="executeCommand('showSnippets')"
      />
      <IconButton
        :icon="FileText"
        label="Log viewer"
        command="showLogs"
        size="lg"
        tooltip-placement="right"
        :active="ui.modal === 'logs'"
        @click="executeCommand('showLogs')"
      />
    </div>

    <div class="flex-1" />

    <IconButton
      :icon="Settings"
      label="Settings"
      command="openSettings"
      size="lg"
      tooltip-placement="right"
      :active="ui.modal === 'settings'"
      @click="executeCommand('openSettings')"
    />
  </nav>
</template>
