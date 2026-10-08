<script setup lang="ts">
/**
 * HTML Preview for Views, Mailables, MailMessages and Htmlables: the rendered HTML in a sandboxed iframe (no
 * scripts). Running the code again while the preview is open (Run shortcut or the button) refreshes it with the
 * matching HTML of the new run. Links open in the default browser.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Code, Copy, Monitor, RotateCw, Smartphone } from 'lucide-vue-next'
import type { RunResult } from '@shared/types'
import { api } from '../../api'
import { handleKeydown } from '../../commands'
import { useSettingsStore } from '../../stores/settings'
import { useTabsStore } from '../../stores/tabs'
import { formatTime } from '../../utils/format'
import IconButton from '../common/IconButton.vue'
import Kbd from '../common/Kbd.vue'
import Modal from '../common/Modal.vue'
import SegmentedControl from '../common/SegmentedControl.vue'
import Spinner from '../common/Spinner.vue'
import { copyText } from './actions'
import { collectHtml, htmlTitle, type HtmlNode } from './lib/dump'
import { previewLinkAction } from './lib/previewLinks'

const props = defineProps<{ html: string; title?: string; tabId?: string }>()
defineEmits<{ close: [result?: unknown] }>()

const tabs = useTabsStore()
const settings = useSettingsStore()

const html = ref(props.html)
const heading = ref(props.title ?? '')
const refreshedAt = ref<number | null>(null)
const notice = ref('')
const width = ref<'desktop' | 'mobile'>('desktop')
const showSource = ref(false)
const frame = ref<HTMLIFrameElement | null>(null)

const running = computed(() => (props.tabId ? tabs.isRunning(props.tabId) : false))
const runAccelerator = computed(() => settings.accelerator('run'))

/** Every HTML-carrying node of a run, in output order (dump events, then the return value). */
function htmlNodes(result: RunResult | null): HtmlNode[] {
  if (!result) return []
  const out: HtmlNode[] = []
  for (const event of result.events ?? []) if (event.kind === 'dump') collectHtml(event.value, out)
  if (result.hasReturnValue) collectHtml(result.returnValue, out)
  return out
}

/** Which of the run's HTML nodes is previewed (so a re-run can pick the same one). */
const initial = htmlNodes(props.tabId ? tabs.resultOf(props.tabId) : null)
let position = Math.max(0, initial.findIndex((n) => n.html === props.html))
let lastRunId = props.tabId ? (tabs.resultOf(props.tabId)?.runId ?? null) : null

watch(
  () => (props.tabId ? tabs.resultOf(props.tabId) : null),
  (result) => {
    if (!result || result.runId === lastRunId) return
    lastRunId = result.runId
    const nodes = htmlNodes(result)
    const node = nodes[position] ?? nodes[0]
    if (!node) {
      notice.value = result.exception
        ? `The last run threw ${result.exception.class} — showing the previous HTML.`
        : 'The last run produced no HTML — showing the previous version.'
      return
    }
    position = nodes.indexOf(node)
    notice.value = ''
    html.value = node.html
    heading.value = htmlTitle(node)
    refreshedAt.value = Date.now()
  }
)

/** Base target + light canvas so links leave the frame and unstyled mails stay readable. */
const srcdoc = computed(() => {
  const head = '<base target="_blank"><style>:root{color-scheme:light}html{background:#fff}</style>'
  const source = html.value
  if (/<head[\s>]/i.test(source)) return source.replace(/<head(\s[^>]*)?>/i, (m) => m + head)
  if (/<html[\s>]/i.test(source)) return source.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${head}</head>`)
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${source}</body></html>`
})

function rerun(): void {
  if (props.tabId) void tabs.run({ tabId: props.tabId })
}

function openLink(url: string): void {
  void api.invoke('shell:openExternal', url).catch((err) => console.error('openExternal failed', err))
}

let detach: (() => void) | null = null

/** Follow an in-page `#fragment` link: the element with that id (or `<a name>`), `#` / `#top` → the top. */
function scrollToFragment(doc: Document, id: string): void {
  const target = (id !== '' && (doc.getElementById(id) ?? doc.getElementsByName(id)[0])) || null
  if (target) target.scrollIntoView()
  else if (id === '' || id.toLowerCase() === 'top') doc.defaultView?.scrollTo(0, 0)
}

/** Intercept link clicks and forward shortcuts (⌘R, ESC…) from inside the frame. */
function onFrameLoad(): void {
  detach?.()
  detach = null
  let doc: Document | null = null
  try {
    doc = frame.value?.contentDocument ?? null
  } catch {
    doc = null
  }
  if (!doc) return
  const onClick = (event: MouseEvent): void => {
    const target = event.target as Element | null
    const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null
    if (!anchor) return
    event.preventDefault()
    const action = previewLinkAction(anchor.getAttribute('href') ?? '', (anchor as HTMLAnchorElement).href, window.location.origin)
    if (action.kind === 'fragment' && doc) scrollToFragment(doc, action.id)
    else if (action.kind === 'open') openLink(action.url)
  }
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      return
    }
    handleKeydown(event)
  }
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('keydown', onKeydown)
  const current = doc
  detach = () => {
    current.removeEventListener('click', onClick, true)
    current.removeEventListener('keydown', onKeydown)
  }
}

onBeforeUnmount(() => detach?.())

const widthOptions = [
  { value: 'desktop' as const, icon: Monitor, title: 'Desktop width' },
  { value: 'mobile' as const, icon: Smartphone, title: 'Phone width (375 px)' }
]
</script>

<template>
  <Modal
    size="xl"
    height="84vh"
    :padded="false"
    body-class="flex flex-col"
    aria-label="HTML Preview"
    initial-focus="[data-html-preview]"
    @close="$emit('close')"
  >
    <template #title>
      <span class="flex items-center gap-2">
        HTML Preview
        <span v-if="heading" class="truncate font-sans text-[12.5px] font-normal text-muted">{{ heading }}</span>
      </span>
    </template>
    <template #actions>
      <SegmentedControl v-model="width" :options="widthOptions" size="sm" />
      <IconButton :icon="Code" label="Show HTML source" size="sm" :active="showSource" @click="showSource = !showSource" />
      <IconButton :icon="Copy" label="Copy HTML" size="sm" @click="copyText(html, 'HTML copied to the clipboard.')" />
      <IconButton v-if="tabId" :icon="RotateCw" label="Run again" command="run" size="sm" :disabled="running" @click="rerun" />
    </template>

    <div data-html-preview tabindex="-1" class="relative flex min-h-0 flex-1 justify-center overflow-auto border-t border-line bg-app-alt outline-none">
      <pre v-if="showSource" class="selectable h-full w-full overflow-auto p-4 font-mono text-[12px] whitespace-pre-wrap break-all text-fg">{{ html }}</pre>
      <iframe
        v-else
        ref="frame"
        :srcdoc="srcdoc"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        title="HTML preview"
        :class="['h-full border-0 transition-[width] duration-200', width === 'mobile' ? 'my-3 w-[375px] rounded-xl shadow-lg ring-1 ring-line' : 'w-full']"
        @load="onFrameLoad"
      />
      <div
        v-if="running"
        class="absolute top-3 right-3 flex items-center gap-2 rounded-lg bg-surface/95 px-2.5 py-1.5 font-sans text-[12px] text-muted shadow-sm ring-1 ring-line"
      >
        <Spinner :size="12" /> Running…
      </div>
    </div>

    <template #footer>
      <div class="flex min-w-0 flex-1 items-center gap-2 font-sans text-[12px] text-muted">
        <template v-if="notice">
          <span class="truncate text-warning">{{ notice }}</span>
        </template>
        <template v-else>
          <span class="truncate">
            <template v-if="runAccelerator">Press <Kbd :accelerator="runAccelerator" size="xs" /> to run your code again — </template>
            <template v-else>Run your code again — </template>
            this preview refreshes with the new HTML.
          </span>
        </template>
        <span class="flex-1" />
        <span v-if="refreshedAt" class="shrink-0 tabular">Refreshed {{ formatTime(refreshedAt) }}</span>
      </div>
    </template>
  </Modal>
</template>
