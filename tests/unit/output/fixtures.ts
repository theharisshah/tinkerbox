import type { DumpNode, RunResult } from '@shared/types'

/** DumpNode builders mirroring resources/php/src/Dumper.php output. */

export const str = (v: string, extra: Partial<Extract<DumpNode, { t: 'string' }>> = {}): DumpNode => ({ t: 'string', v, len: [...v].length, ...extra })
export const int = (v: number | string): DumpNode => ({ t: 'int', v: String(v) })
export const float = (v: string): DumpNode => ({ t: 'float', v })
export const bool = (v: boolean): DumpNode => ({ t: 'bool', v })
export const nul: DumpNode = { t: 'null' }

export function arr(values: DumpNode[] | Record<string, DumpNode>): DumpNode {
  const items = Array.isArray(values) ? values.map((v, k) => ({ k, v })) : Object.entries(values).map(([k, v]) => ({ k, v }))
  return { t: 'array', count: items.length, items }
}

export function model(cls: string, id: number, attributes: Record<string, DumpNode>, relations: Record<string, DumpNode> = {}): DumpNode {
  const key = attributes.id
  return {
    t: 'object',
    class: cls,
    id,
    kind: 'model',
    summary: key && key.t === 'int' ? `#${key.v}` : undefined,
    props: [
      ...Object.entries(attributes).map(([name, v]) => ({ name, vis: 'attribute' as const, v })),
      ...Object.entries(relations).map(([name, v]) => ({ name, vis: 'relation' as const, v })),
      { name: 'exists', vis: 'meta', v: bool(true) },
      { name: 'connection', vis: 'meta', v: str('mysql') },
      { name: 'table', vis: 'meta', v: str('users') }
    ]
  }
}

export function collection(id: number, values: DumpNode[], cls = 'Illuminate\\Support\\Collection'): DumpNode {
  return { t: 'object', class: cls, id, kind: 'collection', count: values.length, items: values.map((v, k) => ({ k, v })), props: [] }
}

export function result(patch: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'run-1',
    tabId: 'tab-1',
    connectionId: 'scratch',
    ok: true,
    phpVersion: '8.3.12',
    driver: null,
    events: [],
    hasReturnValue: false,
    returnValue: null,
    magic: [],
    coverage: [],
    exception: null,
    diagnostics: [],
    bootMs: 0,
    durationMs: 1,
    memoryPeak: 1024,
    totalMs: 10,
    stderr: '',
    rawOutput: '',
    exitCode: 0,
    finishedAt: 0,
    ...patch
  }
}
