<script setup lang="ts">
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue'
import { Copy, Eye, Pencil, Plus, Rocket, X, XCircle } from 'lucide-vue-next'
import type { TabState } from '@shared/types'
import { useConnectionsStore } from '../../stores/connections'
import { useSettingsStore } from '../../stores/settings'
import { useTabsStore } from '../../stores/tabs'
import { useUiStore, type MenuItem } from '../../stores/ui'
import IconButton from '../common/IconButton.vue'
import Spinner from '../common/Spinner.vue'

/**
 * Tab strip: click activates, middle-click closes, double-click renames inline (session only), right-click opens the
 * tab menu, drag & drop reorders. "+" opens a new tab.
 *
 * Keyboard (roving focus, one Tab stop): ←/→/Home/End move the focus, Enter/Space activates, F2 renames, Delete
 * closes, ⇧←/⇧→ move the tab, the context-menu key or ⇧F10 opens the tab menu.
 */
const tabs = useTabsStore()
const ui = useUiStore()
const settings = useSettingsStore()
const connections = useConnectionsStore()

const strip = ref<HTMLElement | null>(null)
const renameInput = ref<HTMLInputElement | null>(null)
const renameValue = ref('')
const dragIndex = ref<number | null>(null)
const dropIndex = ref<number | null>(null)
/** Tab holding the keyboard focus (roving tabindex); null = the active tab. */
const focusId = ref<string | null>(null)

const list = computed(() => tabs.tabs)

function setRenameInput(el: Element | ComponentPublicInstance | null): void {
  renameInput.value = el instanceof HTMLInputElement ? el : null
}

function badgeColor(tab: TabState): string | undefined {
  return tab.kind === 'code' ? connections.color(tab.connectionId) : undefined
}

function close(tab: TabState): void {
  void tabs.closeTab(tab.id)
}

function onMouseDown(event: MouseEvent, tab: TabState): void {
  // Middle / right click: keep the focus where it is (the context menu hands it back when it closes).
  if (event.button === 1 || event.button === 2) event.preventDefault()
  else if (event.button === 0) tabs.activate(tab.id)
}

function onAuxClick(event: MouseEvent, tab: TabState): void {
  if (event.button === 1) {
    event.preventDefault()
    close(tab)
  }
}

function startRename(tab: TabState): void {
  ui.startRename(tab.id)
}

watch(
  () => ui.renamingTabId,
  async (id) => {
    if (!id) return
    renameValue.value = tabs.displayTitle(id)
    tabs.activate(id)
    await nextTick()
    renameInput.value?.focus()
    renameInput.value?.select()
  }
)

function commitRename(): void {
  const id = ui.renamingTabId
  if (!id) return
  tabs.renameTab(id, renameValue.value)
  ui.startRename(null)
}

function cancelRename(): void {
  ui.startRename(null)
}

function onRenameKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    commitRename()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    cancelRename()
  }
}

function openMenu(event: MouseEvent | { x: number; y: number }, tab: TabState, index: number): void {
  const items: MenuItem[] = [
    { label: 'Close', icon: X, shortcut: settings.accelerator('closeTab'), disabled: !tabs.canClose(tab), action: () => tabs.closeTab(tab.id) },
    { label: 'Close Others', disabled: list.value.length < 2, action: () => tabs.closeOthers(tab.id) },
    { label: 'Close to the Right', disabled: index >= list.value.length - 1, action: () => tabs.closeToRight(tab.id) },
    { label: 'Close All', icon: XCircle, action: () => tabs.closeAll() },
    { type: 'separator' },
    { label: 'Duplicate Tab', icon: Copy, shortcut: settings.accelerator('duplicateTab'), disabled: tab.kind !== 'code', action: () => void tabs.duplicateTab(tab.id) },
    { label: 'Rename Tab…', icon: Pencil, disabled: tab.kind !== 'code', action: () => startRename(tab) }
  ]
  if (tab.kind === 'code' && tab.filePath) {
    items.push({ type: 'separator' }, { label: tabs.watching[tab.id] ? 'Stop Watching File' : 'Watch File', icon: Eye, action: () => void tabs.toggleWatch(tab.id) })
  }
  ui.openContextMenu(event, items)
}

// -- keyboard ---------------------------------------------------------------------------------------------------

function tabElement(id: string): HTMLElement | null {
  return strip.value?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`) ?? null
}

async function focusTab(id: string): Promise<void> {
  focusId.value = id
  await nextTick()
  tabElement(id)?.focus()
}

function onTabKeydown(event: KeyboardEvent, tab: TabState, index: number): void {
  // Ignore keys from the inline rename input and shortcuts with modifiers (global commands).
  if (event.target !== event.currentTarget || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
  const count = list.value.length
  let action: (() => void) | null = null
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      const step = event.key === 'ArrowRight' ? 1 : -1
      if (event.shiftKey) {
        const to = index + step
        action = () => {
          if (to < 0 || to >= count) return
          tabs.moveTab(index, to)
          void focusTab(tab.id)
        }
      } else {
        action = () => void focusTab(list.value[(index + step + count) % count].id)
      }
      break
    }
    case 'Home':
    case 'End':
      action = () => void focusTab(list.value[event.key === 'Home' ? 0 : count - 1].id)
      break
    case 'Enter':
    case ' ':
      action = () => tabs.activate(tab.id)
      break
    case 'F2':
      if (!event.shiftKey && tab.kind === 'code') action = () => startRename(tab)
      break
    case 'Delete':
    case 'Backspace':
      if (tabs.canClose(tab)) action = () => void closeFromKeyboard(tab)
      break
    case 'ContextMenu':
      action = () => openMenuFromKeyboard(tab, index)
      break
    case 'F10':
      if (event.shiftKey) action = () => openMenuFromKeyboard(tab, index)
      break
  }
  if (!action) return
  event.preventDefault()
  event.stopPropagation()
  action()
}

async function closeFromKeyboard(tab: TabState): Promise<void> {
  if (!(await tabs.closeTab(tab.id))) return
  focusId.value = null
  await nextTick()
  if (tabs.activeTabId) tabElement(tabs.activeTabId)?.focus()
}

function openMenuFromKeyboard(tab: TabState, index: number): void {
  const rect = tabElement(tab.id)?.getBoundingClientRect()
  openMenu(rect ? { x: rect.left + 8, y: rect.bottom } : { x: 0, y: 0 }, tab, index)
}

// Clicks, shortcuts and closing tabs move the active tab: the roving focus follows it again.
watch(
  () => tabs.activeTabId,
  () => {
    focusId.value = null
  }
)

watch(
  () => list.value.map((t) => t.id),
  (ids) => {
    if (focusId.value && !ids.includes(focusId.value)) focusId.value = null
  }
)

// -- drag & drop ------------------------------------------------------------------------------------------------

function onDragStart(event: DragEvent, index: number): void {
  dragIndex.value = index
  event.dataTransfer?.setData('application/x-tinkerbox-tab', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(event: DragEvent, index: number): void {
  if (dragIndex.value === null) return
  event.preventDefault()
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const after = event.clientX > rect.left + rect.width / 2
  dropIndex.value = after ? index + 1 : index
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  const from = dragIndex.value
  const to = dropIndex.value
  dragIndex.value = dropIndex.value = null
  if (from === null || to === null) return
  tabs.moveTab(from, to > from ? to - 1 : to)
}

function onDragEnd(): void {
  dragIndex.value = dropIndex.value = null
}

// Keep the active tab visible.
watch(
  () => tabs.activeTabId,
  async (id) => {
    await nextTick()
    strip.value?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
)
</script>

<template>
  <div class="flex h-10 shrink-0 items-end gap-1 pr-2" role="tablist" aria-label="Tabs">
    <div ref="strip" class="scrollbar-none flex min-w-0 items-end gap-1 overflow-x-auto" @dragover.prevent @drop="onDrop">
      <div
        v-for="(tab, index) in list"
        :key="tab.id"
        role="tab"
        :data-tab-id="tab.id"
        :aria-selected="tab.id === tabs.activeTabId"
        :tabindex="(focusId ?? tabs.activeTabId) === tab.id ? 0 : -1"
        :draggable="ui.renamingTabId !== tab.id"
        :title="tab.filePath ?? tabs.displayTitle(tab)"
        :class="[
          'group relative flex h-[34px] w-[210px] min-w-[112px] shrink items-center gap-2 rounded-t-xl pr-1.5 pl-3 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-inset',
          tab.id === tabs.activeTabId
            ? [
                'font-semibold text-fg shadow-[0_-1px_0_var(--tw-border),1px_0_0_var(--tw-border),-1px_0_0_var(--tw-border)]',
                tab.kind === 'welcome' ? 'bg-app-alt' : 'bg-editor'
              ]
            : 'text-muted hover:bg-hover hover:text-fg',
          dragIndex === index ? 'opacity-50' : ''
        ]"
        @mousedown="onMouseDown($event, tab)"
        @auxclick="onAuxClick($event, tab)"
        @dblclick="tab.kind === 'code' && startRename(tab)"
        @contextmenu.prevent="openMenu($event, tab, index)"
        @keydown="onTabKeydown($event, tab, index)"
        @focus="focusId = tab.id"
        @dragstart="onDragStart($event, index)"
        @dragover="onDragOver($event, index)"
        @dragend="onDragEnd"
      >
        <span
          v-if="dropIndex === index && dragIndex !== null"
          class="absolute top-1.5 bottom-1.5 -left-[3px] w-0.5 rounded bg-accent"
        />
        <span
          v-if="dropIndex === index + 1 && dragIndex !== null && index === list.length - 1"
          class="absolute top-1.5 -right-[3px] bottom-1.5 w-0.5 rounded bg-accent"
        />
        <Spinner v-if="tabs.isRunning(tab.id)" :size="12" class="text-accent" />
        <Rocket v-else-if="tab.kind === 'welcome'" :size="14" class="shrink-0 text-accent" />
        <span
          v-else-if="badgeColor(tab)"
          class="size-2 shrink-0 rounded-full"
          :style="{ backgroundColor: badgeColor(tab) }"
          :title="connections.label(tab.connectionId)"
        />
        <Eye v-if="tabs.watching[tab.id]" :size="13" class="shrink-0 text-accent" />
        <input
          v-if="ui.renamingTabId === tab.id"
          :ref="setRenameInput"
          v-model="renameValue"
          class="h-6 min-w-0 flex-1 rounded-md border border-accent bg-input px-1.5 text-[13px] font-semibold text-fg outline-none"
          @keydown="onRenameKey"
          @blur="commitRename"
          @mousedown.stop
          @dblclick.stop
        />
        <span v-else class="min-w-0 flex-1 truncate">{{ tabs.displayTitle(tab) }}</span>
        <button
          v-if="tabs.canClose(tab)"
          type="button"
          tabindex="-1"
          :aria-label="`Close ${tabs.displayTitle(tab)}`"
          :class="[
            'relative flex size-5 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-fg/10 hover:text-fg',
            tab.id === tabs.activeTabId || tab.dirty ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          ]"
          @mousedown.stop
          @click.stop="close(tab)"
        >
          <span v-if="tab.dirty" class="size-2 rounded-full bg-accent group-hover:hidden" />
          <X :size="13" :stroke-width="2.25" :class="tab.dirty ? 'hidden group-hover:block' : ''" />
        </button>
      </div>
    </div>
    <IconButton :icon="Plus" label="New tab" command="newTab" size="sm" class="mb-[3px]" @click="tabs.newTab()" />
    <div class="drag-region h-full min-w-6 flex-1" />
  </div>
</template>
