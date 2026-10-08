import type { DumpNode, OutputEvent } from '@shared/types'
import { dumpToCli } from './cliFormat'
import { tabulate, toMarkdownTable } from './serialize'
import { formatSql } from './sql'

/** Text and Markdown renderings behind the "Copy" / "Copy as Markdown" card actions. */

function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}${lang}\n${text.replace(/\n$/, '')}\n${ticks}`
}

export function valueText(node: DumpNode | null | undefined): string {
  return dumpToCli(node)
}

/** Lists of records become a Markdown table, everything else a fenced block of the PsySH-style text. */
export function valueMarkdown(node: DumpNode | null | undefined): string {
  const table = node ? tabulate(node) : null
  if (table) return toMarkdownTable(table)
  return fence(dumpToCli(node), 'php')
}

export function eventText(event: OutputEvent): string {
  switch (event.kind) {
    case 'echo':
      return event.text
    case 'dump':
      return valueText(event.value)
    case 'query':
      return event.rawSql || event.sql
  }
}

export function eventMarkdown(event: OutputEvent): string {
  switch (event.kind) {
    case 'echo':
      return fence(event.text, 'text')
    case 'dump':
      return valueMarkdown(event.value)
    case 'query':
      return fence(formatSql(event.rawSql || event.sql), 'sql')
  }
}

export { fence as markdownFence }
