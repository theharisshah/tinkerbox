<script setup lang="ts">
import { computed, nextTick, ref, watch, type Component } from 'vue'
import { Info, Keyboard, Paintbrush, RefreshCw, SlidersHorizontal, SquareTerminal, Wrench, Zap } from 'lucide-vue-next'
import type { SettingsPage } from '@/stores/ui'
import Modal from '../../common/Modal.vue'
import AboutPage from './pages/AboutPage.vue'
import AdvancedPage from './pages/AdvancedPage.vue'
import AppearancePage from './pages/AppearancePage.vue'
import BehaviourPage from './pages/BehaviourPage.vue'
import GeneralPage from './pages/GeneralPage.vue'
import OutputPage from './pages/OutputPage.vue'
import ShortcutsPage from './pages/ShortcutsPage.vue'
import UpdatesPage from './pages/UpdatesPage.vue'

/**
 * Settings (⌘,): grouped navigation on the left, the selected page on the right. Every control writes through the
 * settings store immediately — there is no Save button.
 */
const props = withDefaults(defineProps<{ page?: SettingsPage }>(), { page: 'general' })
defineEmits<{ close: [result?: unknown] }>()

interface NavItem {
  id: SettingsPage
  label: string
  icon: Component
  /** One-line summary under the page heading. */
  intro: string
  component: Component
}

const NAV_GROUPS: NavItem[][] = [
  [
    {
      id: 'general',
      label: 'General',
      icon: SlidersHorizontal,
      intro: 'PHP, projects and what happens when Tinkerbox starts.',
      component: GeneralPage
    }
  ],
  [
    { id: 'appearance', label: 'Appearance', icon: Paintbrush, intro: 'Theme, fonts and how the window is laid out.', component: AppearancePage },
    { id: 'behaviour', label: 'Behaviour', icon: Zap, intro: 'When and how your code runs and gets formatted.', component: BehaviourPage },
    { id: 'output', label: 'Output', icon: SquareTerminal, intro: 'How results, dumps and errors are shown.', component: OutputPage }
  ],
  [
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, intro: 'Change the keyboard shortcut of any command.', component: ShortcutsPage },
    { id: 'advanced', label: 'Advanced', icon: Wrench, intro: 'Power-user options, integrations and resets.', component: AdvancedPage }
  ],
  [
    { id: 'updates', label: 'Updates', icon: RefreshCw, intro: 'Your version and the latest changes.', component: UpdatesPage },
    { id: 'about', label: 'About', icon: Info, intro: 'Versions, folders and license.', component: AboutPage }
  ]
]

const ALL = NAV_GROUPS.flat()

function valid(page: string | undefined): SettingsPage {
  return ALL.some((n) => n.id === page) ? (page as SettingsPage) : 'general'
}

const current = ref<SettingsPage>(valid(props.page))
const pane = ref<HTMLElement | null>(null)
const active = computed(() => ALL.find((n) => n.id === current.value) ?? ALL[0])

watch(
  () => props.page,
  (page) => {
    if (page) current.value = valid(page)
  }
)

watch(current, async () => {
  await nextTick()
  pane.value?.scrollTo({ top: 0 })
})

function onNavKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const index = ALL.findIndex((n) => n.id === current.value)
  const next = ALL[(index + (event.key === 'ArrowDown' ? 1 : ALL.length - 1)) % ALL.length]
  current.value = next.id
  void nextTick(() => (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(`[data-page="${next.id}"]`)?.focus())
}
</script>

<template>
  <Modal
    title="Settings"
    size="xl"
    height="min(760px, calc(100vh - 56px))"
    :padded="false"
    :initial-focus="`[data-page='${current}']`"
    @close="$emit('close')"
  >
    <div class="flex h-full min-h-0">
      <nav class="flex w-[212px] shrink-0 flex-col overflow-auto border-r border-line bg-app-alt/40 p-3" aria-label="Settings pages" @keydown="onNavKeydown">
        <template v-for="(group, gi) in NAV_GROUPS" :key="gi">
          <div v-if="gi > 0" class="mx-2 my-2 h-px bg-line" role="separator" />
          <button
            v-for="item in group"
            :key="item.id"
            type="button"
            :data-page="item.id"
            :aria-current="item.id === current ? 'page' : undefined"
            :class="[
              'flex w-full items-center gap-2.5 rounded-full px-3 py-1.5 text-left text-[13px] transition-colors',
              item.id === current ? 'bg-accent-soft font-semibold text-accent' : 'font-medium text-fg hover:bg-hover'
            ]"
            @click="current = item.id"
          >
            <component :is="item.icon" :size="15" :stroke-width="item.id === current ? 2.2 : 1.9" class="shrink-0" />
            {{ item.label }}
          </button>
        </template>
      </nav>

      <div ref="pane" class="min-w-0 flex-1 overflow-auto" data-testid="settings-pane">
        <div class="mx-auto max-w-[720px] px-8 pt-6 pb-10">
          <h1 class="text-[22px] font-bold tracking-tight text-fg">{{ active.label }}</h1>
          <p class="mt-0.5 mb-6 text-[13px] text-muted">{{ active.intro }}</p>
          <KeepAlive>
            <component :is="active.component" :key="active.id" />
          </KeepAlive>
        </div>
      </div>
    </div>
  </Modal>
</template>
