<script setup lang="ts">
import { computed, ref } from 'vue'
import { RotateCcw, Search, SearchX, TriangleAlert } from 'lucide-vue-next'
import { COMMAND_META } from '@shared/shortcuts'
import type { CommandId, DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/types'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { formatAccelerator } from '@/utils/accelerator'
import { platform } from '@/utils/platform'
import Button from '../../../common/Button.vue'
import EmptyState from '../../../common/EmptyState.vue'
import TextInput from '../../../common/TextInput.vue'
import Tooltip from '../../../common/Tooltip.vue'
import SettingsGroup from '../SettingsGroup.vue'
import ShortcutCapture from '../ShortcutCapture.vue'
import {
  commandsUsing,
  defaultAccelerator,
  effectiveShortcuts,
  groupShortcutRows,
  overrideValue,
  reservedShortcut,
  resetAllShortcutsPatch,
  sameAccelerator,
  shortcutRows
} from '../shortcuts'

const settings = useSettingsStore()
const ui = useUiStore()

const query = ref('')
const capturing = ref<CommandId | null>(null)

const overrides = computed(() => settings.settings.shortcuts ?? {})
const rows = computed(() => shortcutRows(platform, overrides.value))
const groups = computed(() => groupShortcutRows(rows.value, query.value, platform))
const overriddenCount = computed(() => rows.value.filter((r) => r.overridden).length)
const conflictCount = computed(() => rows.value.filter((r) => r.conflicts.length > 0).length)

function titles(ids: CommandId[]): string {
  return ids.map((id) => `“${COMMAND_META[id].title}”`).join(', ')
}

async function change(id: CommandId, accelerator: string): Promise<void> {
  const clash = accelerator ? commandsUsing(accelerator, effectiveShortcuts(platform, overrides.value), platform, id) : []
  // Editor actions on the same keys (F3 Find Next, ⌘D …) stop working in the editor; defaults are known and fine.
  const isDefault = sameAccelerator(accelerator, defaultAccelerator(id, platform), platform)
  const editorAction = accelerator && !isDefault ? reservedShortcut(accelerator, platform) : null
  await settings.setShortcut(id, overrideValue(id, accelerator, platform))
  const keys = formatAccelerator(accelerator, platform)
  if (clash.length) {
    ui.toast({
      level: 'warning',
      key: 'shortcut-conflict',
      title: `${keys} is used twice`,
      message: `${titles(clash)} uses the same keys. Change one of them so both keep working.`
    })
  } else if (editorAction && !editorAction.blocked) {
    ui.toast({
      level: 'warning',
      key: 'shortcut-conflict',
      title: `${keys} is also ${editorAction.action} in the editor`,
      message: `“${COMMAND_META[id].title}” takes these keys over, so ${editorAction.action} no longer works in the editor.`
    })
  }
}

function reset(id: CommandId): void {
  void settings.setShortcut(id, null)
}

async function resetAll(): Promise<void> {
  const ok = await ui.confirm({
    title: 'Reset all shortcuts?',
    message: 'Every shortcut goes back to its default.',
    confirmLabel: 'Reset shortcuts',
    danger: true
  })
  if (ok) await settings.update(resetAllShortcutsPatch(overrides.value) as unknown as DeepPartial<Settings>)
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <div class="flex items-center gap-2">
      <div class="min-w-0 flex-1">
        <TextInput v-model="query" :icon="Search" placeholder="Search by command or keys…" clearable data-testid="shortcut-search" />
      </div>
      <Button :icon="RotateCcw" :disabled="overriddenCount === 0" @click="resetAll">Reset all</Button>
    </div>
    <p class="-mt-2 px-1 text-xs leading-relaxed text-muted">
      Click a shortcut, then press the new keys. <span class="font-semibold text-fg">Esc</span> cancels,
      <span class="font-semibold text-fg">Backspace</span> removes the shortcut. The menu bar updates right away.
      <span v-if="conflictCount" class="text-warning">{{ conflictCount }} shortcuts share keys with another command.</span>
    </p>

    <EmptyState v-if="groups.length === 0" :icon="SearchX" title="No matching commands" compact />

    <SettingsGroup v-for="g in groups" :key="g.group" :title="g.group">
      <div v-for="row in g.rows" :key="row.id" class="flex items-center gap-3 px-4 py-2" :data-command="row.id">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 text-[13px] font-medium text-fg">
            <span class="truncate">{{ row.title }}</span>
            <Tooltip v-if="row.conflicts.length" :text="`Same keys as ${titles(row.conflicts)}`">
              <TriangleAlert :size="13" class="shrink-0 text-warning" :aria-label="`Conflicts with ${titles(row.conflicts)}`" />
            </Tooltip>
          </div>
          <p v-if="row.overridden" class="text-[11px] text-muted">
            Default: {{ row.defaultAccelerator ? formatAccelerator(row.defaultAccelerator, platform) : 'none' }}
          </p>
        </div>
        <button
          v-if="row.overridden"
          type="button"
          class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
          :aria-label="`Reset ${row.title} to its default shortcut`"
          title="Reset to default"
          @click="reset(row.id)"
        >
          <RotateCcw :size="13" />
        </button>
        <ShortcutCapture
          :label="row.title"
          :accelerator="row.accelerator"
          :capturing="capturing === row.id"
          :conflict="row.conflicts.length > 0"
          @start="capturing = row.id"
          @stop="capturing === row.id && (capturing = null)"
          @change="(accel: string) => change(row.id, accel)"
        />
      </div>
    </SettingsGroup>
  </div>
</template>
