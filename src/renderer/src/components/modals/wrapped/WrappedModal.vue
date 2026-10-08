<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Component } from 'vue'
import {
  ChevronLeft,
  ChevronRight,
  Compass,
  Database,
  Moon,
  Pickaxe,
  Sparkles,
  Sunrise,
  WandSparkles,
  Wrench,
  X
} from 'lucide-vue-next'
import type { UsageStats } from '@shared/types'
import { api } from '../../../api'
import { useUiStore } from '../../../stores/ui'
import { formatDuration } from '../../../utils/format'
import Button from '../../common/Button.vue'
import EmptyState from '../../common/EmptyState.vue'
import IconButton from '../../common/IconButton.vue'
import Modal from '../../common/Modal.vue'
import Select from '../../common/Select.vue'
import Spinner from '../../common/Spinner.vue'
import HoursChart from './HoursChart.vue'
import {
  buildSlides,
  countOf,
  driverName,
  formatCount,
  formatHour,
  formatLongDuration,
  formatPercent,
  hourRange,
  peakHour,
  pickPersona,
  rankEntries,
  runsPerDay,
  shortClassName,
  slideBackground,
  successRate,
  totalExceptions,
  type PersonaId,
  type SlideId
} from './wrappedUtils'

/** "Year in Review": story-style slides of the yearly usage statistics ('stats:get'), ending with a persona. */
const props = defineProps<{ year?: number }>()
const emit = defineEmits<{ close: [result?: unknown] }>()

const ui = useUiStore()
const currentYear = new Date().getFullYear()
/** How many previous years are checked for statistics (year selector). */
const YEARS_BACK = 5

const year = ref<number>(props.year ?? currentYear)
const stats = shallowRef<UsageStats | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const years = ref<number[]>([year.value])
const index = ref(0)
let loadToken = 0

const slides = computed(() => buildSlides(stats.value))
const slide = computed<SlideId | null>(() => slides.value[index.value] ?? null)
const persona = computed(() => (stats.value ? pickPersona(stats.value) : null))
const yearOptions = computed(() => years.value.map((y) => ({ value: y, label: String(y) })))
const isLast = computed(() => index.value >= slides.value.length - 1)

const PERSONA_ICONS: Record<PersonaId, Component> = {
  'query-tuner': Database,
  'stacktrace-archaeologist': Pickaxe,
  'midnight-compiler': Moon,
  'dawn-patroller': Sunrise,
  'inline-oracle': WandSparkles,
  'codebase-nomad': Compass,
  'steady-tinkerer': Wrench
}

// Derived numbers for the slides.
const projects = computed(() => rankEntries(stats.value?.projects, 4))
const topDriver = computed(() => rankEntries(stats.value?.drivers, 1)[0] ?? null)
const peak = computed(() => peakHour(stats.value?.hours ?? []))
const exceptionCount = computed(() => (stats.value ? totalExceptions(stats.value) : 0))
const topException = computed(() => rankEntries(stats.value?.exceptions, 1)[0] ?? null)
const perDay = computed(() => (stats.value ? runsPerDay(stats.value) : null))
const avgRunMs = computed(() => (stats.value && stats.value.runs > 0 ? stats.value.totalRunMs / stats.value.runs : 0))
const firstRunLabel = computed(() =>
  stats.value?.firstRunAt ? new Date(stats.value.firstRunAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : ''
)

async function load(y: number): Promise<void> {
  const token = ++loadToken
  loading.value = true
  error.value = null
  try {
    const result = await api.invoke('stats:get', y)
    if (token !== loadToken) return
    stats.value = result
    index.value = 0
  } catch (err) {
    if (token !== loadToken) return
    stats.value = null
    error.value = api.errorText(err)
  } finally {
    if (token === loadToken) loading.value = false
  }
}

/** Years with recorded runs (current year always offered). */
async function probeYears(): Promise<void> {
  const candidates = Array.from({ length: YEARS_BACK + 1 }, (_, i) => currentYear - i)
  const results = await Promise.allSettled(candidates.map((y) => api.invoke('stats:get', y)))
  const found = new Set<number>([currentYear, year.value])
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.runs > 0) found.add(candidates[i])
  })
  years.value = [...found].sort((a, b) => b - a)
}

watch(year, (y) => void load(y))

function go(to: number): void {
  if (to < 0 || to >= slides.value.length) return
  index.value = to
}

function next(): void {
  if (isLast.value) emit('close')
  else go(index.value + 1)
}

function onKeydown(event: KeyboardEvent): void {
  if (ui.topModal?.name !== 'wrapped' || event.defaultPrevented) return
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'SELECT' || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    go(index.value + 1)
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    go(index.value - 1)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void load(year.value)
  void probeYears()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  loadToken++
})
</script>

<template>
  <Modal
    size="lg"
    hide-header
    :padded="false"
    height="min(620px, calc(100vh - 48px))"
    aria-label="Year in Review"
    initial-focus="[data-wrapped-stage]"
    @close="emit('close')"
  >
    <div class="flex h-full min-h-0 flex-col" data-testid="wrapped-modal">
      <header class="flex shrink-0 items-center gap-2 px-5 pt-4 pb-3">
        <Sparkles :size="17" class="text-accent" />
        <h2 class="text-[15px] font-semibold tracking-tight text-fg">Year in Review</h2>
        <div class="flex-1" />
        <Select v-if="years.length > 1" v-model="year" :options="yearOptions" size="sm" aria-label="Year" />
        <span v-else class="font-mono text-xs font-semibold text-muted">{{ year }}</span>
        <IconButton :icon="X" label="Close" size="sm" @click="emit('close')" />
      </header>

      <div class="relative mx-5 min-h-0 flex-1 overflow-hidden rounded-2xl border border-line outline-none" tabindex="-1" data-wrapped-stage>
        <div v-if="loading" class="flex h-full items-center justify-center gap-2 bg-app-alt text-[13px] text-muted">
          <Spinner :size="16" /> Crunching the numbers…
        </div>
        <EmptyState v-else-if="error" class="h-full bg-app-alt" :icon="Sparkles" title="Could not load your statistics" :description="error">
          <template #actions><Button @click="load(year)">Try again</Button></template>
        </EmptyState>
        <EmptyState
          v-else-if="!slide"
          class="h-full bg-app-alt"
          :icon="Sparkles"
          :title="`No runs in ${year} yet`"
          :description="
            year === currentYear
              ? 'Run some code and come back — your year in review fills up as you tinker.'
              : `Tinkerbox did not record any runs in ${year}.`
          "
        >
          <template #actions>
            <Button v-if="year === currentYear" variant="primary" @click="emit('close')">Start tinkering</Button>
          </template>
        </EmptyState>

        <Transition v-else name="tw-fade" mode="out-in">
          <div
            :key="`${year}-${slide}`"
            class="flex h-full flex-col items-center justify-center overflow-y-auto px-10 py-8 text-center"
            :style="{ background: slideBackground(slide) }"
            :data-slide="slide"
            aria-live="polite"
          >
            <!-- intro -->
            <template v-if="slide === 'intro' && stats">
              <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">Tinkerbox</p>
              <p
                class="mt-3 bg-gradient-to-br from-accent to-code-property bg-clip-text font-mono text-[84px] leading-none font-bold tracking-tight text-transparent"
              >
                {{ stats.year }}
              </p>
              <p class="mt-4 text-xl font-semibold text-fg">Your year in code</p>
              <p class="mt-2 max-w-md text-[13.5px] leading-relaxed text-muted">
                {{ countOf(stats.runs, 'run') }}<template v-if="firstRunLabel"> since {{ firstRunLabel }}</template>. Let's look
                back at how you tinkered.
              </p>
            </template>

            <!-- runs -->
            <template v-else-if="slide === 'runs' && stats">
              <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">Total runs</p>
              <p class="mt-3 text-[76px] leading-none font-bold tracking-tight text-fg tabular">{{ formatCount(stats.runs) }}</p>
              <p class="mt-4 text-[15px] text-fg">
                <span class="font-semibold text-success">{{ formatPercent(successRate(stats)) }}</span> of them ran without an error.
              </p>
              <p v-if="perDay !== null" class="mt-1.5 text-[13px] text-muted">
                That's about {{ perDay >= 10 ? Math.round(perDay) : perDay.toFixed(1) }} runs a day since your first one.
              </p>
            </template>

            <!-- time -->
            <template v-else-if="slide === 'time' && stats">
              <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">Time spent tinkering</p>
              <p class="mt-3 text-[68px] leading-none font-bold tracking-tight text-fg tabular">{{ formatLongDuration(stats.totalRunMs) }}</p>
              <p class="mt-4 text-[15px] text-fg">of PHP running your experiments.</p>
              <p class="mt-1.5 text-[13px] text-muted">An average run took {{ formatDuration(avgRunMs) }}.</p>
            </template>

            <!-- favourite project -->
            <template v-else-if="slide === 'project' && projects.length">
              <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">Favourite project</p>
              <p class="mt-3 max-w-full truncate text-5xl leading-tight font-bold tracking-tight text-fg">{{ projects[0].name }}</p>
              <p class="mt-3 text-[15px] text-fg">
                {{ countOf(projects[0].count, 'run') }} · {{ formatPercent(projects[0].share) }} of everything you ran
              </p>
              <p v-if="topDriver" class="mt-1 text-[13px] text-muted">Mostly powered by {{ driverName(topDriver.name) }}.</p>
              <ol v-if="projects.length > 1" class="mt-6 w-full max-w-sm space-y-1.5 text-left">
                <li
                  v-for="(p, i) in projects.slice(1)"
                  :key="p.name"
                  class="flex items-center gap-3 rounded-lg bg-surface/70 px-3 py-1.5 text-[13px] ring-1 ring-line"
                >
                  <span class="w-4 text-muted tabular">{{ i + 2 }}</span>
                  <span class="min-w-0 flex-1 truncate font-medium text-fg">{{ p.name }}</span>
                  <span class="text-muted tabular">{{ formatCount(p.count) }}</span>
                </li>
              </ol>
            </template>

            <!-- peak hour -->
            <template v-else-if="slide === 'hours' && stats">
              <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">Peak hour</p>
              <p class="mt-3 text-[64px] leading-none font-bold tracking-tight text-fg">{{ formatHour(peak) }}</p>
              <p class="mt-3 mb-7 text-[14px] text-muted">
                {{ countOf(stats.hours[peak] ?? 0, 'run') }} between {{ hourRange(peak) }} — your most productive hour.
              </p>
              <HoursChart :hours="stats.hours" />
            </template>

            <!-- exceptions -->
            <template v-else-if="slide === 'exceptions' && stats">
              <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">Exceptions caught</p>
              <p class="mt-3 text-[76px] leading-none font-bold tracking-tight text-fg tabular">{{ formatCount(exceptionCount) }}</p>
              <template v-if="topException">
                <p class="mt-4 text-[15px] text-fg">Your most loyal companion:</p>
                <p class="mt-2 rounded-lg bg-surface/75 px-3 py-1.5 font-mono text-[15px] font-semibold text-danger ring-1 ring-line">
                  {{ shortClassName(topException.name) }}
                  <span class="font-sans text-[13px] font-medium text-muted">× {{ formatCount(topException.count) }}</span>
                </p>
                <p v-if="topException.name !== shortClassName(topException.name)" class="mt-1.5 font-mono text-[11px] text-muted">
                  {{ topException.name }}
                </p>
              </template>
              <p v-else class="mt-4 text-[15px] text-fg">Not a single exception all year. Impressive.</p>
            </template>

            <!-- queries -->
            <template v-else-if="slide === 'queries' && stats">
              <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">Queries inspected</p>
              <p class="mt-3 text-[76px] leading-none font-bold tracking-tight text-fg tabular">{{ formatCount(stats.queries) }}</p>
              <p v-if="stats.queries > 0" class="mt-4 text-[15px] text-fg">
                SQL statements caught in the act — about {{ (stats.queries / stats.runs).toFixed(1) }} per run.
              </p>
              <p v-else class="mt-4 max-w-md text-[14px] text-muted">
                Turn on the SQL toggle in the title bar to see every query your code runs, with bindings and timings.
              </p>
            </template>

            <!-- magic comments -->
            <template v-else-if="slide === 'magic' && stats">
              <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">Magic comments</p>
              <p class="mt-3 text-[76px] leading-none font-bold tracking-tight text-fg tabular">{{ formatCount(stats.magicComments) }}</p>
              <p v-if="stats.magicComments > 0" class="mt-4 text-[15px] text-fg">
                values revealed right next to your code with <span class="font-mono text-code-comment">//?</span>
              </p>
              <p v-else class="mt-4 max-w-md text-[14px] text-muted">
                Add <span class="font-mono text-code-comment">//?</span> at the end of a line to see its value inline — no dump()
                needed.
              </p>
            </template>

            <!-- longest run -->
            <template v-else-if="slide === 'longest' && stats">
              <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">Longest run</p>
              <p class="mt-3 text-[72px] leading-none font-bold tracking-tight text-fg tabular">{{ formatDuration(stats.longestRunMs) }}</p>
              <p class="mt-4 text-[15px] text-fg">
                {{ stats.longestRunMs >= 10000 ? 'Hopefully it was worth the wait.' : 'Even your slowest run was quick.' }}
              </p>
            </template>

            <!-- persona -->
            <template v-else-if="slide === 'persona' && persona">
              <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">Your {{ year }} persona</p>
              <span
                class="mt-5 flex size-20 items-center justify-center rounded-3xl bg-accent text-on-accent shadow-lg shadow-accent/30"
                aria-hidden="true"
              >
                <component :is="PERSONA_ICONS[persona.persona.id]" :size="38" :stroke-width="1.75" />
              </span>
              <p class="mt-5 text-4xl leading-tight font-bold tracking-tight text-fg" data-testid="wrapped-persona">
                {{ persona.persona.name }}
              </p>
              <p class="mt-2 text-[15px] font-medium text-accent">{{ persona.persona.tagline }}</p>
              <p class="mt-3 max-w-md text-[13.5px] leading-relaxed text-muted">{{ persona.persona.description }}</p>
              <p class="mt-5 rounded-full bg-surface/75 px-3.5 py-1 text-xs font-medium text-fg ring-1 ring-line">{{ persona.evidence }}</p>
            </template>
          </div>
        </Transition>
      </div>

      <footer class="flex shrink-0 items-center gap-3 px-5 py-3.5">
        <Button variant="ghost" size="sm" :icon="ChevronLeft" :disabled="!slide || index === 0" @click="go(index - 1)">Back</Button>
        <div class="flex flex-1 items-center justify-center gap-1.5" role="tablist" aria-label="Slides">
          <button
            v-for="(s, i) in slides"
            :key="s"
            type="button"
            role="tab"
            :aria-selected="i === index"
            :aria-label="`Slide ${i + 1} of ${slides.length}`"
            :class="['h-2 rounded-full transition-all duration-200', i === index ? 'w-6 bg-accent' : 'w-2 bg-fg/20 hover:bg-fg/35']"
            @click="go(i)"
          />
        </div>
        <Button v-if="slide" variant="primary" size="sm" :icon-right="isLast ? undefined : ChevronRight" @click="next">
          {{ isLast ? 'Done' : 'Next' }}
        </Button>
        <Button v-else size="sm" @click="emit('close')">Close</Button>
      </footer>
    </div>
  </Modal>
</template>
