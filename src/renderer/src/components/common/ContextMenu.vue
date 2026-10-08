<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'
import { useUiStore, type MenuItem } from '../../stores/ui'
import { menuPosition } from '../../utils/position'
import Kbd from './Kbd.vue'

/**
 * Global context menu host (mounted once in App.vue). Open it with
 * `ui.openContextMenu(event, items)`. Keyboard: ↑/↓/Home/End move, Enter/Space activate, ESC closes.
 * The menu takes the focus while open and hands it back to the previously focused element (the editor, a tab …)
 * when it closes, unless the chosen action moved the focus somewhere else.
 */
const ui = useUiStore()
const menu = ref<HTMLElement | null>(null)
const pos = ref({ x: -9999, y: -9999 })
const activeIndex = ref(-1)
/** Element focused before the menu opened. */
let returnFocus: HTMLElement | null = null

type ActionItem = Extract<MenuItem, { action: () => unknown }>

const items = computed<MenuItem[]>(() => ui.contextMenu?.items ?? [])

function isAction(item: MenuItem): item is ActionItem {
  return item.type === undefined || item.type === 'item'
}

const actionable = computed(() =>
  items.value.map((item, index) => ({ item, index })).filter(({ item }) => isAction(item) && !item.disabled)
)

function close(): void {
  ui.closeContextMenu()
}

function activate(item: MenuItem): void {
  if (!isAction(item) || item.disabled) return
  close()
  try {
    const out = item.action()
    if (out instanceof Promise) out.catch((err: unknown) => ui.error(err))
  } catch (err) {
    ui.error(err)
  }
}

function move(step: number): void {
  const list = actionable.value
  if (list.length === 0) return
  const current = list.findIndex(({ index }) => index === activeIndex.value)
  const next = current < 0 ? (step > 0 ? 0 : list.length - 1) : (current + step + list.length) % list.length
  activeIndex.value = list[next].index
}

function onKeydown(event: KeyboardEvent): void {
  if (!ui.contextMenu) return
  const handled = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab']
  if (!handled.includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) move(1)
  else if (event.key === 'ArrowUp' || event.key === 'Tab') move(-1)
  else if (event.key === 'Home') activeIndex.value = actionable.value[0]?.index ?? -1
  else if (event.key === 'End') activeIndex.value = actionable.value[actionable.value.length - 1]?.index ?? -1
  else if (event.key === 'Escape') close()
  else {
    const item = items.value[activeIndex.value]
    if (item) activate(item)
  }
}

function onDocumentDown(event: MouseEvent): void {
  if (menu.value && event.target instanceof Node && menu.value.contains(event.target)) return
  close()
}

/** Give the focus back after closing — only when it is still on the (closing) menu or nowhere. */
function restoreFocus(): void {
  const target = returnFocus
  returnFocus = null
  if (!target || !target.isConnected) return
  const active = document.activeElement
  const lost = !active || active === document.body || (menu.value !== null && menu.value.contains(active))
  if (lost) target.focus({ preventScroll: true })
}

watch(
  () => ui.contextMenu,
  async (state, previous) => {
    if (!state) {
      window.removeEventListener('keydown', onKeydown, true)
      document.removeEventListener('mousedown', onDocumentDown, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      restoreFocus()
      return
    }
    if (!previous) {
      const active = document.activeElement
      returnFocus = active instanceof HTMLElement && active !== document.body ? active : null
    }
    activeIndex.value = -1
    pos.value = { x: -9999, y: -9999 }
    await nextTick()
    const el = menu.value
    if (!el) return
    pos.value = menuPosition({ x: state.x, y: state.y }, { width: el.offsetWidth, height: el.offsetHeight })
    el.focus({ preventScroll: true })
    window.addEventListener('keydown', onKeydown, true)
    document.addEventListener('mousedown', onDocumentDown, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
  }
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('mousedown', onDocumentDown, true)
  window.removeEventListener('blur', close)
  window.removeEventListener('resize', close)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.contextMenu"
      ref="menu"
      role="menu"
      tabindex="-1"
      class="fixed z-[900] min-w-[200px] max-w-[320px] rounded-xl border border-line bg-surface p-1 text-[13px] text-fg shadow-xl shadow-black/20 outline-none"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      @contextmenu.prevent
    >
      <template v-for="(item, index) in items" :key="index">
        <div v-if="item.type === 'separator'" role="separator" class="mx-2 my-1 h-px bg-line" />
        <div v-else-if="item.type === 'header'" class="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
          {{ item.label }}
        </div>
        <button
          v-else
          type="button"
          role="menuitem"
          :disabled="item.disabled"
          :class="[
            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors disabled:opacity-40',
            index === activeIndex ? (item.danger ? 'bg-danger/12 text-danger' : 'bg-accent-soft text-accent') : item.danger ? 'text-danger' : '',
            item.disabled ? '' : item.danger ? 'hover:bg-danger/12' : 'hover:bg-accent-soft hover:text-accent'
          ]"
          @mouseenter="activeIndex = index"
          @click="activate(item)"
        >
          <span class="flex w-4 shrink-0 justify-center">
            <Check v-if="item.checked" :size="14" />
            <component :is="item.icon" v-else-if="item.icon" :size="15" :stroke-width="1.9" />
          </span>
          <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
          <Kbd v-if="item.shortcut" :accelerator="item.shortcut" size="xs" subtle class="opacity-70" />
        </button>
      </template>
    </div>
  </Teleport>
</template>
