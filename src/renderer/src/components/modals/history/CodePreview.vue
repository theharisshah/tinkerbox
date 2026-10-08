<script setup lang="ts">
import { computed } from 'vue'
import { highlightPhpLines, type PhpTokenType } from './highlight'

/**
 * Read-only, highlighted PHP code (History / Snippets details). Colors come from the theme's code tokens.
 * `maxLines` truncates long code with a "… N more lines" footer.
 */
const props = withDefaults(defineProps<{ code: string; lineNumbers?: boolean; maxLines?: number; wrap?: boolean; fontSize?: number }>(), {
  lineNumbers: true,
  maxLines: 400,
  wrap: false,
  fontSize: 12.5
})

const allLines = computed(() => highlightPhpLines(props.code))
const lines = computed(() => allLines.value.slice(0, props.maxLines))
const hidden = computed(() => Math.max(0, allLines.value.length - lines.value.length))
const gutter = computed(() => String(lines.value.length).length)

const TOKEN_CLASS: Record<PhpTokenType, string> = {
  plain: '',
  comment: 'text-code-comment italic',
  string: 'text-code-string',
  number: 'text-code-number',
  keyword: 'text-code-keyword',
  variable: 'text-code-property',
  function: 'text-code-key',
  class: 'text-code-class',
  constant: 'text-code-bool',
  tag: 'text-code-meta'
}
</script>

<template>
  <pre
    class="selectable m-0 font-mono leading-[1.65] text-fg"
    :class="wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'"
    :style="{ fontSize: `${fontSize}px` }"
  ><code class="block"><span v-for="(line, i) in lines" :key="i" class="flex"><span
    v-if="lineNumbers"
    class="mr-4 shrink-0 text-right text-muted/60 select-none"
    :style="{ minWidth: `${gutter}ch` }"
    aria-hidden="true"
  >{{ i + 1 }}</span><span class="min-w-0 flex-1"><span v-for="(t, k) in line" :key="k" :class="TOKEN_CLASS[t.type]">{{ t.text }}</span><template v-if="line.length === 0">&#8203;</template></span></span></code><span v-if="hidden" class="mt-1 block text-xs text-muted">… {{ hidden }} more {{ hidden === 1 ? 'line' : 'lines' }}</span></pre>
</template>
