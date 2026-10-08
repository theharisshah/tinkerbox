<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { FolderSearch } from 'lucide-vue-next'
import { api } from '@/api'
import { useAppStore } from '@/stores/app'
import { useUiStore } from '@/stores/ui'
import { fileManagerName, tildify } from '@/utils/platform'
import logo from '../../../../assets/logo.svg'
import SettingsGroup from '../SettingsGroup.vue'
import SettingsRow from '../SettingsRow.vue'

const app = useAppStore()
const ui = useUiStore()

const info = computed(() => app.info)
const reveal = `Reveal in ${fileManagerName()}`

const versions = computed(() => {
  const i = info.value
  if (!i) return []
  return [
    { label: 'Electron', value: i.electronVersion },
    { label: 'Chromium', value: i.chromeVersion },
    { label: 'Node.js', value: i.nodeVersion },
    { label: 'Platform', value: `${i.platform} (${i.arch})` }
  ]
})

const paths = computed(() => {
  const i = info.value
  if (!i) return []
  return [
    { label: 'App data', description: 'Settings, snippets, history and sessions.', path: i.userDataPath },
    { label: 'Custom themes', description: 'Monaco theme JSON files.', path: i.themesPath },
    { label: 'Custom drivers', description: 'Global framework drivers: PHP classes extending Tinkerbox\\Drivers\\Driver.', path: i.driversPath }
  ]
})

async function revealPath(path: string): Promise<void> {
  try {
    await api.invoke('shell:revealInFinder', path)
  } catch (err) {
    ui.error(err, 'Could not reveal the folder')
  }
}

onMounted(() => {
  if (!app.info) void app.loadInfo()
})
</script>

<template>
  <div class="flex flex-col gap-7">
    <div class="flex items-center gap-4 px-1">
      <img :src="logo" alt="" class="size-14 drop-shadow-sm" draggable="false" />
      <div>
        <p class="text-[20px] font-bold tracking-tight text-fg">{{ info?.name ?? 'Tinkerbox' }}</p>
        <p class="text-[13px] text-muted" data-testid="about-version">
          Version {{ info?.version ?? '…' }}<template v-if="info && !info.isPackaged"> · development build</template>
        </p>
        <p class="mt-0.5 text-xs text-muted">A desktop playground for PHP and Laravel. Released under the MIT license.</p>
      </div>
    </div>

    <SettingsGroup title="Versions">
      <SettingsRow v-for="v in versions" :key="v.label" :label="v.label">
        <span class="selectable block max-w-[340px] truncate font-mono text-xs text-muted tabular" :title="v.value">{{ v.value }}</span>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Folders">
      <SettingsRow v-for="p in paths" :key="p.label" :label="p.label" :description="p.description" stacked>
        <div class="flex items-center gap-2">
          <code class="selectable min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1 font-mono text-[11.5px] text-muted" :title="p.path">
            {{ tildify(p.path, app.homeDir) }}
          </code>
          <button
            type="button"
            class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-accent hover:bg-accent-soft"
            :aria-label="`${reveal}: ${p.label}`"
            @click="revealPath(p.path)"
          >
            <FolderSearch :size="13" /> {{ reveal }}
          </button>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="License">
      <SettingsRow label="MIT License" description="Free to use, copy, modify and distribute, provided the copyright notice is kept. The software comes without warranty." />
    </SettingsGroup>
  </div>
</template>
