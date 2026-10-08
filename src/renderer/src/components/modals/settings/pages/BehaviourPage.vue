<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { formatAccelerator } from '@/utils/accelerator'
import { platform } from '@/utils/platform'
import SegmentedControl from '../../../common/SegmentedControl.vue'
import Toggle from '../../../common/Toggle.vue'
import NumberField from '../NumberField.vue'
import SettingsGroup from '../SettingsGroup.vue'
import SettingsRow from '../SettingsRow.vue'
import { useSetting } from '../useSetting'

const settings = useSettingsStore()

const autoRun = useSetting('autoRun')
const autoRunDelayMs = useSetting('autoRunDelayMs')
const runSelection = useSetting('runSelection')
const strictTypes = useSetting('strictTypes')
const prettifyOnRun = useSetting('prettifyOnRun')
const prettierQuoteStyle = useSetting('prettierQuoteStyle')
const tabSize = useSetting('tabSize')

const autoRunKey = computed(() => formatAccelerator(settings.accelerator('toggleAutoRun'), platform))
const prettifyKey = computed(() => formatAccelerator(settings.accelerator('prettify'), platform))

const quoteOptions = [
  { value: 'single' as const, label: "'Single'" },
  { value: 'double' as const, label: '"Double"' }
]
</script>

<template>
  <div class="flex flex-col gap-7">
    <SettingsGroup title="Running code">
      <SettingsRow
        label="Auto evaluate"
        :description="`Run the code automatically after you stop typing.${autoRunKey ? ` ${autoRunKey} toggles it.` : ''}`"
      >
        <Toggle v-model="autoRun" />
      </SettingsRow>
      <SettingsRow label="Auto evaluate delay" description="Pause after the last keystroke before the code runs." :disabled="!autoRun">
        <NumberField v-model="autoRunDelayMs" :min="0" :max="60000" :step="100" integer suffix="ms" :disabled="!autoRun" aria-label="Auto evaluate delay" />
      </SettingsRow>
      <SettingsRow label="Evaluate selected code" description="When something is selected, Run executes only the selection.">
        <Toggle v-model="runSelection" />
      </SettingsRow>
      <SettingsRow label="Strict types" description="Run every script with declare(strict_types=1).">
        <Toggle v-model="strictTypes" />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Formatting">
      <SettingsRow
        label="Prettify on run"
        :description="`Format the code with Prettier before each run.${prettifyKey ? ` ${prettifyKey} formats it any time.` : ''}`"
      >
        <Toggle v-model="prettifyOnRun" />
      </SettingsRow>
      <SettingsRow label="Quote style" description="Quotes Prettier uses for strings.">
        <SegmentedControl v-model="prettierQuoteStyle" :options="quoteOptions" />
      </SettingsRow>
      <SettingsRow label="Tab size" description="Spaces per indentation level.">
        <NumberField v-model="tabSize" :min="1" :max="16" integer aria-label="Tab size" />
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>
