import { describe, expect, it } from 'vitest'
import type { editor } from 'monaco-editor/editor/editor.api'
import type { MagicValue, RunResult } from '@shared/types'
import { RunDecorations, runLineMap } from '../../../src/renderer/src/monaco/decorations'
import type { Monaco } from '../../../src/renderer/src/monaco/monaco'

class Range {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number
  ) {}
}

/**
 * Just enough of a Monaco text model for RunDecorations: text, versions and decorations that keep the ranges they
 * were created with (the tests check where apply() puts them, not how Monaco tracks them afterwards).
 */
function fakeEditor(initial: string) {
  let text = initial
  let version = 1
  let nextId = 0
  const decorations = new Map<string, editor.IModelDeltaDecoration>()
  let markers: editor.IMarkerData[] = []
  const lines = (): string[] => text.split('\n')
  const model = {
    isDisposed: () => false,
    getValue: () => text,
    getAlternativeVersionId: () => version,
    getLineCount: () => lines().length,
    getLineContent: (n: number) => lines()[n - 1],
    getLineMaxColumn: (n: number) => lines()[n - 1].length + 1,
    getLineFirstNonWhitespaceColumn: (n: number) => {
      const m = /\S/.exec(lines()[n - 1])
      return m ? m.index + 1 : 0
    },
    onDidChangeContent: () => ({ dispose: () => undefined }),
    deltaDecorations: (old: string[], added: editor.IModelDeltaDecoration[]) => {
      for (const id of old) decorations.delete(id)
      return added.map((d) => {
        const id = `d${nextId++}`
        decorations.set(id, d)
        return id
      })
    },
    getDecorationRange: (id: string) => decorations.get(id)?.range ?? null
  }
  const monaco = {
    Range,
    MarkerSeverity: { Error: 8, Warning: 4 },
    editor: {
      TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
      InjectedTextCursorStops: { None: 0 },
      setModelMarkers: (_model: unknown, _owner: string, list: editor.IMarkerData[]) => {
        markers = list
      }
    }
  }
  return {
    decorations: new RunDecorations(monaco as unknown as Monaco, model as unknown as editor.ITextModel),
    /** Replace the text (as typing would). */
    edit(next: string) {
      text = next
      version++
    },
    /** `line:column` of every badge piece and the class of what it shows. */
    badges(): string[] {
      return [...decorations.values()]
        .filter((d) => d.options.after?.inlineClassName?.includes('tw-magic-value'))
        .map((d) => `${d.range.endLineNumber}:${d.range.endColumn} ${d.options.after?.content}`)
    },
    coverage(): number[] {
      return [...decorations.values()]
        .filter((d) => d.options.firstLineDecorationClassName === 'tw-coverage')
        .map((d) => d.range.startLineNumber)
        .sort((a, b) => a - b)
    },
    errors(): string[] {
      return [...decorations.values()]
        .filter((d) => d.options.after?.inlineClassName === 'tw-inline-error')
        .map((d) => `${d.range.startLineNumber} ${d.options.after?.content}`)
    },
    markers: () => markers.map((m) => `${m.startLineNumber} ${m.message}`)
  }
}

const magic = (line: number, preview: string, column?: number): MagicValue => ({ line, column, type: 'value', preview, value: null, hits: 1 })

function result(extra: Partial<RunResult>): RunResult {
  return { runId: 'r1', magic: [], coverage: [], exception: null, diagnostics: [], ...extra } as unknown as RunResult
}

const settings = { magicComments: true, coverage: true, inlineErrors: true }

describe('run line mapping', () => {
  it('keeps unchanged leading and trailing lines and drops the edited region', () => {
    const map = runLineMap('a\nb\nc\nd', 'x\ny\na\nb\nc\nd')
    expect([1, 2, 3, 4].map((l) => map.exact(l))).toEqual([3, 4, 5, 6])
    const edited = runLineMap('a\nb\nc\nd', 'a\nB!\nc\nd')
    expect([1, 2, 3, 4].map((l) => edited.exact(l))).toEqual([1, null, 3, 4])
    expect(edited.nearest(2)).toBe(2)
    const removed = runLineMap('a\nb\nc\nd', 'a\nd')
    expect([1, 2, 3, 4].map((l) => removed.exact(l))).toEqual([1, null, null, 2])
    expect(removed.nearest(3)).toBe(2)
    expect(runLineMap('a\nb', 'a\nb').exact(2)).toBe(2)
    expect(runLineMap('a\nb', 'a\nb\nc').exact(9)).toBeNull()
  })
})

describe('run decorations', () => {
  const code = ["usleep(1500000);", "$a = 'AAA'; //?", "$b = 'BBB'; //?", "throw new Exception('err on line 4');"].join('\n')
  const run = result({
    magic: [magic(2, "'AAA'", 12), magic(3, "'BBB'", 12)],
    coverage: [1, 2, 3, 4],
    exception: { class: 'Exception', message: 'err on line 4', userLine: 4 } as RunResult['exception']
  })

  it('places everything at the result lines when the buffer did not change', () => {
    const e = fakeEditor(code)
    e.decorations.beginRun('r1')
    e.decorations.apply(run, settings)
    expect(e.badges()).toEqual(["2:16 'AAA'", "3:16 'BBB'"])
    expect(e.coverage()).toEqual([1, 2, 3, 4])
    expect(e.errors()).toEqual(['4 Exception: err on line 4'])
  })

  it('follows lines inserted while the script was running', () => {
    const e = fakeEditor(code)
    e.decorations.beginRun('r1')
    e.edit(`$new1 = 1;\n$new2 = 2;\n${code}`)
    e.decorations.apply(run, settings)
    expect(e.badges()).toEqual(["4:16 'AAA'", "5:16 'BBB'"])
    expect(e.coverage()).toEqual([3, 4, 5, 6])
    expect(e.errors()).toEqual(['6 Exception: err on line 4'])
    expect(e.markers()).toEqual(['6 Exception: err on line 4'])
    expect(e.decorations.runLineMap().nearest(4)).toBe(6)
    // re-applied later (settings toggled) after more edits: still mapped from the run's buffer
    e.edit(`$new0 = 0;\n$new1 = 1;\n$new2 = 2;\n${code}`)
    e.decorations.apply(run, settings)
    expect(e.coverage()).toEqual([4, 5, 6, 7])
  })

  it('drops the items of lines edited during the run', () => {
    const e = fakeEditor(code)
    e.decorations.beginRun('r1')
    e.edit(code.replace("$a = 'AAA'; //?", "$a = 'AAAA'; //?"))
    e.decorations.apply(run, settings)
    expect(e.badges()).toEqual(["3:16 'BBB'"])
    expect(e.coverage()).toEqual([1, 3, 4])
  })

  it('offsets magic comment columns on the first line of a selection run', () => {
    const lines = ['$z = 0;', '$a = 1; $b = 2; /*?*/ $c = $b * 10; //?', '$d = $c + 1; //?']
    const e = fakeEditor(lines.join('\n'))
    // selection from line 2 column 9 (`$b`) to the end: the runner measured columns from the selection start
    e.decorations.beginRun('r1', { line: 2, column: 9 })
    e.decorations.apply(result({ magic: [magic(2, '2', 8), magic(2, '20', 28), magic(3, '21', 13)] }), settings)
    expect(e.badges()).toEqual(['2:22 2', '2:40 20', '3:17 21'])
  })
})
