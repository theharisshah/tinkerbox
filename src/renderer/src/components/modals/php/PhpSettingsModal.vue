<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { Bug, Check, FileSearch, RotateCcw } from 'lucide-vue-next'
import type { Connection, PhpBinary } from '@shared/types'
import { api } from '../../../api'
import { useAppStore } from '../../../stores/app'
import { useConnectionsStore } from '../../../stores/connections'
import { useEnvironmentStore } from '../../../stores/environment'
import { useSettingsStore } from '../../../stores/settings'
import { useTabsStore } from '../../../stores/tabs'
import { useUiStore } from '../../../stores/ui'
import { cloneJson } from '../../../utils/merge'
import { tildify } from '../../../utils/platform'
import Badge from '../../common/Badge.vue'
import Button from '../../common/Button.vue'
import Modal from '../../common/Modal.vue'
import Spinner from '../../common/Spinner.vue'
import TextInput from '../../common/TextInput.vue'
import Toggle from '../../common/Toggle.vue'
import { binaryValue, effectiveBinary, globalBinary, guessAutoBinary, matchesBinary } from './phpUtils'

/**
 * Per-project PHP settings (click the PHP version in the footer): PHP binary override (path or Herd alias) with
 * validation, detected installations, reset to the global default, and the Xdebug step debugging toggle.
 */
const props = defineProps<{ connectionId: string | null }>()
const emit = defineEmits<{ close: [result?: unknown] }>()

const connections = useConnectionsStore()
const settings = useSettingsStore()
const environment = useEnvironmentStore()
const tabs = useTabsStore()
const app = useAppStore()
const ui = useUiStore()

const connection = computed<Connection | null>(() => connections.resolve(props.connectionId))
const projectLabel = computed(() => connections.label(props.connectionId))
const projectPath = computed(() => connections.path(props.connectionId))
const configured = computed(() => connection.value?.phpBinary?.trim() ?? '')
const globalValue = computed(() => globalBinary(settings.settings.phpBinary))
const effective = computed(() => effectiveBinary(configured.value, settings.settings.phpBinary))

const input = ref(configured.value)
const inputError = ref<string | null>(null)
const checking = ref(false)
const resetting = ref(false)
const binaries = shallowRef<PhpBinary[]>([])
const binariesLoading = ref(true)
const detected = shallowRef<PhpBinary | null>(null)
const detecting = ref(false)
const detectError = ref<string | null>(null)
const debugBusy = ref(false)

const reportedVersion = computed(() => {
  const tab = tabs.activeTab
  const result = tab && tab.kind === 'code' && tab.connectionId === props.connectionId ? tabs.resultOf(tab.id) : null
  return result?.phpVersion || environment.get(props.connectionId)?.phpVersion || ''
})
const debugging = computed(() => connections.isDebugging(props.connectionId))
const canChange = computed(() => !checking.value && input.value.trim() !== '' && input.value.trim() !== configured.value)

// Keep the field in sync when the configuration changes elsewhere (and the user has not typed something else).
watch(configured, (value, previous) => {
  if (input.value.trim() === (previous ?? '')) input.value = value
})

// A validation error belongs to the value it was raised for.
watch(input, () => (inputError.value = null))

let detectToken = 0
async function detect(): Promise<void> {
  const token = ++detectToken
  detectError.value = null
  if (effective.value === 'auto') {
    // 'php:inspect' resolves `auto` in main (Herd's default PHP, else the first discovered binary). The guess from
    // the detected list is only a fallback when that fails.
    detecting.value = true
    let exact: PhpBinary | null = null
    try {
      exact = await api.invoke('php:inspect', 'auto')
    } catch {
      exact = null
    }
    if (token !== detectToken) return
    if (!exact && binariesLoading.value) return // loadBinaries() calls detect() again
    detected.value = exact ?? guessAutoBinary(binaries.value, reportedVersion.value)
    detecting.value = false
    if (!detected.value) detectError.value = 'No PHP installation was detected.'
    return
  }
  detecting.value = true
  try {
    const result = await api.invoke('php:inspect', effective.value)
    if (token !== detectToken) return
    detected.value = result
    if (!result) detectError.value = `"${effective.value}" is not a working PHP CLI binary.`
  } catch (err) {
    if (token !== detectToken) return
    detected.value = null
    detectError.value = api.errorText(err)
  } finally {
    if (token === detectToken) detecting.value = false
  }
}

watch(effective, () => void detect())

async function loadBinaries(): Promise<void> {
  binariesLoading.value = true
  try {
    binaries.value = await api.invoke('php:binaries')
  } catch (err) {
    binaries.value = []
    ui.error(err, 'Could not detect PHP installations')
  } finally {
    binariesLoading.value = false
    if (effective.value === 'auto') void detect()
  }
}

/** Stored connection behind the tab, created for a Default Working Directory without an entry yet. */
async function ensureConnection(): Promise<Connection> {
  let conn = connections.resolve(props.connectionId)
  if (!conn && !props.connectionId) {
    const dir = connections.defaultDirectory
    if (dir) conn = await connections.openLocal(dir)
  }
  if (!conn) throw new Error('This tab has no project to configure.')
  return conn
}

function refreshEnvironment(): void {
  void environment.load(props.connectionId, true)
}

async function apply(): Promise<void> {
  const value = input.value.trim()
  inputError.value = null
  if (!value) {
    await reset()
    return
  }
  checking.value = true
  try {
    const binary = await api.invoke('php:inspect', value)
    if (!binary) {
      inputError.value = `"${value}" is not a working PHP CLI binary. Enter the path of a php executable or a Herd alias such as php83.`
      return
    }
    const conn = await ensureConnection()
    await connections.save({ ...cloneJson(conn), phpBinary: value })
    input.value = value
    detected.value = binary
    refreshEnvironment()
    ui.toast({ level: 'success', key: 'php-binary', message: `${projectLabel.value} now runs ${binary.versionLine || `PHP ${binary.version}`}.` })
  } catch (err) {
    inputError.value = api.errorText(err)
  } finally {
    checking.value = false
  }
}

async function reset(): Promise<void> {
  inputError.value = null
  resetting.value = true
  try {
    const conn = connections.resolve(props.connectionId)
    if (conn?.phpBinary) {
      await connections.save({ ...cloneJson(conn), phpBinary: '' })
      refreshEnvironment()
      ui.toast({ level: 'info', key: 'php-binary', message: `${projectLabel.value} uses the global PHP setting (${globalValue.value}) again.` })
    }
    input.value = ''
  } catch (err) {
    inputError.value = api.errorText(err)
  } finally {
    resetting.value = false
  }
}

function pick(binary: PhpBinary): void {
  input.value = binaryValue(binary)
  inputError.value = null
}

async function browse(): Promise<void> {
  try {
    const file = await api.invoke('dialog:openFile', 'Choose a PHP binary')
    if (file) {
      input.value = file
      inputError.value = null
    }
  } catch (err) {
    ui.error(err, 'Could not open the file picker')
  }
}

async function setDebugging(on: boolean): Promise<void> {
  if (on === debugging.value || debugBusy.value) return
  debugBusy.value = true
  try {
    await connections.toggleDebug(props.connectionId)
  } catch (err) {
    ui.error(err, 'Could not change the debugging setting')
  } finally {
    debugBusy.value = false
  }
}

onMounted(() => {
  void loadBinaries()
  if (effective.value !== 'auto') void detect()
})
</script>

<template>
  <Modal title="PHP Settings" size="md" initial-focus="[data-php-input]" @close="emit('close')">
    <div class="space-y-5">
      <p class="-mt-1 text-[13px] text-muted">
        PHP used for
        <span class="font-semibold text-fg">{{ projectLabel }}</span>
        <span v-if="projectPath" class="font-mono text-[11.5px]"> · {{ tildify(projectPath, app.homeDir) }}</span>
      </p>

      <!-- Configured binary -->
      <section class="space-y-2">
        <h3 class="text-[13px] font-semibold text-fg">Configured PHP Binary</h3>
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1" data-php-input>
            <TextInput
              v-model="input"
              monospace
              :placeholder="`Global default (${globalValue})`"
              :error="inputError"
              @enter="apply"
            >
              <template #suffix>
                <button
                  type="button"
                  class="-mr-1 flex h-6 shrink-0 items-center rounded-md px-1.5 text-muted hover:bg-hover hover:text-accent"
                  title="Choose a PHP binary…"
                  aria-label="Choose a PHP binary"
                  @click="browse"
                >
                  <FileSearch :size="15" />
                </button>
              </template>
            </TextInput>
          </div>
          <Button variant="primary" :loading="checking" :disabled="!canChange" @click="apply">Change</Button>
        </div>
        <p class="text-xs text-muted">
          A path to a <span class="font-mono">php</span> executable or a Laravel Herd alias such as
          <span class="font-mono">php83</span>. Leave it empty to use the global setting from Settings → General.
        </p>
        <div class="flex min-h-[34px] items-center gap-2 rounded-lg border border-line bg-app-alt/60 px-3 py-2 text-xs" data-testid="php-detected">
          <span class="shrink-0 font-medium text-muted">Detected version:</span>
          <Spinner v-if="detecting" :size="12" class="text-muted" />
          <span v-else-if="detected" class="selectable min-w-0 truncate font-mono text-fg" :title="detected.path">
            {{ detected.versionLine || `PHP ${detected.version}` }}
          </span>
          <span v-else class="min-w-0 truncate text-warning">{{ detectError ?? 'Unknown' }}</span>
          <Badge v-if="effective === 'auto' && detected" size="xs" class="ml-auto">automatic</Badge>
          <Badge v-else-if="!configured && detected" size="xs" class="ml-auto">global</Badge>
        </div>
      </section>

      <!-- Detected installations -->
      <section class="space-y-2">
        <h3 class="text-[13px] font-semibold text-fg">Detected PHP binaries</h3>
        <div v-if="binariesLoading" class="flex items-center gap-2 py-2 text-xs text-muted">
          <Spinner :size="13" /> Looking for PHP installations…
        </div>
        <p v-else-if="binaries.length === 0" class="py-1 text-xs text-muted">
          No PHP installations were found (Herd, Homebrew, MAMP, XAMPP, Laragon, system or PATH).
        </p>
        <ul v-else class="max-h-[220px] overflow-y-auto rounded-xl border border-line" role="listbox" aria-label="Detected PHP binaries">
          <li v-for="binary in binaries" :key="binary.path" class="border-t border-line/70 first:border-t-0">
            <button
              type="button"
              role="option"
              :aria-selected="matchesBinary(binary, input)"
              :class="[
                'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                matchesBinary(binary, input) ? 'bg-accent-soft' : 'hover:bg-hover'
              ]"
              :title="`Use ${binaryValue(binary)} (double-click to apply)`"
              @click="pick(binary)"
              @dblclick="pick(binary); apply()"
            >
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="text-[13px] font-semibold text-fg">PHP {{ binary.version }}</span>
                  <Badge size="xs" :variant="binary.source === 'Herd' ? 'accent' : 'neutral'">{{ binary.source }}</Badge>
                  <span v-if="binary.alias" class="rounded bg-fg/6 px-1.5 font-mono text-[10.5px] text-muted">{{ binary.alias }}</span>
                </span>
                <span class="mt-0.5 block truncate font-mono text-[11px] text-muted">{{ tildify(binary.path, app.homeDir) }}</span>
              </span>
              <Check v-if="matchesBinary(binary, configured)" :size="15" class="shrink-0 text-accent" aria-label="Configured" />
            </button>
          </li>
        </ul>
      </section>

      <!-- Debugging -->
      <section class="rounded-xl border border-line p-3.5">
        <div class="flex items-start gap-3">
          <span
            :class="[
              'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
              debugging ? 'bg-warning/15 text-warning' : 'bg-fg/6 text-muted'
            ]"
          >
            <Bug :size="16" />
          </span>
          <div class="min-w-0 flex-1">
            <Toggle
              :model-value="debugging"
              label="Xdebug step debugging"
              :disabled="debugBusy"
              @update:model-value="setDebugging"
            />
            <p class="mt-1 text-xs leading-relaxed text-muted">
              Runs this project with Xdebug's step debugger so breakpoints in your IDE are hit. Requires Laravel Herd (or PHP
              with Xdebug installed) and an IDE listening for debug connections on port 9003.
            </p>
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <Button variant="ghost" size="sm" :icon="RotateCcw" :loading="resetting" :disabled="!configured" @click="reset">
        Reset PHP to global default
      </Button>
      <div class="flex-1" />
      <Button size="sm" @click="emit('close')">Close</Button>
    </template>
  </Modal>
</template>
