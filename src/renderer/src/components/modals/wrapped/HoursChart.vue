<script setup lang="ts">
import { computed } from 'vue'
import Tooltip from '../../common/Tooltip.vue'
import { formatCount, hourRange, hourTick, peakHour } from './wrappedUtils'

/**
 * Runs per hour of the day: one series, 24 thin bars anchored to the baseline (4px rounded tops, 2px gaps), the
 * peak hour in the accent color and the rest in a lighter step of the same hue. Hover (or focus) a column for the
 * exact count; an sr-only table carries the same data.
 */
const props = defineProps<{ hours: readonly number[] }>()

const values = computed(() => Array.from({ length: 24 }, (_, h) => Math.max(0, props.hours[h] ?? 0)))
const max = computed(() => Math.max(1, ...values.value))
const peak = computed(() => peakHour(values.value))

function height(count: number): string {
  if (count <= 0) return '0%'
  return `${Math.max(3, (count / max.value) * 100)}%`
}
</script>

<template>
  <figure class="w-full max-w-[520px]" aria-label="Runs per hour of the day">
    <div class="flex h-[132px] items-end gap-[2px] border-b border-line" data-testid="hours-chart">
      <Tooltip
        v-for="(count, hour) in values"
        :key="hour"
        :text="`${hourRange(hour)} · ${formatCount(count)} ${count === 1 ? 'run' : 'runs'}`"
        placement="top"
        :delay="80"
        block
        class="h-full flex-1"
      >
        <div class="group flex h-full w-full items-end" tabindex="0" :aria-label="`${hourRange(hour)}: ${count} runs`">
          <div
            :class="[
              'w-full rounded-t-[4px] transition-[filter] group-hover:brightness-110',
              hour === peak ? 'bg-accent' : 'bg-accent/35 group-hover:bg-accent/55'
            ]"
            :style="{ height: height(count) }"
          />
        </div>
      </Tooltip>
    </div>
    <div class="relative mt-1.5 h-4 text-[10.5px] text-muted tabular" aria-hidden="true">
      <span v-for="hour in [0, 6, 12, 18]" :key="hour" class="absolute" :style="{ left: `${(hour / 24) * 100}%` }">
        {{ hourTick(hour) }}
      </span>
      <span class="absolute right-0">{{ hourTick(0) }}</span>
    </div>
    <table class="sr-only">
      <caption>Runs per hour of the day</caption>
      <tbody>
        <tr v-for="(count, hour) in values" :key="hour">
          <th scope="row">{{ hourRange(hour) }}</th>
          <td>{{ count }}</td>
        </tr>
      </tbody>
    </table>
  </figure>
</template>
