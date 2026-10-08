<script setup lang="ts">
/**
 * Collision-style exception: class, message, location ("your code, line N" or project file), code snippet with
 * the failing line highlighted, stack trace with vendor frames folded, previous exceptions. `compact` renders the
 * message-only form used when Collision output is disabled (Settings → Advanced, or the project's driver).
 */
import { computed, ref } from 'vue'
import { ChevronRight, Copy, TriangleAlert } from 'lucide-vue-next'
import type { ExceptionInfo, TraceFrame } from '@shared/types'
import { exceptionToText } from '../../utils/dumpText'
import { pluralize } from '../../utils/format'
import IconButton from '../common/IconButton.vue'
import { copyText, displayPath, openInEditor, revealLine } from './actions'
import { splitClass } from './lib/dump'

defineOptions({ name: 'ExceptionView' })

const props = withDefaults(
  defineProps<{
    exception: ExceptionInfo
    tabId?: string
    connectionId?: string | null
    compact?: boolean
    /** Rendered as a previous exception inside another one. */
    nested?: boolean
  }>(),
  { tabId: undefined, connectionId: null, compact: false, nested: false }
)

const e = computed(() => props.exception)
const cls = computed(() => splitClass(e.value.class))
const showDetails = ref(!props.nested)
const showPrevious = ref(false)
const openGroups = ref(new Set<number>())

const isUserOrigin = computed(() => e.value.file === '')

/** previous → previous → … (shown flat, newest cause first). */
const previousChain = computed<ExceptionInfo[]>(() => {
  const out: ExceptionInfo[] = []
  let p = e.value.previous
  while (p && out.length < 10) {
    out.push(p)
    p = p.previous
  }
  return out
})

interface Location {
  user: boolean
  file?: string
  line?: number
  text: string
}

function frameLocation(frame: { file?: string; line?: number; userCode?: boolean }): Location | null {
  if (frame.userCode && frame.line) return { user: true, line: frame.line, text: `your code, line ${frame.line}` }
  if (frame.file) {
    const path = displayPath(frame.file, props.connectionId)
    return { user: false, file: frame.file, line: frame.line, text: `${path}${frame.line ? `:${frame.line}` : ''}` }
  }
  return null
}

const origin = computed<Location | null>(() => {
  if (isUserOrigin.value) return { user: true, line: e.value.line, text: `your code, line ${e.value.line}` }
  return frameLocation({ file: e.value.file, line: e.value.line })
})

/** Where the user's code is involved when the error was thrown in a vendor / project file. */
const userHint = computed<number | null>(() => (!isUserOrigin.value && e.value.userLine ? e.value.userLine : null))

/** Which file the snippet comes from: the origin, else the first user / non-vendor frame on that line. */
const snippetSource = computed<Location | null>(() => {
  const snippet = e.value.snippet
  if (!snippet) return null
  if (isUserOrigin.value) return origin.value
  const candidates: Array<{ file?: string; line?: number; userCode?: boolean; vendor?: boolean }> = [
    { file: e.value.file, line: e.value.line, vendor: /(^|\/)vendor\//.test(e.value.file) },
    ...e.value.trace
  ]
  for (const c of candidates) {
    if (c.line !== snippet.line) continue
    if (c.userCode || (c.file && !c.vendor)) return frameLocation(c)
  }
  return origin.value
})

const snippetLines = computed(() => {
  const s = e.value.snippet
  if (!s) return []
  const width = String(s.startLine + s.lines.length - 1).length
  return s.lines.map((code, i) => ({ n: s.startLine + i, label: String(s.startLine + i).padStart(width), code, active: s.startLine + i === s.line }))
})

type TraceRow = { kind: 'frame'; frame: TraceFrame; number: number } | { kind: 'vendor'; frames: TraceFrame[]; group: number; first: number }

const traceRows = computed<TraceRow[]>(() => {
  const rows: TraceRow[] = []
  let number = 0
  let group = 0
  let pending: TraceFrame[] = []
  let pendingFirst = 0
  const flush = (): void => {
    if (!pending.length) return
    if (pending.length === 1) rows.push({ kind: 'frame', frame: pending[0], number: pendingFirst })
    else rows.push({ kind: 'vendor', frames: pending, group: group++, first: pendingFirst })
    pending = []
  }
  for (const frame of e.value.trace) {
    number++
    if (frame.vendor) {
      if (!pending.length) pendingFirst = number
      pending.push(frame)
      continue
    }
    flush()
    rows.push({ kind: 'frame', frame, number })
  }
  flush()
  return rows
})

function toggleGroup(group: number): void {
  const next = new Set(openGroups.value)
  if (next.has(group)) next.delete(group)
  else next.add(group)
  openGroups.value = next
}

function go(location: Location | null): void {
  if (!location) return
  if (location.user) revealLine(props.tabId, location.line)
  else if (location.file) void openInEditor(location.file, location.line, props.connectionId)
}

function goSnippetLine(n: number): void {
  const source = snippetSource.value
  if (!source) return
  go({ ...source, line: n })
}

function copy(): void {
  void copyText(exceptionToText(e.value), 'Exception copied to the clipboard.')
}
</script>

<template>
  <!-- Compact (Collision disabled) -->
  <div v-if="compact" class="selectable flex items-start gap-2.5">
    <TriangleAlert :size="16" :stroke-width="2" class="mt-0.5 shrink-0 text-danger" />
    <div class="min-w-0 flex-1 font-mono">
      <span class="font-semibold text-danger">{{ e.class }}</span
      ><span class="text-muted">: </span><span class="whitespace-pre-wrap break-words text-fg">{{ e.message }}</span>
      <button
        v-if="origin"
        type="button"
        class="ml-2 font-sans text-[12px] text-muted underline decoration-dotted underline-offset-2 hover:text-accent"
        @click="go(origin)"
      >
        {{ origin.text }}
      </button>
    </div>
  </div>

  <div v-else class="selectable min-w-0">
    <!-- Header -->
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 pr-6">
          <span
            :class="[
              'inline-flex items-center rounded-md font-sans font-semibold tracking-wide',
              nested ? 'bg-danger/10 px-1.5 py-px text-[11px] text-danger' : 'bg-danger px-2 py-0.5 text-[11.5px] text-on-accent'
            ]"
            :title="e.class"
          >
            <span v-if="cls.ns" class="opacity-70">{{ cls.ns }}</span>{{ cls.name }}
          </span>
          <span v-if="e.fatal" class="rounded-md bg-danger/10 px-1.5 py-px font-sans text-[11px] font-semibold text-danger">Fatal error</span>
          <span v-if="e.code && e.code !== '0'" class="rounded-md bg-fg/5 px-1.5 py-px font-mono text-[11px] text-muted" title="Exception code"
            >code {{ e.code }}</span
          >
        </div>
        <p :class="['mt-2 whitespace-pre-wrap break-words font-sans leading-snug font-medium text-fg', nested ? 'text-[13px]' : 'text-[15px]']">
          {{ e.message || '(no message)' }}
        </p>
        <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[12px] text-muted">
          <span v-if="origin">
            at
            <button type="button" class="font-medium text-accent underline-offset-2 hover:underline" @click="go(origin)">{{ origin.text }}</button>
          </span>
          <span v-if="userHint">
            via
            <button type="button" class="font-medium text-accent underline-offset-2 hover:underline" @click="revealLine(tabId, userHint)">
              your code, line {{ userHint }}
            </button>
          </span>
          <button
            v-if="nested && (e.snippet || e.trace.length)"
            type="button"
            class="inline-flex items-center gap-0.5 hover:text-fg"
            @click="showDetails = !showDetails"
          >
            <ChevronRight :size="13" :class="['transition-transform', showDetails ? 'rotate-90' : '']" />
            {{ showDetails ? 'Hide details' : 'Show details' }}
          </button>
        </div>
      </div>
      <IconButton v-if="!nested" :icon="Copy" label="Copy exception" size="xs" class="-mt-0.5 -mr-1" @click="copy" />
    </div>

    <template v-if="showDetails">
      <!-- Snippet -->
      <div v-if="snippetLines.length" class="mt-3 overflow-hidden rounded-lg border border-line bg-app-alt font-mono text-[0.92em] leading-[1.65]">
        <div v-if="snippetSource && !snippetSource.user" class="px-3 pt-1.5 font-sans text-[11px] text-muted">{{ snippetSource.text }}</div>
        <!-- Long lines scroll horizontally (scrollbar always shown); the gutter stays put and the row highlights span
             the full scroll width. -->
        <div class="tw-snippet-scroll overflow-x-auto py-1.5">
          <div class="w-max min-w-full">
            <div
              v-for="l in snippetLines"
              :key="l.n"
              :class="['group flex cursor-pointer pr-3', l.active ? 'bg-danger/10' : 'hover:bg-hover']"
              :title="snippetSource?.user ? 'Show this line in the editor' : 'Open in your editor'"
              @click="goSnippetLine(l.n)"
            >
              <span class="sticky left-0 z-[1] flex shrink-0 bg-app-alt select-none">
                <span :class="['flex', l.active ? 'bg-danger/10' : 'group-hover:bg-hover']">
                  <span :class="['w-7 shrink-0 text-center', l.active ? 'font-bold text-danger' : 'text-transparent']">➜</span>
                  <span :class="['shrink-0 pr-2 text-right tabular', l.active ? 'font-semibold text-danger' : 'text-muted']">{{ l.label }}</span>
                  <span class="shrink-0 pr-3 text-line">▕</span>
                </span>
              </span>
              <span :class="['whitespace-pre', l.active ? 'text-fg' : 'text-fg/80']">{{ l.code || ' ' }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Trace -->
      <div v-if="traceRows.length" class="mt-3">
        <div class="mb-1 font-sans text-[10.5px] font-bold tracking-[0.08em] text-muted uppercase select-none">Stack trace</div>
        <ol class="space-y-px font-mono text-[0.9em]">
          <template v-for="row in traceRows" :key="row.kind === 'frame' ? `f${row.number}` : `g${row.group}`">
            <li v-if="row.kind === 'frame'" class="flex gap-3 rounded-md px-1.5 py-0.5 hover:bg-hover">
              <span class="w-6 shrink-0 text-right text-muted tabular select-none">{{ row.number }}</span>
              <span class="min-w-0 flex-1">
                <span :class="['break-all', row.frame.userCode ? 'font-medium text-fg' : 'text-fg/85']">{{ row.frame.call }}</span>
                <button
                  v-if="frameLocation(row.frame)"
                  type="button"
                  :class="[
                    'block max-w-full truncate text-left font-sans text-[11.5px] underline-offset-2 hover:underline',
                    row.frame.userCode ? 'text-accent' : 'text-muted'
                  ]"
                  @click="go(frameLocation(row.frame))"
                >
                  {{ frameLocation(row.frame)?.text }}
                </button>
              </span>
            </li>
            <template v-else>
              <li>
                <button
                  type="button"
                  class="flex w-full items-center gap-3 rounded-md px-1.5 py-0.5 text-left font-sans text-[12px] text-muted select-none hover:bg-hover hover:text-fg"
                  @click="toggleGroup(row.group)"
                >
                  <span class="flex w-6 shrink-0 justify-end"
                    ><ChevronRight :size="13" :class="['transition-transform', openGroups.has(row.group) ? 'rotate-90' : '']"
                  /></span>
                  {{ pluralize(row.frames.length, 'vendor frame') }}
                </button>
              </li>
              <template v-if="openGroups.has(row.group)">
                <li v-for="(frame, i) in row.frames" :key="`g${row.group}-${i}`" class="flex gap-3 rounded-md px-1.5 py-0.5 opacity-80 hover:bg-hover">
                  <span class="w-6 shrink-0 text-right text-muted tabular select-none">{{ row.first + i }}</span>
                  <span class="min-w-0 flex-1">
                    <span class="break-all text-fg/85">{{ frame.call }}</span>
                    <button
                      v-if="frameLocation(frame)"
                      type="button"
                      class="block max-w-full truncate text-left font-sans text-[11.5px] text-muted underline-offset-2 hover:underline"
                      @click="go(frameLocation(frame))"
                    >
                      {{ frameLocation(frame)?.text }}
                    </button>
                  </span>
                </li>
              </template>
            </template>
          </template>
        </ol>
      </div>
    </template>

    <!-- Previous exceptions -->
    <div v-if="e.previous && !nested" class="mt-3 border-t border-line pt-2.5">
      <button
        type="button"
        class="flex items-center gap-1 font-sans text-[10.5px] font-bold tracking-[0.08em] text-muted uppercase select-none hover:text-fg"
        @click="showPrevious = !showPrevious"
      >
        <ChevronRight :size="13" :class="['transition-transform', showPrevious ? 'rotate-90' : '']" />
        Previous exception
        <span class="font-mono font-normal tracking-normal normal-case">· {{ splitClass(e.previous.class).name }}</span>
      </button>
      <div v-if="showPrevious" class="mt-2 space-y-3 border-l-2 border-danger/25 pl-3">
        <template v-for="(prev, i) in previousChain" :key="i">
          <ExceptionView :exception="prev" :tab-id="tabId" :connection-id="connectionId" nested />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The themed ::-webkit-scrollbar (style.css) instead of the standard thin one: classic scrollbars stay visible at rest,
   macOS overlay scrollbars would hide the only hint that a snippet line goes on. */
.tw-snippet-scroll {
  scrollbar-width: auto;
  scrollbar-color: auto;
}
</style>
