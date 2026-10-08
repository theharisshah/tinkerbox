<script setup lang="ts">
import { computed } from 'vue'
import { ListTree, SquareTerminal } from 'lucide-vue-next'
import SegmentedControl from '../../../common/SegmentedControl.vue'
import Toggle from '../../../common/Toggle.vue'
import NumberField from '../NumberField.vue'
import SettingsGroup from '../SettingsGroup.vue'
import SettingsRow from '../SettingsRow.vue'
import { useSetting } from '../useSetting'

const defaultOutputMode = useSetting('defaultOutputMode')
const outputType = useSetting('outputType')
const showQueriesByDefault = useSetting('showQueriesByDefault')
const magicComments = useSetting('magicComments')
const coverage = useSetting('coverage')
const inlineErrors = useSetting('inlineErrors')
const collapseNested = useSetting('collapseNested')
const maxDepth = useSetting('maxDepth')
const maxItems = useSetting('maxItems')
const maxStringLength = useSetting('maxStringLength')
const timeoutMs = useSetting('timeoutMs')

/** The timeout is stored in milliseconds and edited in seconds. */
const timeoutSeconds = computed({
  get: () => Math.round(timeoutMs.value / 1000),
  set: (s: number) => (timeoutMs.value = Math.round(s * 1000))
})

const modeOptions = [
  { value: 'detail' as const, label: 'Cards', icon: ListTree },
  { value: 'cli' as const, label: 'CLI', icon: SquareTerminal }
]

const typeOptions = [
  { value: 'buffered' as const, label: 'Buffered' },
  { value: 'realtime' as const, label: 'Real-time' }
]
</script>

<template>
  <div class="flex flex-col gap-7">
    <SettingsGroup title="Output">
      <SettingsRow label="Default output mode" description="Cards shows one card per dump, echo and query; CLI prints plain text like tinker. New tabs start in this mode.">
        <SegmentedControl v-model="defaultOutputMode" :options="modeOptions" />
      </SettingsRow>
      <SettingsRow
        label="Output type"
        description="Buffered collects echo output into cards when the script ends; real-time streams it while the script runs (handy for long loops)."
      >
        <SegmentedControl v-model="outputType" :options="typeOptions" />
      </SettingsRow>
      <SettingsRow label="Show SQL queries by default" description="New tabs start with query inspection switched on.">
        <Toggle v-model="showQueriesByDefault" />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="In the editor">
      <SettingsRow label="Magic comments" description="Show values of lines ending in //? right next to the code.">
        <Toggle v-model="magicComments" />
      </SettingsRow>
      <SettingsRow label="Code coverage" description="Mark the lines that ran in the gutter.">
        <Toggle v-model="coverage" />
      </SettingsRow>
      <SettingsRow label="Inline errors" description="Show an exception next to the line that threw it.">
        <Toggle v-model="inlineErrors" />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Dumped values">
      <SettingsRow label="Collapse nested values" description="Open only the first level of arrays and objects in the output cards.">
        <Toggle v-model="collapseNested" />
      </SettingsRow>
      <SettingsRow label="Maximum depth" description="Nesting levels dumped before values are cut off.">
        <NumberField v-model="maxDepth" :min="1" :max="64" integer aria-label="Maximum depth" />
      </SettingsRow>
      <SettingsRow label="Maximum items" description="Array elements and object properties per level.">
        <NumberField v-model="maxItems" :min="1" :max="100000" integer aria-label="Maximum items" />
      </SettingsRow>
      <SettingsRow label="Maximum string length" description="Longer strings are truncated in the output.">
        <NumberField v-model="maxStringLength" :min="16" :max="10000000" integer suffix="chars" width="100px" aria-label="Maximum string length" />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Limits">
      <SettingsRow label="Timeout" description="Scripts running longer than this are stopped.">
        <NumberField v-model="timeoutSeconds" :min="1" :max="86400" integer suffix="s" aria-label="Timeout in seconds" />
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>
