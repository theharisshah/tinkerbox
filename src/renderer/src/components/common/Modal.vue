<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { focusableIn } from '../../utils/position'
import { isTopModal, pushModal, removeModal } from './modalStack'

/**
 * Modal dialog: dimmed backdrop, rounded themed card, header with title + thin accent rule + close X, ESC to close,
 * focus trap, focus restore. Slots: default (body), `title`, `actions` (header, left of ×), `header` (replaces the
 * whole header), `footer`. Emits `close` (ESC, ×, backdrop click).
 */
const props = withDefaults(
  defineProps<{
    title?: string
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
    /** Fixed panel height (e.g. "80vh") for two-pane layouts; default: fit content. */
    height?: string
    position?: 'center' | 'top'
    closable?: boolean
    closeOnBackdrop?: boolean
    padded?: boolean
    hideHeader?: boolean
    /** CSS selector of the element to focus first. */
    initialFocus?: string
    bodyClass?: string
    ariaLabel?: string
  }>(),
  {
    title: undefined,
    size: 'md',
    height: undefined,
    position: 'center',
    closable: true,
    closeOnBackdrop: true,
    padded: true,
    hideHeader: false,
    initialFocus: undefined,
    bodyClass: '',
    ariaLabel: undefined
  }
)

const emit = defineEmits<{ close: [] }>()

const id = Symbol('modal')
const panel = ref<HTMLElement | null>(null)
let previouslyFocused: HTMLElement | null = null
let pressedOnBackdrop = false

const widthClass = computed(
  () =>
    ({
      sm: 'w-[min(420px,calc(100vw-32px))]',
      md: 'w-[min(580px,calc(100vw-32px))]',
      lg: 'w-[min(780px,calc(100vw-48px))]',
      xl: 'w-[min(1040px,calc(100vw-48px))]',
      full: 'w-[calc(100vw-48px)]'
    })[props.size]
)

const panelStyle = computed(() => {
  const maxHeight = props.position === 'top' ? 'calc(100vh - 120px)' : 'calc(100vh - 48px)'
  if (props.size === 'full') return { height: props.height ?? 'calc(100vh - 48px)', maxHeight }
  return props.height ? { height: props.height, maxHeight } : { maxHeight }
})

function close(): void {
  if (props.closable) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (!isTopModal(id)) return
  if (event.key === 'Escape') {
    if (event.defaultPrevented || event.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key === 'Tab' && panel.value) {
    const items = focusableIn(panel.value)
    if (items.length === 0) {
      event.preventDefault()
      panel.value.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement as HTMLElement | null
    const inside = !!active && panel.value.contains(active)
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault()
      first.focus()
    }
  }
}

function onBackdropDown(event: MouseEvent): void {
  pressedOnBackdrop = event.target === event.currentTarget
}

function onBackdropUp(event: MouseEvent): void {
  if (pressedOnBackdrop && event.target === event.currentTarget && props.closeOnBackdrop) close()
  pressedOnBackdrop = false
}

onMounted(async () => {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  pushModal(id)
  window.addEventListener('keydown', onKeydown)
  await nextTick()
  const root = panel.value
  if (!root) return
  const initial = props.initialFocus ? root.querySelector<HTMLElement>(props.initialFocus) : null
  const target =
    (initial ? (focusableIn(initial)[0] ?? initial) : null) ??
    root.querySelector<HTMLElement>('[autofocus]') ??
    focusableIn(root).find((el) => !el.dataset.modalClose) ??
    root
  target.focus({ preventScroll: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  removeModal(id)
  if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true })
})

defineExpose({ panel })
</script>

<template>
  <Teleport to="body">
    <div
      :class="[
        'fixed inset-0 z-[400] flex justify-center bg-overlay backdrop-blur-[1.5px]',
        position === 'top' ? 'items-start pt-[12vh]' : 'items-center'
      ]"
      @mousedown="onBackdropDown"
      @mouseup="onBackdropUp"
    >
      <Transition name="tw-pop" appear>
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-label="ariaLabel ?? title"
          tabindex="-1"
          :class="[
            'flex flex-col overflow-hidden rounded-2xl border border-line bg-surface text-fg shadow-2xl shadow-black/25 outline-none',
            widthClass
          ]"
          :style="panelStyle"
        >
          <slot v-if="!hideHeader" name="header">
            <header class="relative flex shrink-0 items-center gap-3 px-5 pt-4 pb-3.5">
              <h2 class="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-fg">
                <slot name="title">{{ title }}</slot>
              </h2>
              <div v-if="$slots.actions" class="flex items-center gap-1.5">
                <slot name="actions" />
              </div>
              <button
                v-if="closable"
                type="button"
                data-modal-close="true"
                aria-label="Close"
                class="-mr-1.5 flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
                @click="close"
              >
                <X :size="17" />
              </button>
              <span class="pointer-events-none absolute inset-x-5 bottom-0 h-px bg-gradient-to-r from-accent/70 via-accent/25 to-transparent" />
            </header>
          </slot>
          <div :class="['min-h-0 flex-1 overflow-auto', padded ? 'px-5 py-4' : '', bodyClass]">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-app-alt/60 px-5 py-3">
            <slot name="footer" />
          </footer>
        </div>
      </Transition>
    </div>
  </Teleport>
</template>
