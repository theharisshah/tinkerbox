<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-vue-next'
import { useUiStore, type Toast } from '../../stores/ui'

/**
 * Toast host (top-end, mounted once in App.vue). Toasts auto-dismiss after their timeout (10 s default) with a
 * progress bar; hovering pauses the timer. Create them with `ui.toast({ level, title, message, actions })`.
 */
const ui = useUiStore()
const clocks = new Map<string, { startedAt: number; elapsed: number }>()

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert } as const
const TONES = {
  info: 'text-accent bg-accent-soft',
  success: 'text-success bg-success/12',
  warning: 'text-warning bg-warning/14',
  error: 'text-danger bg-danger/12'
} as const
const BARS = { info: 'bg-accent', success: 'bg-success', warning: 'bg-warning', error: 'bg-danger' } as const

function clock(t: Toast): { startedAt: number; elapsed: number } {
  let c = clocks.get(t.id)
  if (!c) {
    c = { startedAt: t.createdAt, elapsed: 0 }
    clocks.set(t.id, c)
  }
  return c
}

function pause(t: Toast): void {
  const c = clock(t)
  c.elapsed += Date.now() - c.startedAt
  ui.holdToast(t.id)
}

function resume(t: Toast): void {
  const c = clock(t)
  c.startedAt = Date.now()
  ui.releaseToast(t.id, t.timeout - c.elapsed)
}

function dismiss(t: Toast): void {
  clocks.delete(t.id)
  ui.dismissToast(t.id)
}

async function runAction(t: Toast, action: Toast['actions'][number]): Promise<void> {
  dismiss(t)
  try {
    await action.run()
  } catch (err) {
    ui.error(err)
  }
}
</script>

<template>
  <Teleport to="body">
    <!-- Bottom right, above the status bar: at the top they covered the output toolbar (Copy / Save / Clear). -->
    <div class="pointer-events-none fixed right-4 bottom-11 z-[950] flex w-[360px] max-w-[calc(100vw-32px)] flex-col justify-end gap-2">
      <TransitionGroup name="tw-toast">
        <div
          v-for="t in ui.toasts"
          :key="t.id"
          role="status"
          :aria-live="t.level === 'error' ? 'assertive' : 'polite'"
          class="group pointer-events-auto relative overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-lg shadow-black/12"
          @mouseenter="pause(t)"
          @mouseleave="resume(t)"
        >
          <div class="flex items-start gap-3 py-3 pr-9 pl-3">
            <span :class="['mt-px flex size-7 shrink-0 items-center justify-center rounded-lg', TONES[t.level]]">
              <component :is="ICONS[t.level]" :size="16" :stroke-width="2" />
            </span>
            <div class="selectable min-w-0 flex-1 pt-0.5">
              <p v-if="t.title" class="text-[13px] leading-snug font-semibold">{{ t.title }}</p>
              <p :class="['text-[13px] leading-snug break-words', t.title ? 'mt-0.5 text-muted' : '']">{{ t.message }}</p>
              <div v-if="t.actions.length" class="mt-2 flex flex-wrap gap-3">
                <button
                  v-for="(a, i) in t.actions"
                  :key="i"
                  type="button"
                  class="text-[12px] font-semibold text-accent hover:underline"
                  @click="runAction(t, a)"
                >
                  {{ a.label }}
                </button>
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            class="absolute top-2 right-2 flex size-6 items-center justify-center rounded-md text-muted opacity-70 transition hover:bg-hover hover:text-fg hover:opacity-100"
            @click="dismiss(t)"
          >
            <X :size="14" />
          </button>
          <div v-if="t.timeout > 0" class="absolute inset-x-0 bottom-0 h-[3px] bg-fg/5">
            <div
              :class="['h-full origin-left group-hover:[animation-play-state:paused]', BARS[t.level]]"
              :style="{ animation: `tw-toast-progress ${t.timeout}ms linear forwards` }"
            />
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
