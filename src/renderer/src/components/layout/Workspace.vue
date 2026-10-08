<script setup lang="ts">
import { ref, watch } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import SplitView from '../common/SplitView.vue'
import EditorPane from '../editor/EditorPane.vue'
import OutputPane from '../output/OutputPane.vue'

/**
 * Editor + output split for the active code tab. `settings.layout` 'vertical' puts the output on the right,
 * 'horizontal' below. The ratio updates live while dragging and is persisted (settings.splitRatio) on release.
 * EditorPane / OutputPane stay mounted across tab switches and receive the active `tabId`.
 */
defineProps<{ tabId: string }>()

const settings = useSettingsStore()
const ui = useUiStore()
const ratio = ref(settings.settings.splitRatio)

watch(
  () => settings.settings.splitRatio,
  (value) => (ratio.value = value)
)

function commit(value: number): void {
  if (Math.abs(value - settings.settings.splitRatio) > 0.0005) void settings.set('splitRatio', Number(value.toFixed(4)))
}
</script>

<template>
  <SplitView
    v-model:ratio="ratio"
    :layout="settings.settings.layout"
    :show-second="ui.showOutput"
    :min-first="220"
    :min-second="180"
    :default-ratio="0.55"
    @commit="commit"
  >
    <template #first>
      <EditorPane :tab-id="tabId" />
    </template>
    <template #second>
      <OutputPane :tab-id="tabId" />
    </template>
  </SplitView>
</template>
