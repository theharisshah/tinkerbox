<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Sparkles } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import Spinner from '../../../common/Spinner.vue'
import { renderChangelog } from '../changelog'

const app = useAppStore()
const changelog = renderChangelog()
const version = computed(() => app.info?.version ?? '')

onMounted(() => {
  if (!app.info) void app.loadInfo()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-center gap-4 rounded-xl border border-line bg-app-alt/50 px-4 py-3.5">
      <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent shadow-sm shadow-accent/30">
        <Sparkles :size="19" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-[13px] font-semibold text-fg" data-testid="app-version">
          <template v-if="version">You are running Tinkerbox {{ version }}</template>
          <span v-else class="inline-flex items-center gap-2 text-muted"><Spinner :size="13" /> Reading the version…</span>
        </p>
        <p class="text-xs text-muted">This build does not update itself. Install a newer build to upgrade; your settings, snippets and history carry over.</p>
      </div>
    </div>

    <section>
      <h2 class="mb-3 px-1 text-[11px] font-bold tracking-wider text-muted uppercase">What's new</h2>
      <!-- Sanitized with DOMPurify (CHANGELOG.md from the repository). -->
      <article class="tw-changelog selectable rounded-xl border border-line bg-surface px-5 py-4 text-[13px] leading-relaxed text-fg" v-html="changelog" />
    </section>
  </div>
</template>

<style scoped>
.tw-changelog :deep(h2) {
  margin: 0 0 0.5rem;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.tw-changelog :deep(h2:not(:first-child)) {
  margin-top: 1.5rem;
}
.tw-changelog :deep(h3) {
  margin: 1rem 0 0.35rem;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--tw-accent);
}
.tw-changelog :deep(ul) {
  margin: 0;
  padding-left: 1.1rem;
  list-style: disc;
}
.tw-changelog :deep(li) {
  margin: 0.2rem 0;
}
.tw-changelog :deep(li::marker) {
  color: var(--tw-text-muted);
}
.tw-changelog :deep(p) {
  margin: 0.4rem 0;
}
.tw-changelog :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 0.05em 0.3em;
  border-radius: 4px;
  background: color-mix(in srgb, var(--tw-text) 7%, transparent);
}
.tw-changelog :deep(a) {
  color: var(--tw-accent);
  text-decoration: underline;
}
</style>
