<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Globe, FolderClosed, Save } from 'lucide-vue-next'
import type { Snippet } from '@shared/types'
import { useConnectionsStore } from '@/stores/connections'
import { useSnippetsStore } from '@/stores/snippets'
import { useUiStore } from '@/stores/ui'
import { modKeyLabel } from '@/utils/platform'
import Button from '../../common/Button.vue'
import Modal from '../../common/Modal.vue'
import SegmentedControl from '../../common/SegmentedControl.vue'
import TextInput from '../../common/TextInput.vue'
import type { Segment } from '../../common/types'
import { snippetProjectId } from './snippets'

/**
 * Create (no `snippet`) or edit a user snippet: label, description, code and whether it belongs to a project (opening
 * it then switches the tab to that project) or is global. Only real projects can be picked: a snippet written in a
 * tab without one (sandbox / plain PHP) is global, so opening it never pulls a project tab away from its project.
 * Closes with the saved snippet.
 */
const props = defineProps<{ code: string; connectionId: string | null; snippet?: Snippet }>()
const emit = defineEmits<{ close: [result?: Snippet] }>()

const snippets = useSnippetsStore()
const connections = useConnectionsStore()
const ui = useUiStore()
const mod = modKeyLabel()

const editing = computed(() => !!props.snippet)
const name = ref(props.snippet?.name ?? '')
const description = ref(props.snippet?.description ?? '')
const code = ref(props.snippet?.code ?? props.code)
const touched = ref(false)
const saving = ref(false)

/**
 * Real project behind the current tab: null for the implicit sandbox / plain PHP connections and for a Default
 * Working Directory without a stored entry.
 */
const currentProject = computed(() => snippetProjectId({ connectionId: connections.effectiveId(props.connectionId) }))
/** Project the edited snippet is assigned to (legacy sandbox / PHP assignments count as global). */
const snippetProject = props.snippet ? snippetProjectId(props.snippet) : null

const assignmentOptions = computed<Segment<string>[]>(() => {
  const options: Segment<string>[] = [{ value: '', label: 'Global', icon: Globe, title: 'Available in every project' }]
  const seen = new Set<string>([''])
  for (const id of [snippetProject ?? '', currentProject.value ?? '']) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    options.push({ value: id, label: connections.label(id), icon: FolderClosed, title: `Opening the snippet switches the tab to ${connections.label(id)}` })
  }
  return options
})

const assignment = ref<string>(props.snippet ? (snippetProject ?? '') : (currentProject.value ?? ''))
const initialAssignment = assignment.value

/** Unsaved input: opening another panel (⌘B, ⌘Y …) stacks on top instead of discarding the draft. */
const dirty = computed(
  () =>
    name.value.trim() !== (props.snippet?.name ?? '').trim() ||
    description.value.trim() !== (props.snippet?.description ?? '').trim() ||
    code.value !== (props.snippet?.code ?? props.code) ||
    assignment.value !== initialAssignment
)
watch(dirty, (value) => ui.setModalDirty('snippetSave', value), { immediate: true })

const nameError = computed(() => (touched.value && name.value.trim() === '' ? 'Give the snippet a label.' : null))
const codeError = computed(() => (touched.value && code.value.trim() === '' ? 'There is no code to save.' : null))

async function save(): Promise<void> {
  touched.value = true
  if (nameError.value || codeError.value || saving.value) return
  saving.value = true
  try {
    const saved = await snippets.save({
      id: props.snippet?.id,
      name: name.value,
      description: description.value,
      code: code.value,
      connectionId: assignment.value || null
    })
    ui.toast({ level: 'success', key: 'snippet-saved', timeout: 3000, message: editing.value ? `Updated “${saved.name}”.` : `Saved “${saved.name}” to your snippets.` })
    emit('close', saved)
  } catch (err) {
    ui.error(err, 'Could not save the snippet')
  } finally {
    saving.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault()
    void save()
  }
}
</script>

<template>
  <Modal :title="editing ? 'Edit Snippet' : 'Save as Snippet'" size="md" initial-focus="[data-snippet-name]" @close="$emit('close')">
    <form class="flex flex-col gap-4" @submit.prevent="save" @keydown="onKeydown">
      <div data-snippet-name>
        <label class="mb-1.5 block text-xs font-semibold text-muted">Label</label>
        <TextInput v-model="name" placeholder="e.g. Latest users" :error="nameError" autofocus @enter="save" />
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-semibold text-muted">Description <span class="font-normal">(optional)</span></label>
        <textarea
          v-model="description"
          rows="2"
          placeholder="What does it do?"
          class="no-drag block w-full resize-none rounded-lg border border-line bg-input px-2.5 py-1.5 text-[13px] text-fg shadow-xs outline-none placeholder:text-muted/80 hover:border-accent/40 focus:border-accent focus:ring-3 focus:ring-accent/15"
        />
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-semibold text-muted">Code</label>
        <textarea
          v-model="code"
          rows="8"
          spellcheck="false"
          :class="[
            'no-drag block w-full resize-y rounded-lg border bg-editor px-3 py-2 font-mono text-[12.5px] leading-relaxed text-fg shadow-xs outline-none focus:ring-3',
            codeError ? 'border-danger focus:ring-danger/15' : 'border-line hover:border-accent/40 focus:border-accent focus:ring-accent/15'
          ]"
        />
        <p v-if="codeError" class="mt-1 text-xs text-danger">{{ codeError }}</p>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-semibold text-muted">Available in</label>
        <SegmentedControl v-model="assignment" :options="assignmentOptions" />
        <p class="mt-1.5 text-xs text-muted">
          <template v-if="assignment">Opening this snippet switches the tab to {{ connections.label(assignment) }}.</template>
          <template v-else>Global snippets open in whatever project the tab uses.</template>
        </p>
      </div>
    </form>
    <template #footer>
      <span class="mr-auto text-xs text-muted">{{ mod }}↵ saves</span>
      <Button variant="ghost" @click="$emit('close')">Cancel</Button>
      <Button variant="primary" :icon="Save" :loading="saving" data-testid="snippet-save" @click="save">{{ editing ? 'Save changes' : 'Save snippet' }}</Button>
    </template>
  </Modal>
</template>
