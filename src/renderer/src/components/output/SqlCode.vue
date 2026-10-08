<script setup lang="ts">
/** Pretty-printed, syntax-colored SQL (query cards, builders). */
import { computed } from 'vue'
import { formatSql, tokenizeSql, type SqlTokenType } from './lib/sql'

const props = withDefaults(defineProps<{ sql: string; pretty?: boolean }>(), { pretty: true })

const tokens = computed(() => tokenizeSql(props.pretty ? formatSql(props.sql) : props.sql))

const CLASS: Record<SqlTokenType, string> = {
  keyword: 'text-code-keyword font-medium',
  word: 'text-fg',
  string: 'text-code-string',
  quoted: 'text-code-property',
  number: 'text-code-number',
  placeholder: 'text-code-meta',
  operator: 'text-muted',
  punct: 'text-muted',
  comment: 'text-code-comment italic',
  whitespace: ''
}
</script>

<template>
  <pre class="selectable font-mono whitespace-pre-wrap break-words text-fg"><template v-for="(t, i) in tokens" :key="i"><span v-if="t.type !== 'whitespace'" :class="CLASS[t.type]">{{ t.text }}</span><template v-else>{{ t.text }}</template></template></pre>
</template>
