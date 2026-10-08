import type { InjectionKey, Ref } from 'vue'
import type { DumpNode } from '@shared/types'
import type { HtmlNode } from './lib/dump'

/** State shared by a DumpTree root and its recursive DumpValue nodes. */
export interface DumpTreeContext {
  /** Expanded state of the container at `path` (defaults: top level open, nested per settings.collapseNested). */
  isOpen(path: string, depth: number): boolean
  /** Toggle a container; Alt/Option-click applies the new state to the whole subtree. */
  toggle(path: string, node: DumpNode, depth: number, event?: MouseEvent): void
  /** Explicit open state for secondary sections (e.g. a model's meta group). */
  sectionOpen(key: string, fallback?: boolean): boolean
  toggleSection(key: string, fallback?: boolean): void
  /** How many children of `path` are rendered (large containers render in pages). */
  limitOf(path: string, fallback: number): number
  showMore(path: string, step: number, fallback: number): void
  /** spl_object_id highlighted by hovering a reference. */
  highlightId: Ref<number | null>
  /** Expand the ancestors of an object and scroll it into view. */
  revealObject(id: number): void
  /** Editor line (user code) → reveal; file → open in editor. */
  openLocation(file: string | undefined, line: number | undefined): void
  openHtml(node: HtmlNode): void
}

export const DUMP_TREE: InjectionKey<DumpTreeContext> = Symbol('dumpTree')

/** Children rendered per page in big arrays / collections. */
export const DUMP_PAGE = 200
/** Characters of a string rendered before "show all". */
export const STRING_PAGE = 5000
