<script setup lang="ts">
import { computed } from 'vue'
import { Box, Folder, FolderPlus, Trash2 } from 'lucide-vue-next'
import { useAppStore } from '../../stores/app'
import { useConnectionsStore } from '../../stores/connections'
import { useSettingsStore } from '../../stores/settings'
import { useTabsStore } from '../../stores/tabs'
import { formatAccelerator } from '../../utils/accelerator'
import { platform, tildify } from '../../utils/platform'

/** Recent folders list (sidebar popover). Click opens the project in the current tab, ⌘/Ctrl-click in a new one. */
const emit = defineEmits<{ done: []; 'open-folder': [] }>()

const app = useAppStore()
const connections = useConnectionsStore()
const settings = useSettingsStore()
const tabs = useTabsStore()

const recent = computed(() => connections.recent.slice(0, 12))
const openShortcut = computed(() => formatAccelerator(settings.accelerator('openFolder'), platform))

function open(id: string | null, event: MouseEvent): void {
  tabs.openProject(id, { newTab: event.metaKey || event.ctrlKey })
  emit('done')
}

function openSandbox(event: MouseEvent): void {
  if (event.metaKey || event.ctrlKey || tabs.activeTab?.kind !== 'code') tabs.openSandbox()
  else tabs.setConnection(tabs.activeTabId, 'sandbox')
  emit('done')
}

async function clear(): Promise<void> {
  await connections.clearRecents()
}
</script>

<template>
  <div class="w-[320px] text-[13px]">
    <div class="flex items-center justify-between px-3.5 pt-3 pb-2">
      <span class="text-[11px] font-bold tracking-wider text-muted uppercase">Recent folders</span>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-semibold text-accent hover:bg-accent-soft"
        @click="emit('open-folder')"
      >
        <FolderPlus :size="13" /> Open folder…
        <span v-if="openShortcut" class="font-normal text-muted">{{ openShortcut }}</span>
      </button>
    </div>
    <ul class="max-h-[360px] overflow-auto px-1.5 pb-1.5">
      <li v-if="app.sandboxInstalled">
        <button type="button" class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent-soft" @click="openSandbox">
          <span class="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent"><Box :size="15" /></span>
          <span class="min-w-0 flex-1">
            <span class="block truncate font-semibold text-fg">Default</span>
            <span class="block truncate text-xs text-muted">Laravel Sandbox</span>
          </span>
        </button>
      </li>
      <li v-for="conn in recent" :key="conn.id">
        <button
          type="button"
          class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent-soft"
          :title="conn.path"
          @click="open(conn.id, $event)"
        >
          <span
            class="flex size-7 shrink-0 items-center justify-center rounded-md"
            :style="{ color: connections.color(conn.id), backgroundColor: `color-mix(in srgb, ${connections.color(conn.id)} 14%, transparent)` }"
          >
            <Folder :size="15" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate font-semibold text-fg">{{ conn.name }}</span>
            <span class="block truncate text-xs text-muted">{{ tildify(conn.path, app.homeDir) }}</span>
          </span>
        </button>
      </li>
      <li v-if="recent.length === 0" class="px-2 py-4 text-center text-xs text-muted">
        Projects you open show up here.
      </li>
    </ul>
    <div v-if="recent.length" class="border-t border-line px-1.5 py-1.5">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
        @click="clear"
      >
        <Trash2 :size="13" /> Clear recent folders
      </button>
    </div>
  </div>
</template>
