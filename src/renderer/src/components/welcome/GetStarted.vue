<script setup lang="ts">
import { computed, onMounted } from 'vue'
import {
  ArrowRight,
  Box,
  Code,
  Folder,
  FolderOpen,
  Globe,
  Lightbulb,
  Sparkles,
  Terminal,
  Trash2
} from 'lucide-vue-next'
import { WELCOME_CODE } from '@shared/defaults'
import { executeCommand } from '../../commands'
import { useAppStore } from '../../stores/app'
import { useConnectionsStore } from '../../stores/connections'
import { useSettingsStore } from '../../stores/settings'
import { useTabsStore } from '../../stores/tabs'
import { basename, modKeyLabel, tildify } from '../../utils/platform'
import Button from '../common/Button.vue'
import Kbd from '../common/Kbd.vue'
import Spinner from '../common/Spinner.vue'
import Toggle from '../common/Toggle.vue'

/** "Get started" tab: start the Laravel Sandbox (or install it), open a folder, recent folders, Herd sites, tips. */
const app = useAppStore()
const connections = useConnectionsStore()
const settings = useSettingsStore()
const tabs = useTabsStore()

const recent = computed(() => connections.recent.slice(0, 7))
const herdSites = computed(() => app.herdSites.filter((s) => !connections.findByPath(s.path)).slice(0, 6))
const lastLog = computed(() => app.sandboxLog[app.sandboxLog.length - 1] ?? '')

const tips = computed(() => [
  { text: 'Run your code', accel: settings.accelerator('run') },
  { text: 'Open Anything — files, snippets, commands', accel: settings.accelerator('commandPalette') },
  { text: 'Switch between output cards and CLI text', accel: settings.accelerator('toggleCliMode') },
  { text: 'Add a magic comment //? to see a value inline', accel: settings.accelerator('addMagicComment') },
  { text: 'Snippets', accel: settings.accelerator('showSnippets') },
  { text: 'Flip the editor / output layout', accel: settings.accelerator('toggleLayout') }
])

const welcomeTab = computed({
  get: () => settings.settings.welcomeTab,
  set: (value: boolean) => void settings.set('welcomeTab', value)
})

function startSandbox(): void {
  tabs.newTab({ connectionId: 'sandbox' })
}

function plainPhp(): void {
  tabs.newTab({ connectionId: 'scratch' })
}

function openExample(): void {
  tabs.newTab({ code: WELCOME_CODE })
}

function openRecent(id: string): void {
  tabs.newTab({ connectionId: id })
}

async function openHerd(path: string): Promise<void> {
  try {
    const conn = await connections.openLocal(path)
    tabs.newTab({ connectionId: conn.id })
  } catch (err) {
    console.error(err)
  }
}

onMounted(() => {
  if (!app.herdLoaded) void app.loadHerdSites()
  if (!app.sandbox) void app.refreshSandbox()
})
</script>

<template>
  <div class="h-full overflow-auto bg-app-alt" data-testid="get-started">
    <div class="mx-auto flex max-w-[980px] flex-col gap-6 px-8 pt-10 pb-12">
      <header class="flex items-center gap-4">
        <img src="../../assets/logo.svg" alt="" class="size-14 drop-shadow-sm" draggable="false" />
        <div>
          <h1 class="text-[26px] font-bold tracking-tight text-fg">Welcome to Tinkerbox</h1>
          <p class="text-[14px] text-muted">Tinker with PHP and Laravel — every run boots your app in a fresh process.</p>
        </div>
      </header>

      <div class="grid gap-5 md:grid-cols-[1.15fr_1fr]">
        <!-- Get started -->
        <section class="min-w-0 rounded-2xl border border-line bg-surface p-5 shadow-sm">
          <h2 class="mb-4 flex items-center gap-2 text-[13px] font-bold tracking-wider text-muted uppercase">
            <Sparkles :size="14" class="text-accent" /> Get started
          </h2>
          <div class="flex flex-col gap-2.5">
            <div class="flex items-center gap-3 rounded-xl border border-line bg-app-alt/60 p-3">
              <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent shadow-sm shadow-accent/30">
                <Box :size="20" />
              </span>
              <div class="min-w-0 flex-1">
                <p class="font-semibold text-fg">Laravel Sandbox</p>
                <p class="truncate text-xs text-muted">
                  <template v-if="app.sandboxInstalling">
                    <span class="font-mono">{{ lastLog || 'Installing laravel/laravel with Composer…' }}</span>
                  </template>
                  <template v-else-if="app.sandboxInstalled">
                    A fresh Laravel app{{ app.sandbox?.laravelVersion ? ` (${app.sandbox.laravelVersion})` : '' }} to try things out.
                  </template>
                  <template v-else-if="app.sandbox?.error">
                    <span class="text-danger">{{ app.sandbox.error }}</span>
                  </template>
                  <template v-else>Not installed yet — installs a full Laravel app with Composer.</template>
                </p>
              </div>
              <Button v-if="app.sandboxInstalled" variant="primary" :icon-right="ArrowRight" data-testid="start-sandbox" @click="startSandbox">
                Start
              </Button>
              <Button v-else-if="app.sandboxInstalling" variant="secondary" disabled>
                <Spinner :size="14" /> Installing…
              </Button>
              <Button v-else variant="primary" data-testid="install-sandbox" @click="app.installSandbox()">
                {{ app.sandbox?.error ? 'Retry' : 'Install' }}
              </Button>
            </div>

            <button
              type="button"
              class="group flex items-center gap-3 rounded-xl border border-transparent p-3 text-left transition-colors hover:border-line hover:bg-app-alt/60"
              @click="executeCommand('openFolder')"
            >
              <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><FolderOpen :size="20" /></span>
              <span class="min-w-0 flex-1">
                <span class="block font-semibold text-fg">Open local directory…</span>
                <span class="block text-xs text-muted">Laravel, Symfony, WordPress, Drupal, Craft, Statamic and any Composer project</span>
              </span>
              <Kbd :accelerator="settings.accelerator('openFolder')" />
            </button>

            <button
              type="button"
              class="group flex items-center gap-3 rounded-xl border border-transparent p-3 text-left transition-colors hover:border-line hover:bg-app-alt/60"
              @click="plainPhp"
            >
              <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><Terminal :size="20" /></span>
              <span class="min-w-0 flex-1">
                <span class="block font-semibold text-fg">Plain PHP</span>
                <span class="block text-xs text-muted">No framework — just your PHP binary</span>
              </span>
              <ArrowRight :size="16" class="text-muted opacity-0 transition group-hover:opacity-100" />
            </button>

            <button
              type="button"
              class="group flex items-center gap-3 rounded-xl border border-transparent p-3 text-left transition-colors hover:border-line hover:bg-app-alt/60"
              @click="openExample"
            >
              <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><Code :size="20" /></span>
              <span class="min-w-0 flex-1">
                <span class="block font-semibold text-fg">Open the example script</span>
                <span class="block text-xs text-muted">Return values, magic comments and more in a few lines</span>
              </span>
              <ArrowRight :size="16" class="text-muted opacity-0 transition group-hover:opacity-100" />
            </button>
          </div>
        </section>

        <!-- Recent folders -->
        <!-- min-w-0: grid items default to min-width:auto, and a long recent path would widen the column past the window. -->
        <section class="flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-5 shadow-sm">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="flex items-center gap-2 text-[13px] font-bold tracking-wider text-muted uppercase">
              <Folder :size="14" class="text-accent" /> Recent folders
            </h2>
            <button
              v-if="recent.length"
              type="button"
              class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
              @click="connections.clearRecents()"
            >
              <Trash2 :size="12" /> Clear
            </button>
          </div>
          <ul v-if="recent.length" class="-mx-2 flex flex-col">
            <li v-for="conn in recent" :key="conn.id">
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent-soft"
                :title="conn.path"
                @click="openRecent(conn.id)"
              >
                <span class="size-2 shrink-0 rounded-full" :style="{ backgroundColor: connections.color(conn.id) }" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13px] font-semibold text-fg">{{ conn.name }}</span>
                  <span class="block truncate font-mono text-[11px] text-muted">{{ tildify(conn.path, app.homeDir) }}</span>
                </span>
              </button>
            </li>
          </ul>
          <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-center">
            <FolderOpen :size="22" class="text-muted" />
            <p class="text-[13px] text-muted">Projects you open will show up here.</p>
          </div>

          <template v-if="herdSites.length">
            <h2 class="mt-5 mb-2 flex items-center gap-2 text-[13px] font-bold tracking-wider text-muted uppercase">
              <Globe :size="14" class="text-accent" /> Herd sites
            </h2>
            <ul class="-mx-2 flex flex-col">
              <li v-for="site in herdSites" :key="site.path">
                <button
                  type="button"
                  class="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-accent-soft"
                  :title="site.path"
                  @click="openHerd(site.path)"
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[13px] font-semibold text-fg">{{ site.name || basename(site.path) }}</span>
                    <span class="block truncate font-mono text-[11px] text-muted">{{ site.url }}</span>
                  </span>
                  <span v-if="site.phpVersion" class="font-mono text-[11px] text-muted">PHP {{ site.phpVersion }}</span>
                </button>
              </li>
            </ul>
          </template>
        </section>
      </div>

      <!-- Tips -->
      <section class="rounded-2xl border border-line bg-surface p-5 shadow-sm">
        <h2 class="mb-3 flex items-center gap-2 text-[13px] font-bold tracking-wider text-muted uppercase">
          <Lightbulb :size="14" class="text-accent" /> Tips
        </h2>
        <ul class="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
          <li v-for="tip in tips" :key="tip.text" class="flex items-center justify-between gap-3 text-[13px] text-fg">
            <span class="min-w-0 truncate">{{ tip.text }}</span>
            <Kbd v-if="tip.accel" :accelerator="tip.accel" />
          </li>
        </ul>
        <p class="mt-4 text-xs text-muted">
          End a line with <code class="rounded bg-accent-soft px-1 py-0.5 font-mono text-accent">//?</code> to see its value right next to it.
          In the sidebar's recent folders, <span class="font-semibold">{{ modKeyLabel() }}</span>-click opens a project in a new tab.
        </p>
      </section>

      <div class="flex items-center justify-between px-1">
        <Toggle v-model="welcomeTab" size="sm" />
        <span class="mr-auto ml-2 text-xs text-muted">Show this tab when Tinkerbox starts</span>
        <button type="button" class="text-xs font-semibold text-accent hover:underline" @click="executeCommand('commandPalette')">
          Open Anything…
        </button>
      </div>
    </div>
  </div>
</template>
