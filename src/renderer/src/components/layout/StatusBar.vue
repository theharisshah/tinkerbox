<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Bug, ChevronDown, ChevronUp, CircleCheck, Info, TriangleAlert, Zap } from 'lucide-vue-next'
import { executeCommand } from '../../commands'
import { useAppStore } from '../../stores/app'
import { useConnectionsStore } from '../../stores/connections'
import { useEnvironmentStore } from '../../stores/environment'
import { useSettingsStore } from '../../stores/settings'
import { useTabsStore } from '../../stores/tabs'
import { useUiStore } from '../../stores/ui'
import { formatBytes, formatDuration, formatTime } from '../../utils/format'
import Spinner from '../common/Spinner.vue'
import Tooltip from '../common/Tooltip.vue'

/**
 * Footer: framework ⓘ (Panels), PHP version (PHP Settings), time / memory of the last run, Xdebug + auto-run
 * badges, autocompletion status, the vim status slot (#vim-status-<tabId>) and the output chevron.
 */
const tabs = useTabsStore()
const ui = useUiStore()
const settings = useSettingsStore()
const connections = useConnectionsStore()
const environment = useEnvironmentStore()
const app = useAppStore()

const tab = computed(() => (tabs.activeTab?.kind === 'code' ? tabs.activeTab : null))
const result = computed(() => (tab.value ? tabs.resultOf(tab.value.id) : null))
const env = computed(() => (tab.value ? environment.get(tab.value.connectionId) : null))
const envStatus = computed(() => (tab.value ? environment.statusOf(tab.value.connectionId) : 'idle'))
const envError = computed(() => (tab.value ? environment.errorOf(tab.value.connectionId) : null))
const running = computed(() => tabs.isRunning(tab.value?.id))
const debugging = computed(() => !!tab.value && connections.isDebugging(tab.value.connectionId))

const driver = computed(() => result.value?.driver ?? env.value?.driver ?? null)
const frameworkLabel = computed(() => {
  const d = driver.value
  if (d && d.id !== 'none') return d.appVersion || d.name
  if (!tab.value) return ''
  if (!connections.path(tab.value.connectionId)) return 'Plain PHP'
  if (d?.id === 'none') return 'No framework'
  return envStatus.value === 'loading' ? 'Detecting…' : 'Project'
})
const phpVersion = computed(() => result.value?.phpVersion || env.value?.phpVersion || '')

// Elapsed time while running.
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
watch(
  running,
  (isRunning) => {
    if (ticker) clearInterval(ticker)
    ticker = null
    if (isRunning) {
      now.value = Date.now()
      ticker = setInterval(() => (now.value = Date.now()), 100)
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})

const elapsed = computed(() => {
  const started = tab.value ? tabs.runStartedAt[tab.value.id] : undefined
  return started ? Math.max(0, now.value - started) : 0
})

const timing = computed(() => {
  const r = result.value
  if (!r) return ''
  if (r.cancelled) return 'Stopped'
  if (r.timedOut) return 'Timed out'
  if (!r.phpVersion && r.error) return 'Failed'
  return `${formatDuration(r.durationMs)} / ${formatBytes(r.memoryPeak)}`
})

const timingTooltip = computed(() => {
  const r = result.value
  if (!r) return ''
  const started = r.finishedAt - r.totalMs
  const parts = [`Started at ${formatTime(started)}`, `Code: ${formatDuration(r.durationMs)}`]
  if (r.bootMs > 0) parts.push(`Framework boot: ${formatDuration(r.bootMs)}`)
  parts.push(`Total incl. PHP startup: ${formatDuration(r.totalMs)}`)
  if (r.memoryPeak > 0) parts.push(`Peak memory: ${formatBytes(r.memoryPeak)}`)
  return parts.join(' · ')
})

const completionLabel = computed(() => {
  switch (envStatus.value) {
    case 'loading':
      return 'Indexing…'
    case 'ready':
      return 'Autocompletion ready'
    case 'error':
      return 'Autocompletion unavailable'
    default:
      return ''
  }
})

const completionTooltip = computed(() => {
  if (envStatus.value === 'error') return `${envError.value ?? 'Introspection failed'} — click to retry`
  if (envStatus.value === 'ready' && env.value) {
    return `${env.value.classes.length.toLocaleString('en-US')} classes, ${env.value.functions.length.toLocaleString('en-US')} functions indexed — click to re-index`
  }
  return 'Reading classes and functions of the project'
})

function reindex(): void {
  if (tab.value && envStatus.value !== 'loading') void environment.load(tab.value.connectionId, true)
}

function openPanels(): void {
  void executeCommand('showPanels')
}

function openPhp(): void {
  void executeCommand('phpSettings')
}
</script>

<template>
  <footer class="flex h-8 shrink-0 items-center gap-0 border-t border-line bg-app px-1.5 font-mono text-[11.5px] text-muted tabular">
    <template v-if="tab">
      <button
        type="button"
        class="flex h-6 items-center gap-1.5 rounded-md px-2 hover:bg-hover hover:text-fg"
        title="App information panels"
        data-testid="status-framework"
        @click="openPanels"
      >
        <span class="max-w-[220px] truncate">{{ frameworkLabel }}</span>
        <Info :size="13" class="text-accent" :stroke-width="2.2" />
      </button>
      <span class="mx-0.5 h-3.5 w-px bg-line" />
      <button
        type="button"
        class="flex h-6 items-center rounded-md px-2 hover:bg-hover hover:text-fg"
        title="PHP Settings"
        data-testid="status-php"
        @click="openPhp"
      >
        {{ phpVersion ? `PHP ${phpVersion}` : 'PHP' }}
      </button>
      <template v-if="running || timing">
        <span class="mx-0.5 h-3.5 w-px bg-line" />
        <span v-if="running" class="flex h-6 items-center gap-1.5 px-2 text-accent">
          <Spinner :size="12" /> {{ formatDuration(elapsed) }}
        </span>
        <Tooltip v-else :text="timingTooltip" placement="top">
          <span class="flex h-6 items-center px-2" data-testid="status-timing">{{ timing }}</span>
        </Tooltip>
      </template>
      <template v-if="debugging">
        <span class="mx-0.5 h-3.5 w-px bg-line" />
        <button
          type="button"
          class="flex h-6 items-center gap-1 rounded-md px-2 font-sans text-[11px] font-semibold text-warning hover:bg-warning/10"
          title="Xdebug step debugging is on — click to turn it off"
          @click="executeCommand('toggleDebugging')"
        >
          <Bug :size="13" /> Xdebug
        </button>
      </template>
      <template v-if="settings.settings.autoRun">
        <span class="mx-0.5 h-3.5 w-px bg-line" />
        <button
          type="button"
          class="flex h-6 items-center gap-1 rounded-md px-2 font-sans text-[11px] font-semibold text-accent hover:bg-accent-soft"
          title="Auto evaluate is on — click to turn it off"
          @click="executeCommand('toggleAutoRun')"
        >
          <Zap :size="12" fill="currentColor" /> Auto
        </button>
      </template>
    </template>

    <span v-else class="px-2 font-sans text-[11px]">Tinkerbox{{ app.info?.version ? ` ${app.info.version}` : '' }}</span>

    <div class="flex-1" />

    <template v-if="tab">
      <Tooltip v-if="completionLabel" :text="completionTooltip" placement="top-end">
        <button
          type="button"
          :class="[
            'flex h-6 items-center gap-1.5 rounded-md px-2 font-sans text-[11px] hover:bg-hover',
            envStatus === 'error' ? 'text-warning' : ''
          ]"
          @click="reindex"
        >
          <Spinner v-if="envStatus === 'loading'" :size="11" />
          <CircleCheck v-else-if="envStatus === 'ready'" :size="13" class="text-success" />
          <TriangleAlert v-else :size="13" />
          <span class="hidden md:inline">{{ completionLabel }}</span>
        </button>
      </Tooltip>
      <div v-show="settings.settings.vimMode" :id="`vim-status-${tab.id}`" class="flex h-6 items-center px-2" data-testid="vim-status" />
      <span class="mx-0.5 h-3.5 w-px bg-line" />
      <button
        type="button"
        class="flex size-6 items-center justify-center rounded-md hover:bg-hover hover:text-fg"
        :title="ui.showOutput ? 'Hide output' : 'Show output'"
        :aria-label="ui.showOutput ? 'Hide output' : 'Show output'"
        @click="executeCommand('toggleOutput')"
      >
        <ChevronDown v-if="ui.showOutput" :size="15" />
        <ChevronUp v-else :size="15" />
      </button>
    </template>
  </footer>
</template>
