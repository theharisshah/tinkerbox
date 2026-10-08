<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { Check, ClipboardCopy, Copy, ExternalLink, LayoutPanelTop, RotateCw } from 'lucide-vue-next'
import type { AppPanel } from '@shared/types'
import { api } from '../../../api'
import { useConnectionsStore } from '../../../stores/connections'
import { useEnvironmentStore } from '../../../stores/environment'
import { useTabsStore } from '../../../stores/tabs'
import { useUiStore } from '../../../stores/ui'
import Badge from '../../common/Badge.vue'
import Button from '../../common/Button.vue'
import EmptyState from '../../common/EmptyState.vue'
import Modal from '../../common/Modal.vue'
import Spinner from '../../common/Spinner.vue'
import { classifyValue, displayValue, normalizePanels, panelToText } from './panelUtils'

/**
 * App information panels (click the framework label in the footer): the driver's appPanels() — for Laravel the
 * output of `artisan about --json` — as tabs of titled key/value sections.
 */
const props = defineProps<{ connectionId: string | null }>()
const emit = defineEmits<{ close: [result?: unknown] }>()

const connections = useConnectionsStore()
const environment = useEnvironmentStore()
const tabs = useTabsStore()
const ui = useUiStore()

const panels = shallowRef<AppPanel[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const active = ref(0)
const copiedKey = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const projectName = computed(() => connections.label(props.connectionId))
const projectColor = computed(() => connections.color(props.connectionId))
const appVersion = computed(() => {
  const tab = tabs.activeTab
  const fromResult = tab && tab.kind === 'code' && tab.connectionId === props.connectionId ? tabs.resultOf(tab.id)?.driver : null
  const driver = fromResult ?? environment.get(props.connectionId)?.driver ?? null
  if (!driver || driver.id === 'none') return connections.path(props.connectionId) ? '' : 'Plain PHP'
  return driver.appVersion || driver.name
})
const current = computed<AppPanel | null>(() => panels.value[active.value] ?? panels.value[0] ?? null)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    panels.value = normalizePanels(await api.invoke('project:panels', props.connectionId))
    if (active.value >= panels.value.length) active.value = 0
  } catch (err) {
    error.value = api.errorText(err)
  } finally {
    loading.value = false
  }
}

async function copy(text: string, key: string, label = 'Value'): Promise<void> {
  try {
    await api.copy(text)
    copiedKey.value = key
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copiedKey.value = null), 1400)
    if (key === '@panel') ui.toast({ level: 'success', message: `${label} copied to the clipboard.`, key: 'panels-copy', timeout: 2500 })
  } catch (err) {
    ui.error(err, 'Could not copy')
  }
}

function openUrl(url: string): void {
  void api.invoke('shell:openExternal', url).catch((err: unknown) => ui.error(err, 'Could not open the link'))
}

function onTabKeydown(event: KeyboardEvent): void {
  if (panels.value.length < 2) return
  if (event.key === 'ArrowRight') active.value = (active.value + 1) % panels.value.length
  else if (event.key === 'ArrowLeft') active.value = (active.value - 1 + panels.value.length) % panels.value.length
  else return
  event.preventDefault()
}

onMounted(() => {
  void load()
  // Footer label / version: make sure the environment (driver info) of this project is known.
  if (!environment.get(props.connectionId) && environment.statusOf(props.connectionId) === 'idle') {
    void environment.load(props.connectionId)
  }
})
</script>

<template>
  <Modal size="lg" height="min(640px, calc(100vh - 48px))" :padded="false" :aria-label="`App information — ${projectName}`" @close="emit('close')">
    <template #title>
      <span class="flex min-w-0 items-center gap-2">
        <span v-if="projectColor" class="size-2.5 shrink-0 rounded-full" :style="{ backgroundColor: projectColor }" />
        <span class="truncate">{{ projectName }}</span>
      </span>
    </template>
    <template #actions>
      <span v-if="appVersion" class="max-w-[260px] truncate font-mono text-xs font-medium text-muted" data-testid="panels-version">
        {{ appVersion }}
      </span>
    </template>

    <div class="flex h-full min-h-0 flex-col">
      <div v-if="loading && panels.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2 text-[13px] text-muted">
        <Spinner :size="18" />
        Loading app information…
      </div>
      <EmptyState v-else-if="error" class="flex-1" :icon="LayoutPanelTop" title="Could not load the app information" :description="error">
        <template #actions><Button :icon="RotateCw" @click="load">Try again</Button></template>
      </EmptyState>
      <EmptyState
        v-else-if="panels.length === 0"
        class="flex-1"
        :icon="LayoutPanelTop"
        title="No panels"
        description="The project's driver did not provide any information panels."
      />

      <template v-else>
        <div
          class="flex shrink-0 flex-wrap items-center gap-1 px-5 pt-3 pb-2"
          role="tablist"
          aria-label="Panels"
          @keydown="onTabKeydown"
        >
          <button
            v-for="(panel, i) in panels"
            :key="`${i}-${panel.title}`"
            type="button"
            role="tab"
            :aria-selected="i === active"
            :tabindex="i === active ? 0 : -1"
            :class="[
              'h-7 rounded-full px-3.5 text-xs font-semibold transition-colors',
              i === active ? 'bg-accent text-on-accent shadow-sm shadow-accent/20' : 'bg-fg/6 text-muted hover:bg-hover hover:text-fg'
            ]"
            @click="active = i"
          >
            {{ panel.title }}
          </button>
          <div class="flex-1" />
          <Spinner v-if="loading" :size="13" class="text-muted" />
        </div>

        <div v-if="current" class="min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-5" role="tabpanel" :aria-label="current.title">
          <section v-for="(section, si) in current.sections" :key="si" class="mt-4 first:mt-1">
            <h3 v-if="section.title" class="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{{ section.title }}</h3>
            <dl class="overflow-hidden rounded-xl border border-line">
              <div
                v-for="(row, ri) in section.rows"
                :key="ri"
                class="group grid grid-cols-[minmax(140px,38%)_1fr] items-center gap-3 border-t border-line/70 px-3.5 py-2 first:border-t-0 odd:bg-app-alt/40"
              >
                <dt class="truncate text-[12.5px] text-muted" :title="row.key">{{ row.key }}</dt>
                <dd class="flex min-w-0 items-center gap-2">
                  <span class="min-w-0 flex-1">
                    <Badge v-if="classifyValue(row.value) === 'on'" variant="success" size="xs" dot>{{ displayValue(row.value, section.title) }}</Badge>
                    <Badge v-else-if="classifyValue(row.value) === 'off'" variant="neutral" size="xs" dot>{{ displayValue(row.value, section.title) }}</Badge>
                    <span v-else-if="classifyValue(row.value) === 'empty'" class="text-[12.5px] text-muted">—</span>
                    <button
                      v-else-if="classifyValue(row.value) === 'url'"
                      type="button"
                      class="inline-flex max-w-full items-center gap-1 truncate text-[12.5px] text-accent hover:underline"
                      :title="`Open ${row.value}`"
                      @click="openUrl(row.value)"
                    >
                      <span class="truncate">{{ row.value }}</span>
                      <ExternalLink :size="11" class="shrink-0" />
                    </button>
                    <span
                      v-else
                      :class="[
                        'selectable block text-[12.5px] break-words text-fg',
                        classifyValue(row.value) === 'path' || classifyValue(row.value) === 'number' ? 'font-mono text-[12px]' : ''
                      ]"
                    >
                      {{ row.value }}
                    </span>
                  </span>
                  <button
                    type="button"
                    :aria-label="`Copy ${row.key}`"
                    :title="`Copy ${row.key}`"
                    :class="[
                      'flex size-6 shrink-0 items-center justify-center rounded-md transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100',
                      copiedKey === `${si}:${ri}` ? 'text-success opacity-100' : 'text-muted opacity-0 group-hover:opacity-100'
                    ]"
                    @click="copy(row.value, `${si}:${ri}`)"
                  >
                    <Check v-if="copiedKey === `${si}:${ri}`" :size="13" />
                    <Copy v-else :size="13" />
                  </button>
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </template>
    </div>

    <template #footer>
      <Button v-if="current" size="sm" variant="ghost" :icon="ClipboardCopy" @click="copy(panelToText(current), '@panel', current.title)">
        Copy {{ current.title }}
      </Button>
      <Button size="sm" variant="ghost" :icon="RotateCw" :disabled="loading" @click="load">Reload</Button>
      <div class="flex-1" />
      <Button size="sm" @click="emit('close')">Close</Button>
    </template>
  </Modal>
</template>
