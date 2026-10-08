<script setup lang="ts">
/**
 * CLI mode: the run rendered as PsySH-style text in a read-only Monaco editor (line numbers, theme colors,
 * Cmd/Ctrl-click links to files, editor lines and URLs). Streaming text is appended without losing the scroll
 * position; the view follows the end while it is scrolled to the bottom.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { CLI_LANGUAGE, ensureCliSupport, monaco, setCliLinkContext } from './cliMonaco'

const props = withDefaults(defineProps<{ tabId: string; connectionId?: string | null; text: string; placeholder?: string }>(), {
  connectionId: null,
  placeholder: ''
})

const settings = useSettingsStore()
const host = ref<HTMLElement | null>(null)
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null)
let model: monaco.editor.ITextModel | null = null

const options = computed<monaco.editor.IStandaloneEditorConstructionOptions>(() => {
  const s = settings.settings
  return {
    fontFamily: s.editorFontFamily,
    fontSize: s.outputFontSize,
    lineHeight: Math.round(s.outputFontSize * Math.max(1.2, s.lineHeight)),
    fontLigatures: s.fontLigatures,
    wordWrap: s.wordWrap ? 'on' : 'off'
  }
})

function atBottom(): boolean {
  const e = editor.value
  if (!e) return true
  return e.getScrollTop() + e.getLayoutInfo().height >= e.getScrollHeight() - 8
}

function setText(text: string): void {
  const e = editor.value
  if (!model || !e) return
  const current = model.getValue()
  if (current === text) return
  const follow = atBottom()
  if (current !== '' && text.startsWith(current)) {
    // Streaming: append, keep the view where it is.
    const end = model.getFullModelRange().getEndPosition()
    model.applyEdits([{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: text.slice(current.length) }])
  } else {
    model.setValue(text)
  }
  if (follow && current !== '') e.revealLine(model.getLineCount())
}

onMounted(() => {
  if (!host.value) return
  ensureCliSupport()
  setCliLinkContext(props.tabId, props.connectionId)
  model = monaco.editor.createModel(props.text, CLI_LANGUAGE)
  editor.value = monaco.editor.create(host.value, {
    model,
    ...options.value,
    readOnly: true,
    domReadOnly: true,
    readOnlyMessage: { value: 'The output is read-only.' },
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers: 'on',
    lineNumbersMinChars: 3,
    lineDecorationsWidth: 10,
    glyphMargin: false,
    folding: false,
    renderLineHighlight: 'none',
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    renderWhitespace: 'none',
    guides: { indentation: false },
    stickyScroll: { enabled: false },
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
    links: true,
    contextmenu: true,
    matchBrackets: 'never',
    quickSuggestions: false,
    hover: { enabled: 'on', delay: 500 },
    padding: { top: 10, bottom: 10 },
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    fixedOverflowWidgets: true,
    useShadowDOM: false // see monaco/options.ts: themed context menu
  })
})

watch(
  () => props.text,
  (text) => setText(text)
)
watch(options, (value) => editor.value?.updateOptions(value))
watch(
  () => [props.tabId, props.connectionId] as const,
  ([tabId, connectionId]) => setCliLinkContext(tabId, connectionId)
)

onBeforeUnmount(() => {
  editor.value?.dispose()
  model?.dispose()
  editor.value = null
  model = null
})
</script>

<template>
  <div class="relative h-full min-h-0 bg-editor" data-testid="cli-output">
    <div ref="host" class="absolute inset-0" />
    <div
      v-if="!text && placeholder"
      class="pointer-events-none absolute inset-x-0 top-0 px-12 py-3 font-mono text-[13px] text-muted italic select-none"
      :style="{ fontSize: `${settings.settings.outputFontSize}px` }"
    >
      {{ placeholder }}
    </div>
  </div>
</template>
