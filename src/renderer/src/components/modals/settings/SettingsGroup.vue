<script setup lang="ts">
/** Rounded group of settings rows with an optional small heading. */
defineProps<{ title?: string; description?: string }>()
</script>

<template>
  <section class="flex flex-col gap-2">
    <div v-if="title || description" class="px-1">
      <h3 v-if="title" class="text-[11px] font-bold tracking-wider text-muted uppercase">{{ title }}</h3>
      <p v-if="description" class="mt-0.5 text-xs text-muted">{{ description }}</p>
    </div>
    <div class="divide-y divide-line overflow-hidden rounded-xl border border-line bg-app-alt/50">
      <slot />
    </div>
  </section>
</template>
