<script setup lang="ts">
import { computed } from 'vue'
import { Bookmark, FolderOpen, History, Moon, Play, Settings, Sun } from 'lucide-vue-next'
import type { ThemeDefinition } from '@/themes'
import { highlightPhpLines } from '../history/highlight'
import { previewPalette } from './themeJson'

/**
 * Miniature Tinkerbox window painted entirely with one theme's colors (independent of the applied theme): title bar,
 * icon sidebar, editor with highlighted code, an output card and the three button styles.
 */
const props = defineProps<{ theme: ThemeDefinition }>()

const SAMPLE = `// Who signed up most recently?
$recent = User::where('active', true)
    ->latest()
    ->take(3)
    ->get();

$names = $recent->pluck('name'); //?
echo "Found {$recent->count()} users";`

const lines = highlightPhpLines(SAMPLE)
const palette = computed(() => previewPalette(props.theme))
const v = computed(() => props.theme.vars)
</script>

<template>
  <div class="flex h-full flex-col gap-4">
    <div class="flex items-center gap-2">
      <h3 class="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">{{ theme.name }}</h3>
      <span class="inline-flex items-center gap-1 rounded-full bg-fg/8 px-2 py-0.5 text-[11px] font-semibold text-muted">
        <component :is="theme.dark ? Moon : Sun" :size="11" /> {{ theme.dark ? 'Dark' : 'Light' }}
      </span>
      <span v-if="theme.custom" class="rounded-full bg-accent/14 px-2 py-0.5 text-[11px] font-semibold text-accent">Custom</span>
    </div>

    <!-- Window -->
    <div
      class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border shadow-lg shadow-black/10"
      :style="{ borderColor: v['--tw-border'], background: v['--tw-bg'], color: v['--tw-text'] }"
      data-testid="theme-preview"
    >
      <div class="flex h-7 shrink-0 items-center gap-1.5 px-3" :style="{ background: v['--tw-titlebar-bg'] }">
        <span class="size-2.5 rounded-full" :style="{ background: v['--tw-danger'] }" />
        <span class="size-2.5 rounded-full" :style="{ background: v['--tw-warning'] }" />
        <span class="size-2.5 rounded-full" :style="{ background: v['--tw-success'] }" />
        <span class="flex-1 text-center text-[11px] font-medium" :style="{ color: v['--tw-text-muted'] }">Tinkerbox - Preview</span>
      </div>
      <div class="flex min-h-0 flex-1">
        <div class="flex w-9 shrink-0 flex-col items-center gap-2 pt-2" :style="{ background: v['--tw-sidebar-bg'] }">
          <span class="flex size-6 items-center justify-center rounded-md" :style="{ background: v['--tw-accent'], color: v['--tw-accent-fg'] }">
            <Play :size="12" />
          </span>
          <component :is="icon" v-for="(icon, i) in [FolderOpen, History, Bookmark]" :key="i" :size="14" :style="{ color: v['--tw-text-muted'] }" />
          <Settings :size="14" class="mt-auto mb-2" :style="{ color: v['--tw-text-muted'] }" />
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-0 md:flex-row">
          <!-- Editor -->
          <div class="min-w-0 flex-[1.4] overflow-hidden py-2 font-mono text-[11px] leading-[1.7]" :style="{ background: palette.editorBg, color: palette.editorFg }">
            <div
              v-for="(line, i) in lines"
              :key="i"
              class="flex pr-2 whitespace-pre"
              :style="i === 6 ? { background: palette.lineHighlight } : undefined"
            >
              <span class="w-7 shrink-0 pr-2 text-right select-none" :style="{ color: palette.lineNumber }">{{ i + 1 }}</span>
              <span class="min-w-0 overflow-hidden text-ellipsis whitespace-pre">
                <span v-for="(t, k) in line" :key="k" :style="{ color: palette.tokens[t.type], fontStyle: t.type === 'comment' ? 'italic' : undefined }">{{ t.text }}</span>
                <span
                  v-if="i === 6"
                  class="ml-2 rounded px-1 py-px text-[10px]"
                  :style="{ background: v['--tw-accent-soft'], color: v['--tw-accent'] }"
                  >["Ada", "Linus", "Grace"]</span
                >
              </span>
            </div>
          </div>
          <!-- Output -->
          <div class="min-w-0 flex-1 p-2.5" :style="{ background: v['--tw-bg-alt'], borderLeft: `1px solid ${v['--tw-border']}` }">
            <div class="rounded-lg border p-2 font-mono text-[10.5px] leading-relaxed" :style="{ background: v['--tw-surface'], borderColor: v['--tw-border'] }">
              <div class="mb-1 font-sans text-[10px] font-semibold" :style="{ color: v['--tw-text-muted'] }">Line 7</div>
              <div>
                <span :style="{ color: v['--tw-code-class'] }">Collection</span>
                <span :style="{ color: v['--tw-code-meta'] }"> #412</span> {
              </div>
              <div class="pl-3">
                <span :style="{ color: v['--tw-code-key'] }">0</span> =>
                <span :style="{ color: v['--tw-code-string'] }">"Ada"</span>
              </div>
              <div class="pl-3">
                <span :style="{ color: v['--tw-code-key'] }">count</span>:
                <span :style="{ color: v['--tw-code-number'] }">3</span>
              </div>
              <div class="pl-3">
                <span :style="{ color: v['--tw-code-key'] }">admin</span>:
                <span :style="{ color: v['--tw-code-bool'] }">false</span>
              </div>
              <div>}</div>
            </div>
            <div class="mt-2 rounded-md px-2 py-1 text-[10.5px]" :style="{ background: v['--tw-hover'], color: v['--tw-text'] }">Found 3 users</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Buttons in the theme's chrome colors -->
    <div class="flex flex-wrap items-center gap-2 rounded-xl border p-3" :style="{ background: v['--tw-surface'], borderColor: v['--tw-border'] }">
      <span class="h-8 rounded-lg px-3.5 text-[13px] leading-8 font-semibold" :style="{ background: v['--tw-accent'], color: v['--tw-accent-fg'] }">Primary</span>
      <span
        class="h-8 rounded-lg border px-3.5 text-[13px] leading-[30px] font-semibold"
        :style="{ background: v['--tw-accent-soft'], color: v['--tw-accent'], borderColor: v['--tw-accent'] }"
        >Secondary</span
      >
      <span
        class="h-8 rounded-lg border px-3.5 text-[13px] leading-[30px] font-semibold"
        :style="{ background: v['--tw-surface'], color: v['--tw-text'], borderColor: v['--tw-border'] }"
        >Default</span
      >
      <span class="ml-auto text-xs" :style="{ color: v['--tw-text-muted'] }">Muted text</span>
    </div>
  </div>
</template>
