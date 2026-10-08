<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, CircleCheck, Copy, ExternalLink, Globe, KeyRound, Lock, Settings, Share2 } from 'lucide-vue-next'
import { api } from '../../../api'
import { useConnectionsStore } from '../../../stores/connections'
import { useSettingsStore } from '../../../stores/settings'
import { useUiStore } from '../../../stores/ui'
import { pluralize } from '../../../utils/format'
import Button from '../../common/Button.vue'
import Modal from '../../common/Modal.vue'
import SegmentedControl from '../../common/SegmentedControl.vue'
import TextInput from '../../common/TextInput.vue'
import type { Segment } from '../../common/types'
import { GITHUB_TOKEN_URL, codePreview, hasGithubToken, isShareable } from './shareUtils'

/**
 * Share the editor code as a GitHub Gist (no hosted share service needed). Needs a GitHub token with
 * the `gist` scope (Settings → Advanced).
 */
const props = withDefaults(defineProps<{ code: string; connectionId?: string | null }>(), { connectionId: null })
const emit = defineEmits<{ close: [result?: unknown] }>()

const settings = useSettingsStore()
const connections = useConnectionsStore()
const ui = useUiStore()

const description = ref('')
const visibility = ref<'secret' | 'public'>('secret')
const sharing = ref(false)
const error = ref<string | null>(null)
const url = ref<string | null>(null)

// A typed description is unsaved input until the gist exists: other panels open on top instead of discarding it.
watch(
  () => description.value.trim() !== '' && url.value === null,
  (dirty) => ui.setModalDirty('share', dirty),
  { immediate: true }
)
const copied = ref(false)

const tokenConfigured = computed(() => hasGithubToken(settings.settings.github?.token))
const shareable = computed(() => isShareable(props.code))
const preview = computed(() => codePreview(props.code))
const projectLabel = computed(() => connections.label(props.connectionId))

const VISIBILITY: ReadonlyArray<Segment<'secret' | 'public'>> = [
  { value: 'secret', label: 'Secret', icon: Lock, title: 'Unlisted — only people with the link can see it' },
  { value: 'public', label: 'Public', icon: Globe, title: 'Listed on your GitHub profile and searchable' }
]

async function share(): Promise<void> {
  if (sharing.value || !shareable.value) return
  sharing.value = true
  error.value = null
  try {
    url.value = await api.invoke('share:gist', props.code, description.value.trim(), visibility.value === 'public')
  } catch (err) {
    error.value = api.errorText(err)
  } finally {
    sharing.value = false
  }
}

async function copyUrl(): Promise<void> {
  if (!url.value) return
  try {
    await api.copy(url.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch (err) {
    ui.error(err, 'Could not copy the link')
  }
}

function openUrl(target: string): void {
  void api.invoke('shell:openExternal', target).catch((err: unknown) => ui.error(err, 'Could not open the link'))
}

function openSettings(): void {
  void ui.openModal('settings', { page: 'advanced' })
}
</script>

<template>
  <Modal title="Share as GitHub Gist" size="md" initial-focus="[data-share-focus]" @close="emit('close', url ?? undefined)">
    <!-- No token -->
    <div v-if="!tokenConfigured" class="flex flex-col items-center gap-3 py-4 text-center" data-testid="share-no-token">
      <span class="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <KeyRound :size="22" :stroke-width="1.75" />
      </span>
      <p class="text-[15px] font-semibold text-fg">Connect GitHub to share code</p>
      <p class="max-w-sm text-[13px] leading-relaxed text-muted">
        Sharing creates a Gist on your GitHub account. Add a personal access token with the
        <span class="font-mono text-fg">gist</span> scope in <span class="font-semibold text-fg">Settings → Advanced</span> — it is
        stored encrypted on this computer and only used to create gists.
      </p>
      <div class="mt-1 flex flex-wrap items-center justify-center gap-2" data-share-focus>
        <Button variant="primary" :icon="Settings" @click="openSettings">Open Settings → Advanced</Button>
        <Button variant="ghost" :icon="ExternalLink" @click="openUrl(GITHUB_TOKEN_URL)">Create a token on GitHub</Button>
      </div>
    </div>

    <!-- Shared -->
    <div v-else-if="url" class="space-y-4" data-testid="share-done">
      <div class="flex items-center gap-3">
        <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-success/14 text-success">
          <CircleCheck :size="20" />
        </span>
        <div>
          <p class="text-[14px] font-semibold text-fg">Your gist is ready</p>
          <p class="text-xs text-muted">
            {{ visibility === 'public' ? 'Public gist — listed on your GitHub profile.' : 'Secret gist — anyone with the link can view it.' }}
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2" data-share-focus>
        <div class="min-w-0 flex-1">
          <TextInput :model-value="url" readonly monospace aria-label="Gist URL" />
        </div>
        <Button :icon="copied ? Check : Copy" @click="copyUrl">{{ copied ? 'Copied' : 'Copy' }}</Button>
        <Button variant="secondary" :icon="ExternalLink" @click="openUrl(url)">Open</Button>
      </div>
    </div>

    <!-- Form -->
    <div v-else class="space-y-4" data-testid="share-form">
      <div class="space-y-1.5" data-share-focus>
        <label class="block text-[13px] font-semibold text-fg">Description</label>
        <TextInput v-model="description" placeholder="Shared from Tinkerbox" :disabled="sharing" @enter="share" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-[13px] font-semibold text-fg">Visibility</p>
          <p class="text-xs text-muted">
            {{ visibility === 'public' ? 'Listed on your profile and searchable.' : 'Unlisted — only people with the link can see it.' }}
          </p>
        </div>
        <SegmentedControl v-model="visibility" :options="VISIBILITY" />
      </div>
      <div>
        <div class="mb-1.5 flex items-center justify-between text-xs text-muted">
          <span class="font-semibold text-fg">tinkerbox.php</span>
          <span>{{ pluralize(preview.total, 'line') }} · {{ projectLabel }}</span>
        </div>
        <pre
          v-if="shareable"
          class="selectable max-h-[220px] overflow-auto rounded-lg border border-line bg-editor px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-fg"
        >{{ preview.lines.join('\n') }}</pre>
        <p v-else class="rounded-lg border border-dashed border-line px-3 py-5 text-center text-[13px] text-muted">
          There is no code to share — write something in the editor first.
        </p>
        <p v-if="preview.more > 0" class="mt-1 text-[11px] text-muted">+ {{ pluralize(preview.more, 'more line') }}</p>
      </div>
      <p v-if="error" class="rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <template v-if="!tokenConfigured">
        <Button size="sm" @click="emit('close')">Close</Button>
      </template>
      <template v-else-if="url">
        <Button variant="primary" size="sm" @click="emit('close', url)">Done</Button>
      </template>
      <template v-else>
        <Button size="sm" variant="ghost" :disabled="sharing" @click="emit('close')">Cancel</Button>
        <Button variant="primary" size="sm" :icon="Share2" :loading="sharing" :disabled="!shareable" @click="share">Share</Button>
      </template>
    </template>
  </Modal>
</template>
