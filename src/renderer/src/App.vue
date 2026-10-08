<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { api } from './api'
import ModalHost from './components/ModalHost.vue'
import ContextMenu from './components/common/ContextMenu.vue'
import Spinner from './components/common/Spinner.vue'
import Toasts from './components/common/Toasts.vue'
import Sidebar from './components/layout/Sidebar.vue'
import StatusBar from './components/layout/StatusBar.vue'
import TabsBar from './components/layout/TabsBar.vue'
import TitleBar from './components/layout/TitleBar.vue'
import Workspace from './components/layout/Workspace.vue'
import GetStarted from './components/welcome/GetStarted.vue'
import { useAppStore } from './stores/app'
import { useConnectionsStore } from './stores/connections'
import { useEnvironmentStore } from './stores/environment'
import { useTabsStore } from './stores/tabs'
import { useUiStore } from './stores/ui'

const tabs = useTabsStore()
const ui = useUiStore()
const environment = useEnvironmentStore()
const appStore = useAppStore()
const connections = useConnectionsStore()

const tab = computed(() => tabs.activeTab)

// Window title "Tinkerbox - <tab>" (native title: dock, window menu, task switchers).
const windowTitle = computed(() => (tab.value ? `Tinkerbox - ${tabs.displayTitle(tab.value)}` : 'Tinkerbox'))
let titleTimer: ReturnType<typeof setTimeout> | null = null
watch(
  windowTitle,
  (title) => {
    if (titleTimer) clearTimeout(titleTimer)
    if (typeof document !== 'undefined') document.title = title
    titleTimer = setTimeout(() => void api.invoke('window:setTitle', title).catch(() => undefined), 60)
  },
  { immediate: true }
)

// Load autocompletion data for the active project shortly after it becomes active.
let envTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => (tab.value?.kind === 'code' ? (tab.value.connectionId ?? '') : null),
  (key) => {
    if (envTimer) clearTimeout(envTimer)
    if (key === null) return
    envTimer = setTimeout(() => void environment.load(key === '' ? null : key), 700)
  },
  { immediate: true }
)

// Tabs without a project (`connectionId: null`) run in the Default Working Directory, else the sandbox, else plain
// PHP. When that target changes, the cached autocompletion data of the default key is stale: drop it and reload it
// for the active default tab (the footer's framework label comes from it too).
watch(
  () => [connections.defaultDirectory, appStore.sandboxInstalled] as const,
  () => {
    environment.invalidate(null)
    if (tab.value?.kind === 'code' && !tab.value.connectionId) void environment.load(null)
  }
)

onBeforeUnmount(() => {
  if (titleTimer) clearTimeout(titleTimer)
  if (envTimer) clearTimeout(envTimer)
})
</script>

<template>
  <div class="flex h-full flex-col bg-app text-fg" :data-zen="ui.zen || undefined">
    <TitleBar />
    <div class="flex min-h-0 flex-1">
      <Sidebar v-if="ui.showSidebar" />
      <main :class="['flex min-w-0 flex-1 flex-col', ui.showSidebar ? '' : 'pl-2']">
        <TabsBar v-if="ui.showChrome" class="relative z-10 -mb-px" />
        <section
          :class="[
            'relative min-h-0 flex-1 overflow-hidden border-t border-l border-line bg-surface',
            ui.showChrome ? 'rounded-tl-xl' : 'rounded-t-xl border-r',
            ui.showSidebar || !ui.showChrome ? '' : 'rounded-tl-xl'
          ]"
        >
          <GetStarted v-if="tab?.kind === 'welcome'" />
          <Workspace v-else-if="tab" :tab-id="tab.id" />
          <div v-else class="flex h-full items-center justify-center text-muted">
            <Spinner :size="20" />
          </div>
        </section>
        <StatusBar v-if="ui.showChrome" />
      </main>
    </div>
    <ModalHost />
    <Toasts />
    <ContextMenu />
  </div>
</template>
