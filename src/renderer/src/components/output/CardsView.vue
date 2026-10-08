<script setup lang="ts">
/**
 * Cards view: one rounded card per output event in execution order (echo text, dumped values, SQL queries when
 * the SQL toggle is on) plus the return value, with the exception (Collision style), bootstrap failures,
 * warnings, raw stdout / stderr and transport errors around them.
 */
import { computed, ref, watch } from 'vue'
import { ChevronRight, CircleSlash, Copy, Database, Eye, FileText, Network, Play, ServerCrash, Table2, TriangleAlert } from 'lucide-vue-next'
import type { DumpNode, OutputEvent, RunResult } from '@shared/types'
import { useSettingsStore } from '../../stores/settings'
import { runStopNote } from '../../utils/dumpText'
import { formatDuration, pluralize } from '../../utils/format'
import EmptyState from '../common/EmptyState.vue'
import IconButton from '../common/IconButton.vue'
import Kbd from '../common/Kbd.vue'
import Spinner from '../common/Spinner.vue'
import { copyText, displayPath, openHtmlPreview, openInEditor, openObjectGraph, openTablePreview, revealLine } from './actions'
import DumpTree from './DumpTree.vue'
import ExceptionView from './ExceptionView.vue'
import OutputCard from './OutputCard.vue'
import SqlCode from './SqlCode.vue'
import { eventMarkdown, eventText, valueMarkdown, valueText } from './lib/copy'
import { hasHtml, hasNestedStructure, htmlTitle, shortClass } from './lib/dump'
import { isTabulable } from './lib/serialize'

const props = defineProps<{
  tabId: string
  result: RunResult | null
  running: boolean
  streamed: string
  showQueries: boolean
  connectionId: string | null
}>()

const settings = useSettingsStore()

/** Echo text longer than this renders in pages. */
const TEXT_PAGE = 100_000
/** Event cards rendered before "Show more". */
const EVENT_PAGE = 150

const r = computed(() => props.result)
const exception = computed(() => r.value?.exception ?? null)
const collision = computed(() => {
  const preference = r.value?.driver?.usesCollision
  return preference === null || preference === undefined ? settings.settings.collision : preference
})
const allEvents = computed<OutputEvent[]>(() => r.value?.events ?? [])
const queries = computed(() => allEvents.value.filter((e): e is Extract<OutputEvent, { kind: 'query' }> => e.kind === 'query'))
/** Visible cards: queries only with the SQL toggle; bare newlines between dumps are not worth a card. */
const events = computed(() =>
  allEvents.value.filter((e) => (e.kind === 'query' ? props.showQueries : e.kind === 'echo' ? e.text.trim() !== '' : true))
)
/** Cards rendered so far (long runs render progressively). */
const eventLimit = ref(EVENT_PAGE)
const shownEvents = computed(() => events.value.slice(0, eventLimit.value))
const queryTime = computed(() => queries.value.reduce((sum, q) => sum + (Number.isFinite(q.timeMs) ? q.timeMs : 0), 0))
const hasEcho = computed(() => allEvents.value.some((e) => e.kind === 'echo'))
const diagnostics = computed(() => r.value?.diagnostics ?? [])
const driverName = computed(() => r.value?.driver?.name || 'the framework')

const rawOpen = ref(true)
const stderrOpen = ref(true)
const textLimits = ref<Record<number, number>>({})

watch(
  () => r.value?.runId,
  () => {
    const result = r.value
    // Realtime output (no echo events) is the main output: show it. Framework noise next to events: fold it.
    rawOpen.value = !!result && (!hasEcho.value || result.rawOutput.length < 400)
    stderrOpen.value = !!result && !result.exception && !result.error
    textLimits.value = {}
    eventLimit.value = EVENT_PAGE
  },
  { immediate: true }
)

/** "Execution cancelled." / main's timeout message for stopped runs (shown once, not also as an error card). */
const stopNote = computed(() => (r.value ? runStopNote(r.value) : null))

const nothingToShow = computed(() => {
  const result = r.value
  if (!result) return false
  return (
    !result.error &&
    !result.exception &&
    events.value.length === 0 &&
    !result.hasReturnValue &&
    !result.rawOutput &&
    !result.stderr &&
    diagnostics.value.length === 0 &&
    !result.cancelled &&
    !result.timedOut &&
    !result.exited
  )
})

const runAccelerator = computed(() => settings.accelerator('run'))
const fontStyle = computed(() => ({
  fontSize: `${settings.settings.outputFontSize}px`,
  fontVariantLigatures: settings.settings.fontLigatures ? 'normal' : 'none'
}))

function valueTitle(node: DumpNode, line?: number, label?: string): string {
  const what = node.t === 'object' || node.t === 'ref' || node.t === 'enum' ? shortClass(node.class) : node.t === 'array' ? `array:${node.count}` : node.t
  const where = label || (line ? `Line ${line}` : '')
  return where ? `${where} · ${what}` : what
}

// Results are immutable: per-value checks are computed once.
const tabulableCache = new WeakMap<DumpNode, boolean>()
const eyeCache = new WeakMap<DumpNode, 'html' | 'graph' | null>()

function canTabulate(node: DumpNode): boolean {
  let value = tabulableCache.get(node)
  if (value === undefined) tabulableCache.set(node, (value = isTabulable(node)))
  return value
}

function eyeAction(node: DumpNode): 'html' | 'graph' | null {
  let value = eyeCache.get(node)
  if (value === undefined) {
    value = hasHtml(node) ? 'html' : hasNestedStructure(node) ? 'graph' : null
    eyeCache.set(node, value)
  }
  return value
}

function openEye(node: DumpNode, title: string): void {
  if (hasHtml(node)) openHtmlPreview(node.html, htmlTitle(node), props.tabId)
  else openObjectGraph(node, title)
}

function shownText(seq: number, text: string): string {
  const limit = textLimits.value[seq] ?? TEXT_PAGE
  return text.length > limit ? text.slice(0, limit) : text
}

function showMoreText(seq: number): void {
  textLimits.value = { ...textLimits.value, [seq]: (textLimits.value[seq] ?? TEXT_PAGE) + TEXT_PAGE * 5 }
}

function copyAllQueries(): void {
  const text = queries.value.map((q) => `${q.rawSql || q.sql};`).join('\n')
  void copyText(text, `${pluralize(queries.value.length, 'query', 'queries')} copied to the clipboard.`)
}

function slow(ms: number): boolean {
  return ms >= 100
}

function diagnosticLocation(d: { file: string; line: number; userLine?: number }): { text: string; go: () => void } {
  if (!d.file || d.userLine) {
    const line = d.userLine ?? d.line
    return { text: `Line ${line}`, go: () => revealLine(props.tabId, line) }
  }
  return { text: `${displayPath(d.file, props.connectionId)}:${d.line}`, go: () => void openInEditor(d.file, d.line, props.connectionId) }
}
</script>

<template>
  <div class="h-full overflow-y-auto overscroll-contain" data-testid="cards-view">
    <div class="space-y-2.5 p-3 pb-6" :style="fontStyle">
      <!-- Live (realtime) output while running -->
      <OutputCard v-if="running && streamed" tone="live" :tab-id="tabId" label="Live output">
        <div class="mb-1.5 flex items-center gap-2 font-sans text-[11.5px] font-medium text-accent select-none">
          <Spinner :size="12" /> Receiving output…
        </div>
        <pre class="selectable font-mono whitespace-pre-wrap break-words text-fg">{{ streamed }}</pre>
      </OutputCard>

      <div v-if="running && !streamed && !r" class="flex items-center justify-center gap-2 py-16 font-sans text-[13px] text-muted">
        <Spinner :size="16" /> Running…
      </div>

      <EmptyState
        v-if="!r && !running"
        :icon="Play"
        title="Nothing to show yet"
        description="Run your code and its output — echo, dump(), queries and the return value — appears here."
        class="pt-16"
      >
        <template v-if="runAccelerator" #actions>
          <span class="flex items-center gap-1.5 font-sans text-[12px] text-muted">Press <Kbd :accelerator="runAccelerator" size="sm" /> to run</span>
        </template>
      </EmptyState>

      <div v-if="r" :class="['space-y-2.5 transition-opacity duration-200', running ? 'pointer-events-none opacity-45' : '']">
        <!-- Transport error -->
        <OutputCard v-if="r.error && r.error !== stopNote" tone="danger" :tab-id="tabId" compact>
          <template #actions>
            <IconButton :icon="Copy" label="Copy" size="xs" @click="copyText(r.error ?? '')" />
          </template>
          <div class="flex items-start gap-2.5 py-1">
            <ServerCrash :size="17" :stroke-width="1.9" class="mt-0.5 shrink-0 text-danger" />
            <div class="min-w-0">
              <p class="font-sans text-[13.5px] font-semibold text-fg">Could not run the code</p>
              <pre class="selectable mt-1 font-mono text-[0.92em] whitespace-pre-wrap break-words text-muted">{{ r.error }}</pre>
            </div>
          </div>
        </OutputCard>

        <!-- Bootstrap failure -->
        <OutputCard v-if="exception && exception.bootstrap" tone="danger" :tab-id="tabId">
          <div class="mb-3 flex items-start gap-2.5 border-b border-line pb-3">
            <ServerCrash :size="18" :stroke-width="1.9" class="mt-0.5 shrink-0 text-danger" />
            <div class="min-w-0 font-sans">
              <p class="text-[14px] font-semibold text-fg">Bootstrap failed</p>
              <p class="mt-0.5 text-[12.5px] leading-relaxed text-muted">
                {{ driverName }} could not be booted, so your code did not run. Fix the error below (often a missing
                <span class="font-mono">.env</span>, <span class="font-mono">vendor/</span> or a broken service provider) and run again.
              </p>
            </div>
          </div>
          <ExceptionView :exception="exception" :tab-id="tabId" :connection-id="connectionId" :compact="!collision" />
        </OutputCard>

        <!-- Exception -->
        <OutputCard v-else-if="exception" tone="danger" :tab-id="tabId" :compact="!collision">
          <ExceptionView :exception="exception" :tab-id="tabId" :connection-id="connectionId" :compact="!collision" />
        </OutputCard>

        <!-- Warnings / notices / deprecations -->
        <OutputCard
          v-for="(d, i) in diagnostics"
          :key="`d${i}`"
          tone="warning"
          compact
          :tab-id="tabId"
          :connection-id="connectionId"
          :line="d.file && !d.userLine ? d.line : (d.userLine ?? d.line)"
          :file="d.file && !d.userLine ? d.file : undefined"
        >
          <div class="flex items-start gap-2 font-mono text-[0.92em]">
            <TriangleAlert :size="14" :stroke-width="2.2" class="mt-[0.2em] shrink-0 text-warning" />
            <span class="selectable min-w-0 break-words">
              <span class="font-semibold text-warning">{{ d.level }}</span>
              <span class="text-fg">&nbsp; {{ d.message }}</span>
              <span v-if="d.file && d.userLine" class="text-muted"> ({{ diagnosticLocation({ file: d.file, line: d.line }).text }})</span>
            </span>
          </div>
        </OutputCard>

        <!-- Query summary -->
        <div v-if="showQueries && queries.length" class="flex items-center gap-2 px-1 font-sans text-[11.5px] text-muted select-none">
          <Database :size="13" :stroke-width="2" />
          <span>
            <span class="font-semibold text-fg">{{ pluralize(queries.length, 'query', 'queries') }}</span>
            in <span :class="['font-semibold tabular', slow(queryTime) ? 'text-warning' : 'text-fg']">{{ formatDuration(queryTime) }}</span>
          </span>
          <span class="flex-1" />
          <button type="button" class="rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-fg" @click="copyAllQueries">Copy all</button>
        </div>
        <div v-else-if="showQueries && !exception && !r.error" class="flex items-center gap-2 px-1 font-sans text-[11.5px] text-muted select-none">
          <Database :size="13" :stroke-width="2" /> No queries were executed.
        </div>

        <!-- Raw stdout (framework output / realtime echo) -->
        <OutputCard v-if="r.rawOutput" tone="muted" compact :tab-id="tabId">
          <template #actions>
            <IconButton :icon="Copy" label="Copy" size="xs" @click="copyText(r.rawOutput)" />
          </template>
          <button
            type="button"
            class="flex items-center gap-1 font-sans text-[11.5px] font-semibold text-muted select-none hover:text-fg"
            @click="rawOpen = !rawOpen"
          >
            <ChevronRight :size="13" :class="['transition-transform', rawOpen ? 'rotate-90' : '']" />
            {{ hasEcho ? 'Other output' : 'Output' }}
            <span class="font-normal">· {{ pluralize(r.rawOutput.split('\n').filter(Boolean).length, 'line') }}</span>
          </button>
          <pre v-if="rawOpen" class="selectable mt-1.5 font-mono whitespace-pre-wrap break-words text-fg">{{ shownText(-1, r.rawOutput) }}</pre>
        </OutputCard>

        <!-- Events -->
        <template v-for="event in shownEvents" :key="event.seq">
          <OutputCard v-if="event.kind === 'echo'" :tab-id="tabId" :line="event.line">
            <template #actions>
              <IconButton :icon="Copy" label="Copy" size="xs" @click="copyText(eventText(event))" />
              <IconButton :icon="FileText" label="Copy as Markdown" size="xs" @click="copyText(eventMarkdown(event), 'Copied as Markdown.')" />
            </template>
            <pre class="selectable font-mono whitespace-pre-wrap break-words text-fg">{{ shownText(event.seq, event.text) }}</pre>
            <button
              v-if="event.text.length > (textLimits[event.seq] ?? TEXT_PAGE)"
              type="button"
              class="mt-1 font-sans text-[12px] text-accent hover:underline"
              @click="showMoreText(event.seq)"
            >
              Show more ({{ (event.text.length - (textLimits[event.seq] ?? TEXT_PAGE)).toLocaleString() }} characters hidden)
            </button>
          </OutputCard>

          <OutputCard
            v-else-if="event.kind === 'dump'"
            :tab-id="tabId"
            :connection-id="connectionId"
            :line="event.line"
            :file="!event.userCode && event.file ? event.file : undefined"
          >
            <template #actions>
              <IconButton :icon="Copy" label="Copy" size="xs" @click="copyText(valueText(event.value))" />
              <IconButton :icon="FileText" label="Copy as Markdown" size="xs" @click="copyText(valueMarkdown(event.value), 'Copied as Markdown.')" />
              <IconButton
                v-if="canTabulate(event.value)"
                :icon="Table2"
                label="Table Preview"
                size="xs"
                @click="openTablePreview(event.value, valueTitle(event.value, event.line, event.label))"
              />
              <IconButton
                v-if="eyeAction(event.value)"
                :icon="eyeAction(event.value) === 'html' ? Eye : Network"
                :label="eyeAction(event.value) === 'html' ? 'HTML Preview' : 'Object Graph'"
                size="xs"
                @click="openEye(event.value, valueTitle(event.value, event.line, event.label))"
              />
            </template>
            <div v-if="event.label" class="mb-1 font-sans text-[11px] font-semibold tracking-wide text-accent select-none">{{ event.label }}</div>
            <DumpTree :value="event.value" :tab-id="tabId" :connection-id="connectionId" />
          </OutputCard>

          <OutputCard v-else :tab-id="tabId" :line="event.line">
            <template #actions>
              <IconButton :icon="Copy" label="Copy SQL" size="xs" @click="copyText(eventText(event), 'SQL copied to the clipboard.')" />
              <IconButton :icon="FileText" label="Copy as Markdown" size="xs" @click="copyText(eventMarkdown(event), 'Copied as Markdown.')" />
            </template>
            <div class="mb-1.5 flex items-center gap-1.5 font-sans text-[11px] text-muted select-none">
              <Database :size="12" :stroke-width="2" />
              <span class="font-semibold">{{ event.connection }}</span>
              <span>·</span>
              <span :class="['tabular', slow(event.timeMs) ? 'font-semibold text-warning' : '']">{{ formatDuration(event.timeMs) }}</span>
              <template v-if="event.bindings.length">
                <span>·</span>
                <span :title="`Bindings: ${event.bindings.join(', ')}`">{{ pluralize(event.bindings.length, 'binding') }}</span>
              </template>
            </div>
            <SqlCode :sql="event.rawSql || event.sql" />
          </OutputCard>
        </template>

        <button
          v-if="events.length > shownEvents.length"
          type="button"
          class="w-full rounded-xl border border-dashed border-line py-2 font-sans text-[12.5px] text-accent hover:bg-hover"
          @click="eventLimit += EVENT_PAGE * 4"
        >
          Show {{ Math.min(events.length - shownEvents.length, EVENT_PAGE * 4).toLocaleString() }} more of
          {{ (events.length - shownEvents.length).toLocaleString() }} remaining outputs
        </button>

        <!-- Return value -->
        <OutputCard v-if="r.hasReturnValue && !exception && r.returnValue" :tab-id="tabId" :connection-id="connectionId" label="Return value">
          <template #actions>
            <IconButton :icon="Copy" label="Copy" size="xs" @click="copyText(valueText(r.returnValue))" />
            <IconButton :icon="FileText" label="Copy as Markdown" size="xs" @click="copyText(valueMarkdown(r.returnValue), 'Copied as Markdown.')" />
            <IconButton
              v-if="canTabulate(r.returnValue)"
              :icon="Table2"
              label="Table Preview"
              size="xs"
              @click="openTablePreview(r.returnValue, valueTitle(r.returnValue, undefined, 'Return value'))"
            />
            <IconButton
              v-if="eyeAction(r.returnValue)"
              :icon="eyeAction(r.returnValue) === 'html' ? Eye : Network"
              :label="eyeAction(r.returnValue) === 'html' ? 'HTML Preview' : 'Object Graph'"
              size="xs"
              @click="openEye(r.returnValue, valueTitle(r.returnValue, undefined, 'Return value'))"
            />
          </template>
          <DumpTree :value="r.returnValue" :tab-id="tabId" :connection-id="connectionId" />
        </OutputCard>

        <!-- Notes -->
        <OutputCard v-if="stopNote" tone="muted" compact :tab-id="tabId">
          <div class="flex items-center gap-2 font-sans text-[12.5px] text-muted">
            <CircleSlash :size="14" :stroke-width="2" class="shrink-0" />
            {{ stopNote }}
          </div>
        </OutputCard>
        <OutputCard v-if="r.exited && !exception" tone="muted" compact :tab-id="tabId">
          <div class="flex items-center gap-2 font-sans text-[12.5px] text-muted">
            <CircleSlash :size="14" :stroke-width="2" />
            The script ended early with <span class="font-mono text-fg">exit()</span> / <span class="font-mono text-fg">dd()</span>.
          </div>
        </OutputCard>

        <!-- stderr -->
        <OutputCard v-if="r.stderr" tone="muted" compact :tab-id="tabId">
          <template #actions>
            <IconButton :icon="Copy" label="Copy" size="xs" @click="copyText(r.stderr)" />
          </template>
          <button
            type="button"
            class="flex items-center gap-1 font-sans text-[11.5px] font-semibold text-muted select-none hover:text-fg"
            @click="stderrOpen = !stderrOpen"
          >
            <ChevronRight :size="13" :class="['transition-transform', stderrOpen ? 'rotate-90' : '']" />
            Error output (stderr)
          </button>
          <pre v-if="stderrOpen" class="selectable mt-1.5 font-mono whitespace-pre-wrap break-words text-danger/90">{{ r.stderr }}</pre>
        </OutputCard>

        <!-- Nothing at all -->
        <OutputCard v-if="nothingToShow" tone="muted" compact :tab-id="tabId">
          <p class="font-sans text-[12.5px] text-muted">
            Done in {{ formatDuration(r.durationMs) }} — nothing was printed or returned. Return a value, <span class="font-mono">echo</span> or
            <span class="font-mono">dump()</span> something to see it here.
          </p>
        </OutputCard>
      </div>
    </div>
  </div>
</template>
