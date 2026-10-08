<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type Component } from 'vue'
import {
  Bookmark,
  Box,
  Code,
  Command,
  FolderOpen,
  Folder,
  Globe,
  Hash,
  Search,
  Slash,
  Sparkles,
  ChevronRight
} from 'lucide-vue-next'
import { WELCOME_CODE } from '@shared/defaults'
import { commandList, commandShortcut, executeCommand } from '@/commands'
import { useAppStore } from '@/stores/app'
import { useConnectionsStore } from '@/stores/connections'
import { useSnippetsStore } from '@/stores/snippets'
import { useTabsStore } from '@/stores/tabs'
import { useUiStore } from '@/stores/ui'
import { highlightSegments } from '@/utils/fuzzy'
import { modKeyLabel, tildify } from '@/utils/platform'
import Kbd from '../../common/Kbd.vue'
import Modal from '../../common/Modal.vue'
import { snippetOpenConnection, snippetProjectId } from '../snippets/snippets'
import {
  buildPaletteGroups,
  firstSelectable,
  flattenPalette,
  moveSelection,
  paletteEmptyText,
  parsePaletteQuery,
  withPrefix,
  type PaletteGroupId,
  type PaletteHit,
  type PaletteItem,
  type PaletteMode,
  type PaletteSources
} from './palette'

/**
 * Open Anything (⇧⌘P): one fuzzy search over getting-started actions, every command, recent folders, snippets and
 * Herd sites. Prefixes narrow it down: `#` snippets, `/` recent folders, `>` commands. ↑↓ + Enter run the selection,
 * ⌘Enter opens folders / snippets in a new tab, Esc clears the query first and closes when it is empty.
 */
const props = withDefaults(defineProps<{ query?: string }>(), { query: '' })
const emit = defineEmits<{ close: [result?: unknown] }>()

const app = useAppStore()
const connections = useConnectionsStore()
const snippets = useSnippetsStore()
const tabs = useTabsStore()
const ui = useUiStore()
const mod = modKeyLabel()

const query = ref(props.query)
const selected = ref(0)
const input = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const ICONS: Record<string, Component> = {
  sandbox: Box,
  folderOpen: FolderOpen,
  welcome: Sparkles,
  example: Code,
  command: Command,
  folder: Folder,
  snippet: Bookmark,
  herd: Globe
}

const GROUP_HINTS: Partial<Record<PaletteGroupId, PaletteMode>> = { commands: 'commands', folders: 'folders', snippets: 'snippets' }

function close(): void {
  emit('close')
}

/** Close first, then run (so actions that open modals are not replaced by the palette closing). */
function later(action: () => unknown): void {
  close()
  void nextTick(async () => {
    try {
      await action()
    } catch (err) {
      ui.error(err)
    }
  })
}

const activeConnection = computed(() => (tabs.activeTab?.kind === 'code' ? tabs.activeTab.connectionId : null))

const sources = computed<PaletteSources>(() => {
  const start: PaletteItem[] = [
    {
      key: 'start:sandbox',
      group: 'start',
      title: 'Open Laravel Sandbox',
      description: app.sandbox && !app.sandbox.installed ? 'Not installed yet — shows how to install it' : 'A fresh Laravel app to try things out',
      icon: 'sandbox',
      shortcut: commandShortcut('openSandbox'),
      run: () => later(() => tabs.openSandbox())
    },
    {
      key: 'start:folder',
      group: 'start',
      title: 'Open local directory…',
      description: 'Laravel, Symfony, WordPress or any Composer project',
      icon: 'folderOpen',
      shortcut: commandShortcut('openFolder'),
      run: () => later(() => executeCommand('openFolder'))
    },
    {
      key: 'start:welcome',
      group: 'start',
      title: 'Show Get Started',
      description: 'The welcome tab with the sandbox, recent folders and tips',
      icon: 'welcome',
      shortcut: commandShortcut('showWelcome'),
      run: () => later(() => tabs.openWelcome())
    },
    {
      key: 'start:example',
      group: 'start',
      title: 'Open Code Example',
      description: 'A short script that shows off the output and magic comments',
      icon: 'example',
      run: () => later(() => tabs.newTab({ code: WELCOME_CODE }))
    }
  ]

  // Commands that can run right now first (stable within each half), so browsing shows useful ones.
  const listed = commandList().filter((c) => c.id !== 'commandPalette')
  const commands: PaletteItem[] = [...listed.filter((c) => c.enabled), ...listed.filter((c) => !c.enabled)]
    .map((c) => ({
      key: `cmd:${c.id}`,
      group: 'commands',
      title: c.title,
      description: c.enabled ? c.group : `${c.group} · not available right now`,
      keywords: c.id,
      shortcut: c.shortcut,
      disabled: !c.enabled,
      icon: 'command',
      run: () => later(() => executeCommand(c.id))
    }))

  const folders: PaletteItem[] = connections.recent.map((conn) => ({
    key: `folder:${conn.id}`,
    group: 'folders',
    title: conn.name,
    description: tildify(conn.path, app.homeDir),
    keywords: conn.path,
    icon: 'folder',
    color: connections.color(conn.id),
    supportsNewTab: true,
    run: ({ newTab }) => later(() => tabs.openProject(conn, { newTab }))
  }))

  const snippetItems: PaletteItem[] = snippets.snippets.map((s) => {
    const project = snippetProjectId(s)
    return {
      key: `snippet:${s.id}`,
      group: 'snippets',
      title: s.name,
      description: [project ? connections.label(project) : 'Global', s.description].filter(Boolean).join(' · '),
      keywords: s.code.slice(0, 400),
      icon: 'snippet',
      color: project ? connections.color(project) : undefined,
      supportsNewTab: true,
      run: ({ newTab }) => later(() => tabs.openCode(s.code, { connectionId: snippetOpenConnection(s, newTab, activeConnection.value), newTab }))
    }
  })

  const herd: PaletteItem[] = app.herdSites
    .filter((site) => !connections.findByPath(site.path))
    .map((site) => ({
      key: `herd:${site.path}`,
      group: 'herd',
      title: site.name,
      description: [site.url, site.phpVersion ? `PHP ${site.phpVersion}` : ''].filter(Boolean).join(' · '),
      keywords: site.path,
      icon: 'herd',
      supportsNewTab: true,
      run: ({ newTab }) =>
        later(async () => {
          const conn = await connections.openLocal(site.path)
          tabs.openProject(conn, { newTab })
        })
    }))

  return { start, commands, folders, snippets: snippetItems, herd }
})

const parsed = computed(() => parsePaletteQuery(query.value))
const emptyText = computed(() =>
  paletteEmptyText(parsed.value, { snippets: snippets.snippets.length, recentFolders: connections.recent.length })
)
const groups = computed(() => buildPaletteGroups(sources.value, query.value))
const hits = computed<PaletteHit[]>(() => flattenPalette(groups.value))
const current = computed<PaletteHit | null>(() => hits.value[selected.value] ?? null)

const placeholder = computed(
  () =>
    ({
      all: 'Search projects, snippets and commands…',
      snippets: 'Search snippets…',
      folders: 'Search recent folders…',
      commands: 'Search commands…'
    })[parsed.value.mode]
)

const modeLabel = computed(() => ({ all: '', snippets: 'Snippets', folders: 'Folders', commands: 'Commands' })[parsed.value.mode])

watch(groups, () => {
  selected.value = firstSelectable(hits.value)
})

watch(selected, () => {
  void nextTick(() => listEl.value?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
})

function indexOf(hit: PaletteHit): number {
  return hits.value.indexOf(hit)
}

function run(hit: PaletteHit | null, newTab: boolean): void {
  if (!hit || hit.item.disabled) return
  void hit.item.run({ newTab: newTab && !!hit.item.supportsNewTab })
}

function showAll(id: PaletteGroupId): void {
  const mode = GROUP_HINTS[id]
  if (!mode) return
  query.value = withPrefix(mode, parsed.value.text)
  input.value?.focus()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      event.preventDefault()
      const next = moveSelection(hits.value, selected.value, event.key === 'ArrowDown' ? 1 : -1)
      if (next >= 0) selected.value = next
      break
    }
    case 'Enter':
      event.preventDefault()
      run(current.value, event.metaKey || event.ctrlKey)
      break
    case 'Escape':
      // First Esc clears the query, the second one closes (handled by <Modal>).
      if (query.value !== '') {
        event.preventDefault()
        event.stopPropagation()
        query.value = ''
      }
      break
  }
}

onMounted(() => {
  if (!snippets.loaded || snippets.connectionId !== activeConnection.value) void snippets.load(activeConnection.value)
  if (!app.herdLoaded) void app.loadHerdSites()
  void nextTick(() => {
    const el = input.value
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  })
  selected.value = firstSelectable(hits.value)
})
</script>

<template>
  <Modal size="lg" hide-header :padded="false" height="min(560px, calc(100vh - 96px))" aria-label="Open Anything" @close="close">
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 items-center gap-3 border-b border-line px-4">
        <Search :size="19" class="shrink-0 text-muted" />
        <span v-if="modeLabel" class="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-bold text-accent">{{ modeLabel }}</span>
        <input
          ref="input"
          v-model="query"
          type="text"
          autofocus
          spellcheck="false"
          autocomplete="off"
          :placeholder="placeholder"
          aria-label="Open Anything"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          class="h-14 min-w-0 flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-muted/80"
          data-testid="palette-input"
          @keydown="onKeydown"
        />
        <Kbd :keys="['esc']" size="xs" subtle class="text-muted" />
      </div>

      <div id="palette-results" ref="listEl" class="min-h-0 flex-1 overflow-auto p-2" role="listbox" aria-label="Results">
        <section v-for="group in groups" :key="group.id" class="mb-1.5" :data-group="group.id">
          <div class="flex items-center px-3 pt-2 pb-1">
            <span class="flex-1 text-[11px] font-bold tracking-wider text-muted uppercase">{{ group.title }}</span>
            <button
              v-if="group.total > group.hits.length && GROUP_HINTS[group.id]"
              type="button"
              class="flex items-center gap-0.5 rounded px-1 text-[11px] font-semibold text-accent hover:bg-accent-soft"
              @mousedown.prevent
              @click="showAll(group.id)"
            >
              All {{ group.total }} <ChevronRight :size="12" />
            </button>
          </div>
          <div
            v-for="hit in group.hits"
            :key="hit.item.key"
            role="option"
            :aria-selected="indexOf(hit) === selected"
            :aria-disabled="hit.item.disabled || undefined"
            :data-selected="indexOf(hit) === selected"
            :class="[
              'flex items-center gap-3 rounded-lg px-3 py-2',
              hit.item.disabled ? 'opacity-50' : '',
              indexOf(hit) === selected ? 'bg-accent-soft' : hit.item.disabled ? '' : 'hover:bg-hover'
            ]"
            @mousemove="!hit.item.disabled && indexOf(hit) !== selected && (selected = indexOf(hit))"
            @mousedown.prevent
            @click="run(hit, $event.metaKey || $event.ctrlKey)"
          >
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-lg"
              :class="hit.item.color ? '' : indexOf(hit) === selected ? 'bg-accent text-on-accent' : 'bg-accent/12 text-accent'"
              :style="hit.item.color ? { color: hit.item.color, backgroundColor: `color-mix(in srgb, ${hit.item.color} 15%, transparent)` } : undefined"
            >
              <component :is="ICONS[hit.item.icon ?? 'command'] ?? Command" :size="16" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13.5px] font-semibold text-fg">
                <template v-for="(seg, k) in highlightSegments(hit.item.title, hit.titleIndices)" :key="k">
                  <mark v-if="seg.match" class="bg-transparent text-accent underline decoration-accent/40 underline-offset-2">{{ seg.text }}</mark>
                  <template v-else>{{ seg.text }}</template>
                </template>
              </span>
              <span v-if="hit.item.description" class="block truncate text-xs text-muted">{{ hit.item.description }}</span>
            </span>
            <span
              v-if="indexOf(hit) === selected && hit.item.supportsNewTab"
              class="hidden shrink-0 text-[11px] text-muted sm:inline"
            >{{ mod }}↵ new tab</span>
            <Kbd v-if="hit.item.shortcut" :accelerator="hit.item.shortcut" size="xs" />
          </div>
        </section>

        <div v-if="groups.length === 0" class="flex flex-col items-center gap-1 px-3 py-12 text-center" data-testid="palette-empty">
          <p class="text-[13px] font-semibold text-fg">{{ emptyText.title }}</p>
          <p class="text-xs text-muted">{{ emptyText.hint }}</p>
        </div>
      </div>

      <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-app-alt/60 px-4 py-2 text-[11px] text-muted">
        <button type="button" class="flex items-center gap-1 hover:text-fg" @mousedown.prevent @click="showAll('snippets')">
          <Hash :size="12" /> snippets
        </button>
        <button type="button" class="flex items-center gap-1 hover:text-fg" @mousedown.prevent @click="showAll('folders')">
          <Slash :size="12" /> folders
        </button>
        <button type="button" class="flex items-center gap-1 hover:text-fg" @mousedown.prevent @click="showAll('commands')">
          <ChevronRight :size="12" /> commands
        </button>
        <span class="flex-1" />
        <span class="flex items-center gap-1"><Kbd :keys="['↑', '↓']" size="xs" /> move</span>
        <span class="flex items-center gap-1"><Kbd :keys="['↵']" size="xs" /> open</span>
        <span class="flex items-center gap-1"><Kbd :keys="[mod, '↵']" size="xs" /> new tab</span>
      </div>
    </div>
  </Modal>
</template>
