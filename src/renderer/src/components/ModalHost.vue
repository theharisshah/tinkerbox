<script setup lang="ts">
import { defineAsyncComponent, type Component } from 'vue'
import { useUiStore, type ModalName } from '../stores/ui'

/**
 * Renders the ui store's modal stack. Each modal component receives its entry's props (spread with v-bind) and
 * emits `close` (optionally with a result, handed back to the `ui.openModal()` promise).
 */
const ui = useUiStore()

const MODALS: Record<ModalName, Component> = {
  settings: defineAsyncComponent(() => import('./modals/settings/SettingsModal.vue')),
  palette: defineAsyncComponent(() => import('./modals/palette/CommandPalette.vue')),
  history: defineAsyncComponent(() => import('./modals/history/HistoryModal.vue')),
  snippets: defineAsyncComponent(() => import('./modals/snippets/SnippetsModal.vue')),
  snippetSave: defineAsyncComponent(() => import('./modals/snippets/SnippetSaveModal.vue')),
  themes: defineAsyncComponent(() => import('./modals/themes/ThemesModal.vue')),
  logs: defineAsyncComponent(() => import('./modals/logs/LogsModal.vue')),
  panels: defineAsyncComponent(() => import('./modals/panels/PanelsModal.vue')),
  php: defineAsyncComponent(() => import('./modals/php/PhpSettingsModal.vue')),
  wrapped: defineAsyncComponent(() => import('./modals/wrapped/WrappedModal.vue')),
  share: defineAsyncComponent(() => import('./modals/share/ShareGistModal.vue')),
  tablePreview: defineAsyncComponent(() => import('./output/TablePreviewModal.vue')),
  objectGraph: defineAsyncComponent(() => import('./output/ObjectGraphModal.vue')),
  htmlPreview: defineAsyncComponent(() => import('./output/HtmlPreviewModal.vue')),
  confirm: defineAsyncComponent(() => import('./common/ConfirmModal.vue'))
}
</script>

<template>
  <component
    :is="MODALS[entry.name]"
    v-for="entry in ui.modals"
    :key="entry.id"
    v-bind="entry.props"
    @close="(result?: unknown) => ui.closeModal(entry.id, result)"
  />
</template>
