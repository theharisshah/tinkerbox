<script setup lang="ts">
/**
 * Output pane of the active code tab: a slim toolbar (run status, Copy result, Save output, Clear) above either
 * Cards view or the CLI-mode text view (tab.outputMode).
 */
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import { Check, CircleSlash, ClipboardCopy, Download, Eraser, Square, TriangleAlert, X } from 'lucide-vue-next'
import { executeCommand } from '../../commands'
import { useSettingsStore } from '../../stores/settings'
import { useTabsStore } from '../../stores/tabs'
import { formatDuration, formatTime } from '../../utils/format'
import IconButton from '../common/IconButton.vue'
import Spinner from '../common/Spinner.vue'
import Tooltip from '../common/Tooltip.vue'
import CardsView from './CardsView.vue'
import { shortClass } from './lib/dump'
import { resultToCli } from './lib/cliFormat'

const CliOutput = defineAsyncComponent({
  loader: () => import('./CliOutput.vue'),
  loadingComponent: Spinner,
  delay: 150
})

const props = defineProps<{ tabId: string }>()

const tabs = useTabsStore()
const settings = useSettingsStore()

const tab = computed(() => tabs.byId(props.tabId))
const result = computed(() => tabs.resultOf(props.tabId))
const running = computed(() => tabs.isRunning(props.tabId))
const streamed = computed(() => tabs.streamedOf(props.tabId))
const mode = computed(() => tab.value?.outputMode ?? 'detail')
const showQueries = computed(() => tab.value?.showQueries ?? false)
const connectionId = computed(() => tab.value?.connectionId ?? null)

// -- elapsed time while running -----------------------------------------------------------------------------------

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
watch(
  running,
  (on) => {
    if (ticker) clearInterval(ticker)
    ticker = null
    if (on) {
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
  const started = tabs.runStartedAt[props.tabId]
  return running.value && started ? Math.max(0, now.value - started) : 0
})

// -- status --------------------------------------------------------------------------------------------------------

const status = computed<{ tone: 'ok' | 'error' | 'muted'; text: string; title: string } | null>(() => {
  const r = result.value
  if (!r) return null
  const at = `Finished at ${formatTime(r.finishedAt)} · total ${formatDuration(r.totalMs)}`
  // Stopped runs also carry `error` (= the stop note), so they are checked first.
  if (r.timedOut) return { tone: 'muted', text: 'Timed out', title: r.error || at }
  if (r.cancelled) return { tone: 'muted', text: 'Cancelled', title: at }
  if (r.error) return { tone: 'error', text: 'Failed', title: r.error }
  if (r.exception) return { tone: 'error', text: shortClass(r.exception.class), title: `${r.exception.class}: ${r.exception.message}` }
  return { tone: 'ok', text: formatDuration(r.durationMs), title: at }
})

// -- CLI text ------------------------------------------------------------------------------------------------------

const resultText = computed(() => (result.value ? resultToCli(result.value, { showQueries: showQueries.value }).replace(/\n$/, '') : ''))
const cliText = computed(() => (running.value && streamed.value ? streamed.value : resultText.value))
const cliPlaceholder = computed(() => {
  if (running.value) return 'Running…'
  if (!result.value) {
    const accel = settings.accelerator('run')
    return accel ? 'Run your code to see its output here.' : ''
  }
  return '(no output)'
})

const hasResult = computed(() => !!result.value)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-app-alt" data-testid="output-pane">
    <div class="flex h-8 shrink-0 items-center gap-1 pr-2 pl-3 select-none">
      <div class="flex min-w-0 flex-1 items-center gap-2 font-sans text-[11.5px] text-muted">
        <template v-if="running">
          <Spinner :size="12" class="text-accent" />
          <span class="tabular">Running… {{ formatDuration(elapsed) }}</span>
          <button
            type="button"
            class="ml-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium hover:bg-hover hover:text-fg"
            @click="executeCommand('cancelRun')"
          >
            <Square :size="10" :stroke-width="2.6" /> Stop
          </button>
        </template>
        <Tooltip v-else-if="status" :text="status.title" placement="bottom-start">
          <span
            :class="[
              'inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 font-medium',
              status.tone === 'ok' ? 'text-success' : status.tone === 'error' ? 'bg-danger/10 text-danger' : 'text-muted'
            ]"
          >
            <Check v-if="status.tone === 'ok'" :size="12" :stroke-width="2.6" />
            <TriangleAlert v-else-if="status.tone === 'error' && result?.exception" :size="12" :stroke-width="2.4" />
            <X v-else-if="status.tone === 'error'" :size="12" :stroke-width="2.6" />
            <CircleSlash v-else :size="12" :stroke-width="2.4" />
            <span class="truncate tabular">{{ status.text }}</span>
          </span>
        </Tooltip>
        <span v-if="mode === 'cli'" class="rounded-md bg-fg/5 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-muted">CLI</span>
      </div>
      <IconButton :icon="ClipboardCopy" label="Copy result" command="copyResult" size="xs" :disabled="!hasResult" @click="executeCommand('copyResult')" />
      <IconButton :icon="Download" label="Save output…" command="saveOutput" size="xs" :disabled="!hasResult" @click="executeCommand('saveOutput')" />
      <IconButton
        :icon="Eraser"
        label="Clear output"
        command="clearOutput"
        size="xs"
        :disabled="!hasResult && !streamed"
        tooltip-placement="bottom-end"
        @click="executeCommand('clearOutput')"
      />
    </div>

    <div class="min-h-0 flex-1">
      <CardsView
        v-if="mode === 'detail'"
        :tab-id="tabId"
        :result="result"
        :running="running"
        :streamed="streamed"
        :show-queries="showQueries"
        :connection-id="connectionId"
      />
      <div v-else class="h-full p-2 pt-0">
        <div class="h-full overflow-hidden rounded-xl border border-line">
          <CliOutput :tab-id="tabId" :connection-id="connectionId" :text="cliText" :placeholder="cliText ? '' : cliPlaceholder" />
        </div>
      </div>
    </div>
  </div>
</template>
