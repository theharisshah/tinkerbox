<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PromptOptions } from '../../stores/ui'
import Button from './Button.vue'
import Modal from './Modal.vue'
import TextInput from './TextInput.vue'

/**
 * Confirmation / prompt dialog behind `ui.confirm()` and `ui.prompt()`. Emits `close(true|false)` for
 * confirmations and `close(text|null)` for prompts.
 */
const props = withDefaults(
  defineProps<{
    title: string
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
    prompt?: Omit<PromptOptions, 'title' | 'message' | 'confirmLabel' | 'cancelLabel'>
  }>(),
  { message: undefined, confirmLabel: undefined, cancelLabel: 'Cancel', danger: false, prompt: undefined }
)

const emit = defineEmits<{ close: [result?: boolean | string | null] }>()

const value = ref(props.prompt?.value ?? '')
const touched = ref(false)
const error = computed(() => (props.prompt?.validate ? props.prompt.validate(value.value) : null))

function cancel(): void {
  emit('close', props.prompt ? null : false)
}

function confirm(): void {
  if (props.prompt) {
    touched.value = true
    if (error.value) return
    emit('close', value.value)
    return
  }
  emit('close', true)
}
</script>

<template>
  <Modal :title="title" size="sm" initial-focus="[data-confirm-focus]" @close="cancel">
    <p v-if="message" class="text-[13px] leading-relaxed text-muted">{{ message }}</p>
    <div v-if="prompt" :class="message ? 'mt-3' : ''">
      <label v-if="prompt.label" class="mb-1.5 block text-xs font-semibold text-muted">{{ prompt.label }}</label>
      <TextInput
        v-model="value"
        data-confirm-focus
        :placeholder="prompt.placeholder"
        :error="touched ? error : null"
        autofocus
        @enter="confirm"
      />
    </div>
    <template #footer>
      <Button variant="ghost" @click="cancel">{{ cancelLabel }}</Button>
      <Button :variant="danger ? 'danger' : 'primary'" :data-confirm-focus="prompt ? undefined : true" @click="confirm">
        {{ confirmLabel ?? (prompt ? 'OK' : 'Confirm') }}
      </Button>
    </template>
  </Modal>
</template>
