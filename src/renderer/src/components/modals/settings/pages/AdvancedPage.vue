<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CircleCheck, CircleX, ExternalLink, FolderX, KeyRound, RotateCcw, SquareTerminal, Trash2 } from 'lucide-vue-next'
import { SECRET_MASK } from '@shared/types'
import { api } from '@/api'
import { useConnectionsStore } from '@/stores/connections'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { pluralize } from '@/utils/format'
import Button from '../../../common/Button.vue'
import TextInput from '../../../common/TextInput.vue'
import Toggle from '../../../common/Toggle.vue'
import NumberField from '../NumberField.vue'
import SettingsGroup from '../SettingsGroup.vue'
import SettingsRow from '../SettingsRow.vue'
import { useSetting } from '../useSetting'

const settings = useSettingsStore()
const connections = useConnectionsStore()
const ui = useUiStore()

const vimMode = useSetting('vimMode')
const historyLimit = useSetting('historyLimit')
const collision = useSetting('collision')

// -- Recents -------------------------------------------------------------------------------------------------

const clearing = ref(false)

async function clearRecents(): Promise<void> {
  const count = connections.recent.length
  const ok = await ui.confirm({
    title: 'Clear recent folders?',
    message: `${pluralize(count, 'folder')} will be removed from the recent list. The folders themselves are not touched.`,
    confirmLabel: 'Clear folders',
    danger: true
  })
  if (!ok) return
  clearing.value = true
  try {
    await connections.clearRecents()
    ui.toast({ level: 'success', key: 'recents', timeout: 3000, message: 'Recent folders cleared.' })
  } finally {
    clearing.value = false
  }
}

// -- CLI helper ----------------------------------------------------------------------------------------------

const installing = ref(false)
const cliResult = ref<{ installed: boolean; path: string; message: string } | null>(null)

async function installCli(): Promise<void> {
  installing.value = true
  try {
    cliResult.value = await api.invoke('cli:install')
  } catch (err) {
    cliResult.value = { installed: false, path: '', message: api.errorText(err) }
  } finally {
    installing.value = false
  }
}

// -- GitHub token --------------------------------------------------------------------------------------------

const tokenSet = computed(() => settings.settings.github.token !== '')
const tokenDraft = ref(settings.settings.github.token)
const savingToken = ref(false)

watch(
  () => settings.settings.github.token,
  (value) => {
    tokenDraft.value = value
  }
)

async function saveToken(value: string = tokenDraft.value): Promise<void> {
  const next = value.trim()
  if (next === settings.settings.github.token || (next === SECRET_MASK && tokenSet.value)) return
  savingToken.value = true
  try {
    await settings.update({ github: { token: next } })
    if (next) ui.toast({ level: 'success', key: 'github-token', timeout: 3000, message: 'GitHub token saved (encrypted on this computer).' })
  } finally {
    savingToken.value = false
  }
}

function removeToken(): void {
  tokenDraft.value = ''
  void saveToken('')
}

function onTokenFocus(event: FocusEvent): void {
  // Select the mask so typing replaces it.
  if (tokenDraft.value === SECRET_MASK) (event.target as HTMLInputElement | null)?.select?.()
}

function openTokenPage(): void {
  void api
    .invoke('shell:openExternal', 'https://github.com/settings/tokens/new?scopes=gist&description=Tinkerbox')
    .catch((err: unknown) => ui.error(err, 'Could not open the link'))
}

// -- Reset ---------------------------------------------------------------------------------------------------

async function resetAll(): Promise<void> {
  const ok = await ui.confirm({
    title: 'Reset all settings?',
    message: 'Every setting — including shortcuts, themes and the GitHub token — goes back to its default. Your snippets, history and recent folders stay.',
    confirmLabel: 'Reset settings',
    danger: true
  })
  if (!ok) return
  await settings.reset()
  ui.toast({ level: 'success', key: 'settings-reset', timeout: 3000, message: 'Settings were reset to their defaults.' })
}
</script>

<template>
  <div class="flex flex-col gap-7">
    <SettingsGroup title="Editor & runner">
      <SettingsRow label="Vim keymap" description="Vim key bindings in the editor; the mode shows in the status bar.">
        <Toggle v-model="vimMode" />
      </SettingsRow>
      <SettingsRow label="History entries" description="How many runs the history keeps (0 turns the history off).">
        <NumberField v-model="historyLimit" :min="0" :max="10000" integer aria-label="History entries" />
      </SettingsRow>
      <SettingsRow label="Collision error pages" description="Show exceptions with the failing code and a readable stack trace. Drivers can opt out.">
        <Toggle v-model="collision" />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Recents">
      <SettingsRow label="Recent folders" :description="connections.recent.length ? `${pluralize(connections.recent.length, 'folder')} in the list.` : 'The list is empty.'">
        <Button :icon="FolderX" :loading="clearing" :disabled="connections.recent.length === 0" data-testid="clear-recents" @click="clearRecents">
          Clear folders
        </Button>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Command line">
      <SettingsRow label="tinkerbox command" description="Open folders from a terminal with “tinkerbox .” or “tinkerbox path/to/project”.">
        <Button :icon="SquareTerminal" :loading="installing" data-testid="cli-install" @click="installCli">Install</Button>
        <template #below>
          <div
            v-if="cliResult"
            :class="[
              'selectable mt-2.5 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed',
              cliResult.installed ? 'border-success/30 bg-success/8 text-fg' : 'border-danger/30 bg-danger/8 text-fg'
            ]"
            data-testid="cli-result"
          >
            <CircleCheck v-if="cliResult.installed" :size="14" class="mt-px shrink-0 text-success" />
            <CircleX v-else :size="14" class="mt-px shrink-0 text-danger" />
            <div class="min-w-0">
              <p class="break-words">{{ cliResult.message }}</p>
              <p v-if="cliResult.path" class="mt-0.5 font-mono break-all text-muted">{{ cliResult.path }}</p>
            </div>
          </div>
        </template>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Sharing">
      <SettingsRow
        label="GitHub token"
        description="Personal access token with the “gist” scope, used by Share as Gist. It is stored encrypted and never shown again."
        stacked
      >
        <div class="flex items-center gap-2" @focusout="saveToken()">
          <div class="min-w-0 flex-1" @focusin="onTokenFocus">
            <TextInput v-model="tokenDraft" type="password" :icon="KeyRound" placeholder="ghp_…" monospace data-testid="github-token" @enter="saveToken()" />
          </div>
          <Button v-if="tokenSet" variant="ghost" :icon="Trash2" :disabled="savingToken" @click="removeToken">Remove</Button>
          <Button :icon-right="ExternalLink" @click="openTokenPage">Create token</Button>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Reset">
      <SettingsRow label="Reset all settings" description="Go back to the defaults. Snippets, history and recent folders are kept.">
        <Button variant="danger" :icon="RotateCcw" data-testid="reset-settings" @click="resetAll">Reset…</Button>
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>
