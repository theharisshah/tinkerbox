<script setup lang="ts">
import { computed } from 'vue'
import { highlightParts } from './logUtils'

/** Text with case-insensitive matches of `query` wrapped in <mark>. */
const props = withDefaults(defineProps<{ text: string; query?: string }>(), { query: '' })

const parts = computed(() => highlightParts(props.text, props.query))
</script>

<template>
  <template v-for="(part, i) in parts" :key="i">
    <mark v-if="part.match" class="rounded-[3px] bg-warning/30 px-px text-fg ring-1 ring-warning/40">{{ part.text }}</mark>
    <template v-else>{{ part.text }}</template>
  </template>
</template>
