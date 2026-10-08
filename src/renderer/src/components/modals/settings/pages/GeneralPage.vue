<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { CircleCheck, CircleX, ExternalLink, FileSearch, RefreshCw, Sparkles, X } from 'lucide-vue-next'
import type { EditorIntegration, PhpBinary } from '@shared/types'
import { api } from '@/api'
import { useAppStore } from '@/stores/app'
import { useConnectionsStore } from '@/stores/connections'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { platform, tildify } from '@/utils/platform'
import Badge from '../../../common/Badge.vue'
import Button from '../../../common/Button.vue'
import Select from '../../../common/Select.vue'
import Spinner from '../../../common/Spinner.vue'
import TextInput from '../../../common/TextInput.vue'
import Toggle from '../../../common/Toggle.vue'
import SettingsGroup from '../SettingsGroup.vue'
import SettingsRow from '../SettingsRow.vue'
import { useSetting } from '../useSetting'

const settings = useSettingsStore()
const app = useAppStore()
const connections = useConnectionsStore()
const ui = useUiStore()

// -- PHP binary ------------------------------------------------------------------------------------------------

const phpBinary = useSetting('phpBinary')
const draft = ref(phpBinary.value === 'auto' ? '' : phpBinary.value)
const binaries = ref<PhpBinary[]>([])
const detecting = ref(false)
const detected = ref(false)
const inspecting = ref(false)
const inspected = ref<{ value: string; result: PhpBinary | null } | null>(null)

const isAuto = computed(() => phpBinary.value === 'auto' || phpBinary.value.trim() === '')
/** The binary automatic detection runs right now ('php:inspect' resolves 'auto' in main). */
const autoBinary = ref<PhpBinary | null>(null)

async function inspectAuto(): Promise<void> {
  try {
    autoBinary.value = await api.invoke('php:inspect', 'auto')
  } catch {
    autoBinary.value = null
  }
}
const herdFound = computed(() => binaries.value.some((b) => b.source === 'Herd'))

watch(phpBinary, (value) => {
  const next = value === 'auto' ? '' : value
  if (next !== draft.value) draft.value = next
})

async function detect(): Promise<void> {
  detecting.value = true
  void inspectAuto()
  try {
    binaries.value = await api.invoke('php:binaries')
  } catch (err) {
    ui.error(err, 'Could not look for PHP binaries')
  } finally {
    detecting.value = false
    detected.value = true
  }
}

async function inspect(value: string): Promise<void> {
  if (!value || value === 'auto') {
    inspected.value = null
    return
  }
  inspecting.value = true
  try {
    const result = await api.invoke('php:inspect', value)
    if (phpBinary.value === value) inspected.value = { value, result }
  } catch {
    if (phpBinary.value === value) inspected.value = { value, result: null }
  } finally {
    inspecting.value = false
  }
}

function usePhp(value: string): void {
  const next = value.trim() || 'auto'
  draft.value = next === 'auto' ? '' : next
  if (next !== phpBinary.value) phpBinary.value = next
  void inspect(next)
}

function commitDraft(): void {
  const next = draft.value.trim() || 'auto'
  if (next !== phpBinary.value) usePhp(next)
}

async function browse(): Promise<void> {
  try {
    const filters = platform === 'win32' ? [{ name: 'PHP', extensions: ['exe'] }] : undefined
    const path = await api.invoke('dialog:openFile', 'Choose a PHP binary', filters)
    if (path) usePhp(path)
  } catch (err) {
    ui.error(err, 'Could not open the file picker')
  }
}

function isChosen(b: PhpBinary): boolean {
  return phpBinary.value === b.path || (!!b.alias && phpBinary.value === b.alias)
}

function openLink(url: string): void {
  void api.invoke('shell:openExternal', url).catch((err: unknown) => ui.error(err, 'Could not open the link'))
}

// -- Editor & tabs ---------------------------------------------------------------------------------------------

const EDITORS: Array<{ value: EditorIntegration; label: string }> = [
  { value: 'vscode', label: 'Visual Studio Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'windsurf', label: 'Windsurf' },
  { value: 'phpstorm', label: 'PhpStorm' },
  { value: 'sublime', label: 'Sublime Text' },
  { value: 'zed', label: 'Zed' },
  { value: 'textmate', label: 'TextMate' },
  { value: 'nova', label: 'Nova' },
  { value: 'bbedit', label: 'BBEdit' },
  { value: 'none', label: 'None' }
]

const editor = useSetting('editorIntegration')
const welcomeTab = useSetting('welcomeTab')
const restoreSession = useSetting('restoreSession')
const askBeforeClosingTab = useSetting('askBeforeClosingTab')

const workingDir = useSetting('defaultWorkingDirectory')
const dirDraft = ref(workingDir.value)
const dirRejected = ref<string | null>(null)
watch(workingDir, (value) => {
  if (value !== dirDraft.value) dirDraft.value = value
})
watch(dirDraft, (value) => {
  if (dirRejected.value !== null && value.trim() !== dirRejected.value) dirRejected.value = null
})

/** Where tabs without a project run when there is no usable Default Working Directory. */
const dirFallback = computed(() => (app.sandbox && !app.sandbox.installed ? 'plain PHP' : 'the Laravel Sandbox'))

const dirError = computed(() => {
  if (dirRejected.value !== null) return `There is no folder at this path. New tabs keep starting in ${dirFallback.value}.`
  if (connections.defaultDirectoryMissing && dirDraft.value.trim() === workingDir.value) {
    return `This folder does not exist (any more), so new tabs start in ${dirFallback.value}. Pick another folder or clear it.`
  }
  return null
})

/** Save the directory once the main process confirms it is a folder (runs ignore anything else). */
async function commitDir(value: string = dirDraft.value): Promise<void> {
  const next = value.trim()
  dirDraft.value = next
  if (next === '') dirRejected.value = null
  if (next === workingDir.value) {
    if (next !== '') void connections.checkDefaultDirectory()
    return
  }
  if (next !== '') {
    let exists = true
    try {
      exists = await api.invoke('file:isDirectory', next)
    } catch {
      // Could not check: save it; the status line below reports a missing folder later.
    }
    if (dirDraft.value.trim() !== next) return
    if (!exists) {
      dirRejected.value = next
      return
    }
  }
  dirRejected.value = null
  workingDir.value = next
}

onMounted(() => {
  void detect()
  if (!isAuto.value) void inspect(phpBinary.value)
  if (!app.sandbox) void app.refreshSandbox()
})
</script>

<template>
  <div class="flex flex-col gap-7">
    <SettingsGroup title="PHP">
      <SettingsRow
        label="PHP binary"
        description="The PHP command-line binary that runs your code. Automatic picks the first working PHP it finds; a project can override it in its PHP settings."
        stacked
      >
        <div class="flex items-center gap-2" @focusout="commitDraft">
          <div class="min-w-0 flex-1">
            <TextInput v-model="draft" placeholder="Automatic" monospace clearable data-testid="php-binary-input" @enter="commitDraft" />
          </div>
          <Button :icon="FileSearch" @click="browse">Browse…</Button>
          <Button v-if="!isAuto" variant="ghost" :icon="Sparkles" @click="usePhp('auto')">Use automatic</Button>
        </div>
        <div class="mt-2 min-h-5 text-xs">
          <span v-if="inspecting" class="flex items-center gap-1.5 text-muted"><Spinner :size="12" /> Checking {{ phpBinary }}…</span>
          <template v-else-if="!isAuto && inspected && inspected.value === phpBinary">
            <span v-if="inspected.result" class="flex items-center gap-1.5 text-success" data-testid="php-version-line">
              <CircleCheck :size="13" class="shrink-0" />
              <span class="selectable truncate font-mono">{{ inspected.result.versionLine || `PHP ${inspected.result.version}` }}</span>
            </span>
            <span v-else class="flex items-center gap-1.5 text-danger">
              <CircleX :size="13" class="shrink-0" /> This is not a working PHP CLI binary. Runs will fail until you pick another one.
            </span>
          </template>
          <span v-else-if="isAuto" class="text-muted">
            Using automatic detection{{ autoBinary ? ` — currently PHP ${autoBinary.version} (${autoBinary.source}${autoBinary.alias ? ` ${autoBinary.alias}` : ''})` : '' }}.
          </span>
        </div>
        <template #below>
          <div class="mt-3 rounded-lg border border-line bg-surface">
            <div class="flex items-center gap-2 border-b border-line px-3 py-2">
              <span class="flex-1 text-[11px] font-bold tracking-wider text-muted uppercase">Found on this computer</span>
              <button
                type="button"
                class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold text-accent hover:bg-accent-soft disabled:opacity-50"
                :disabled="detecting"
                @click="detect"
              >
                <RefreshCw :size="12" :class="detecting ? 'animate-spin' : ''" /> Rescan
              </button>
            </div>
            <div v-if="detecting && !detected" class="flex items-center justify-center gap-2 p-4 text-xs text-muted"><Spinner :size="14" /> Looking for PHP…</div>
            <div v-else-if="binaries.length === 0" class="p-4 text-xs leading-relaxed text-muted" data-testid="php-empty">
              <p class="font-semibold text-fg">No PHP installation found.</p>
              <p class="mt-1">
                Tinkerbox runs your code with PHP 7.4 or newer. The quickest way to get it is Laravel Herd (macOS and Windows) or the one-line
                installer from php.new (macOS, Linux and Windows). Press Rescan when it is installed.
              </p>
              <div class="mt-2.5 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" :icon-right="ExternalLink" @click="openLink('https://herd.laravel.com')">Get Laravel Herd</Button>
                <Button size="sm" :icon-right="ExternalLink" @click="openLink('https://php.new')">Install with php.new</Button>
              </div>
            </div>
            <ul v-else class="max-h-[220px] overflow-auto p-1">
              <li v-for="b in binaries" :key="b.path + (b.alias ?? '')">
                <button
                  type="button"
                  :class="['flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left', isChosen(b) ? 'bg-accent-soft' : 'hover:bg-hover']"
                  :title="b.versionLine"
                  @click="usePhp(b.alias ?? b.path)"
                >
                  <span class="w-[52px] shrink-0 text-[13px] font-semibold text-fg tabular">{{ b.version }}</span>
                  <Badge size="xs" :variant="b.source === 'Herd' ? 'accent' : 'neutral'">{{ b.source }}</Badge>
                  <span v-if="b.alias" class="font-mono text-[11px] text-accent">{{ b.alias }}</span>
                  <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{{ tildify(b.path, app.homeDir) }}</span>
                  <CircleCheck v-if="isChosen(b)" :size="14" class="shrink-0 text-accent" />
                </button>
              </li>
            </ul>
          </div>
          <p v-if="herdFound || platform !== 'linux'" class="mt-2 text-xs text-muted">
            <span class="font-semibold text-fg">Herd tip:</span> type a Herd alias such as
            <code class="font-mono text-accent">php84</code> to pin a version — it keeps working when Herd updates PHP.
          </p>
        </template>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Projects">
      <SettingsRow label="Preferred editor" description="Opens projects and dumped file paths (click a file name in the output).">
        <Select v-model="editor" :options="EDITORS" class="w-[200px]" />
      </SettingsRow>
      <SettingsRow
        label="Default working directory"
        description="Project used by new tabs. Leave it empty to start new tabs in the Laravel Sandbox (or plain PHP when the sandbox is not installed)."
        stacked
      >
        <div class="flex items-start gap-2" @focusout="commitDir()">
          <div class="min-w-0 flex-1">
            <TextInput
              v-model="dirDraft"
              placeholder="None - Use Laravel Sandbox"
              monospace
              folder-picker
              picker-title="Default working directory"
              data-testid="dwd-input"
              :error="dirError"
              @enter="commitDir()"
              @picked="commitDir"
            />
          </div>
          <Button v-if="workingDir" variant="ghost" :icon="X" @click="commitDir('')">Clear</Button>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Startup & tabs">
      <SettingsRow label="Welcome tab" description="Show the Get started tab when Tinkerbox opens.">
        <Toggle v-model="welcomeTab" />
      </SettingsRow>
      <SettingsRow label="Restore session" description="Reopen the tabs and code from last time.">
        <Toggle v-model="restoreSession" />
      </SettingsRow>
      <SettingsRow label="Ask before closing tab" description="Confirm before closing a tab that still contains code.">
        <Toggle v-model="askBeforeClosingTab" />
      </SettingsRow>
    </SettingsGroup>

    <p class="px-1 text-xs text-muted">Changes are saved as you make them. {{ settings.loaded ? '' : '(loading…)' }}</p>
  </div>
</template>
