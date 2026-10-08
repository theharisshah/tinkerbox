<script setup lang="ts">
/**
 * Monaco code editor of the workspace (mounted once, receives the active tab). Monaco is loaded on demand so the
 * window paints before the editor bundle is parsed; everything editor-specific lives in `src/renderer/src/monaco`.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { EditorSession } from '../../monaco/session'
import { useTabsStore } from '../../stores/tabs'
import { useUiStore } from '../../stores/ui'

const props = defineProps<{ tabId: string }>()

const tabs = useTabsStore()
const host = ref<HTMLDivElement | null>(null)
const session = shallowRef<EditorSession | null>(null)
const loadError = ref<string | null>(null)
let unmounted = false

const fallbackCode = computed({
  get: () => tabs.byId(props.tabId)?.code ?? '',
  set: (code: string) => tabs.setCode(props.tabId, code)
})

onMounted(async () => {
  try {
    const { EditorSession } = await import('../../monaco/session')
    if (unmounted || !host.value) return
    const editor = new EditorSession(host.value)
    session.value = editor
    editor.show(props.tabId)
    // Autofocus (launch, tab switches back from "Get started") unless a dialog has the focus.
    if (!useUiStore().anyModalOpen) editor.focus()
  } catch (err) {
    console.error('The code editor failed to load', err)
    loadError.value = err instanceof Error ? err.message : String(err)
  }
})

watch(
  () => props.tabId,
  (tabId) => session.value?.show(tabId)
)

onBeforeUnmount(() => {
  unmounted = true
  session.value?.dispose()
  session.value = null
})
</script>

<template>
  <div data-editor class="relative h-full min-h-0 w-full overflow-hidden bg-editor" data-testid="editor-pane">
    <div ref="host" class="absolute inset-0" />
    <div v-if="loadError" class="absolute inset-0 flex flex-col bg-editor">
      <p class="border-b border-line px-4 py-2 text-xs text-danger">The code editor could not be loaded ({{ loadError }}). Using a plain text editor.</p>
      <textarea
        v-model="fallbackCode"
        class="selectable w-full flex-1 resize-none bg-transparent px-6 py-4 font-mono text-sm text-fg outline-none"
        spellcheck="false"
        aria-label="Code editor"
      />
    </div>
  </div>
</template>
