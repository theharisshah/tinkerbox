import type { editor, IDisposable, IRange } from 'monaco-editor/editor/editor.api'
import type { MagicValue, RunResult } from '@shared/types'
import { formatMagicBadge, locateMagicComment, truncate } from './magic'
import type { Monaco } from './monaco'

/**
 * Run decorations of one model (they live on the model, so they survive tab switches):
 *  - magic comment badges — injected text after the code (or right after an inline `/*?*\/` comment): a rounded pill
 *    with the label (muted), the value (bold accent) and the hit count of loops;
 *  - the coverage gutter — a small square in the lines-decorations lane of every executed line;
 *  - inline errors — a marker (red squiggle + hover) on the exception's editor line plus the message after the line;
 *    warnings / notices / deprecations of user lines become warning markers.
 * Items disappear when their line is edited, and everything is replaced by the next run. Result lines refer to the
 * buffer the run started from (beginRun): when it was edited before the result arrived (Laravel boots for a second,
 * auto-evaluate runs while typing), they are mapped onto the current buffer, and lines that changed get nothing.
 */

export interface DecorationSettings {
  magicComments: boolean
  coverage: boolean
  inlineErrors: boolean
}

type ItemKind = 'badge' | 'coverage' | 'error' | 'warning'

interface LineItem {
  kind: ItemKind
  /** Decoration ids; ids[0] tracks the line. */
  ids: string[]
  /** Line content when the item was created (edits of that line remove it). */
  text: string
  marker?: editor.IMarkerData
}

/** Where a run started from: its result's lines (and magic comment columns) refer to this buffer. */
interface RunOrigin {
  runId: string
  code: string
  /** model.getAlternativeVersionId() at the start (same id → same text, undo included). */
  versionId: number
  /** Selection runs: 1-based position where the evaluated text starts. */
  selectionStart: { line: number; column: number } | null
}

/** Lines of the buffer a run started from → lines of the current buffer. */
export interface RunLineMap {
  /** The current line holding that line's unchanged text, or null when it was edited or removed. */
  exact(line: number): number | null
  /** Best guess for navigation: the exact line, else the corresponding spot of the edited region. */
  nearest(line: number): number
}

const IDENTITY_MAP: RunLineMap = { exact: (line) => line, nearest: (line) => line }

/**
 * Map the lines of `before` onto `after`: the unchanged leading and trailing lines keep their identity (shifted by
 * the lines inserted / removed in between); the lines of the edited region in the middle have no exact counterpart.
 */
export function runLineMap(before: string, after: string): RunLineMap {
  if (before === after) return IDENTITY_MAP
  const a = before.split('\n')
  const b = after.split('\n')
  const max = Math.min(a.length, b.length)
  let head = 0
  while (head < max && a[head] === b[head]) head++
  let tail = 0
  while (tail < max - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const exact = (line: number): number | null => {
    if (!Number.isInteger(line) || line < 1 || line > a.length) return null
    if (line <= head) return line
    if (line > a.length - tail) return line + b.length - a.length
    return null
  }
  return {
    exact,
    nearest: (line) => {
      const mapped = exact(line)
      if (mapped !== null) return mapped
      const edited = Math.max(1, b.length - tail - head)
      return Math.min(Math.max(1, head + Math.min(Math.max(1, line - head), edited)), b.length)
    }
  }
}

export const MARKER_OWNER = 'tinkwell-run'
const MAX_ERROR_CHARS = 160

function lastSegment(className: string): string {
  const i = className.lastIndexOf('\\')
  return i < 0 ? className : className.slice(i + 1)
}

/** One-line message for an exception (`ModelNotFoundException: No query results…`). */
export function inlineErrorMessage(cls: string, message: string): string {
  const text = message.replace(/\s+/g, ' ').trim()
  return truncate(`${lastSegment(cls)}${text ? `: ${text}` : ''}`, MAX_ERROR_CHARS)
}

export class RunDecorations implements IDisposable {
  private items: LineItem[] = []
  /** Run whose result is shown (null when cleared). */
  appliedRunId: string | null = null
  /** The run in progress (beginRun) and the one whose result is shown. */
  private pendingOrigin: RunOrigin | null = null
  private appliedOrigin: RunOrigin | null = null
  private readonly listener: IDisposable

  constructor(
    private readonly monaco: Monaco,
    private readonly model: editor.ITextModel
  ) {
    this.listener = model.onDidChangeContent((e) => this.onContentChanged(e))
  }

  get isEmpty(): boolean {
    return this.items.length === 0
  }

  /**
   * Range ending at `column` that stays on its line when text is typed right after it (or Enter is pressed there):
   * the character before the column, with NeverGrowsWhenTypingAtEdges. Empty only at column 1.
   */
  private anchor(line: number, column: number): IRange {
    return column > 1 ? new this.monaco.Range(line, column - 1, line, column) : new this.monaco.Range(line, 1, line, 1)
  }

  /** The whole content of a line (whole-line decorations that survive edits at either end). */
  private lineRange(line: number): IRange {
    return new this.monaco.Range(line, 1, line, this.model.getLineMaxColumn(line))
  }

  /**
   * A run starts from the buffer as it is now (`selectionStart` for selection runs): its result's lines are mapped
   * from this text when the buffer is edited before the result arrives.
   */
  beginRun(runId: string, selectionStart: { line: number; column: number } | null = null): void {
    if (this.model.isDisposed()) return
    this.pendingOrigin = { runId, code: this.model.getValue(), versionId: this.model.getAlternativeVersionId(), selectionStart }
  }

  /** Lines of the shown run's buffer → current lines (identity when the run's origin is unknown). */
  runLineMap(): RunLineMap {
    return this.lineMapFor(this.appliedOrigin)
  }

  private lineMapFor(origin: RunOrigin | null): RunLineMap {
    if (!origin || this.model.isDisposed() || origin.versionId === this.model.getAlternativeVersionId()) return IDENTITY_MAP
    return runLineMap(origin.code, this.model.getValue())
  }

  /** Replace the decorations with the ones of a run. */
  apply(result: RunResult, settings: DecorationSettings): void {
    const origin = [this.pendingOrigin, this.appliedOrigin].find((o) => o?.runId === result.runId) ?? null
    this.clear()
    this.appliedRunId = result.runId
    this.appliedOrigin = origin
    if (this.pendingOrigin === origin) this.pendingOrigin = null
    if (this.model.isDisposed()) return
    const lineCount = this.model.getLineCount()
    const map = this.lineMapFor(origin)
    /** Current line of a result line, or null when that line changed since the run started. */
    const lineOf = (line: number | null | undefined): number | null => {
      if (!line) return null
      const mapped = map.exact(line)
      return mapped !== null && mapped >= 1 && mapped <= lineCount ? mapped : null
    }
    const pending: Array<{ kind: ItemKind; line: number; decorations: editor.IModelDeltaDecoration[]; marker?: editor.IMarkerData }> = []

    if (settings.magicComments) {
      for (const magic of result.magic ?? []) {
        const line = lineOf(magic.line)
        if (line === null) continue
        // Selection runs report columns from the start of the evaluated text, which is mid-line on its first line.
        const shift = origin?.selectionStart && magic.line === origin.selectionStart.line ? origin.selectionStart.column - 1 : 0
        const column = magic.column === undefined ? undefined : magic.column + shift
        pending.push({ kind: 'badge', line, decorations: this.badgeDecorations(magic, line, column) })
      }
    }

    if (settings.coverage) {
      const covered = new Set<number>()
      for (const original of result.coverage ?? []) {
        const line = lineOf(original)
        if (line !== null) covered.add(line)
      }
      for (const line of covered) {
        pending.push({
          kind: 'coverage',
          line,
          decorations: [
            {
              range: this.lineRange(line),
              options: {
                isWholeLine: true,
                firstLineDecorationClassName: 'tw-coverage',
                stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
              }
            }
          ]
        })
      }
    }

    if (settings.inlineErrors) {
      const exception = result.exception
      const errorLine = lineOf(exception?.userLine)
      if (exception && errorLine !== null) {
        const line = errorLine
        const message = inlineErrorMessage(exception.class, exception.message)
        const maxColumn = this.model.getLineMaxColumn(line)
        const first = Math.max(1, this.model.getLineFirstNonWhitespaceColumn(line) || 1)
        pending.push({
          kind: 'error',
          line,
          decorations: [
            {
              range: this.anchor(line, maxColumn),
              options: {
                showIfCollapsed: true,
                stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                after: {
                  content: message,
                  inlineClassName: 'tw-inline-error',
                  inlineClassNameAffectsLetterSpacing: true,
                  cursorStops: this.monaco.editor.InjectedTextCursorStops.None
                }
              }
            },
            {
              range: this.lineRange(line),
              options: { isWholeLine: true, className: 'tw-error-line', stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }
            }
          ],
          marker: {
            severity: this.monaco.MarkerSeverity.Error,
            message: `${exception.class}: ${exception.message}`,
            source: exception.fatal ? 'PHP fatal error' : 'PHP',
            startLineNumber: line,
            startColumn: first,
            endLineNumber: line,
            endColumn: Math.max(first + 1, maxColumn)
          }
        })
      }
      const seen = new Set<number>()
      for (const diagnostic of result.diagnostics ?? []) {
        const line = lineOf(diagnostic.userLine)
        if (line === null || seen.has(line) || line === errorLine) continue
        seen.add(line)
        const maxColumn = this.model.getLineMaxColumn(line)
        const first = Math.max(1, this.model.getLineFirstNonWhitespaceColumn(line) || 1)
        pending.push({
          kind: 'warning',
          line,
          decorations: [{ range: this.lineRange(line), options: { stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }],
          marker: {
            severity: this.monaco.MarkerSeverity.Warning,
            message: `${diagnostic.level}: ${diagnostic.message}`,
            source: 'PHP',
            startLineNumber: line,
            startColumn: first,
            endLineNumber: line,
            endColumn: Math.max(first + 1, maxColumn)
          }
        })
      }
    }

    if (pending.length === 0) return
    const all = pending.flatMap((p) => p.decorations)
    const ids = this.model.deltaDecorations([], all)
    let cursor = 0
    for (const p of pending) {
      const itemIds = ids.slice(cursor, cursor + p.decorations.length)
      cursor += p.decorations.length
      this.items.push({ kind: p.kind, ids: itemIds, text: this.model.getLineContent(p.line), marker: p.marker })
    }
    this.publishMarkers()
  }

  /** Badge of a magic value on its (current) editor line; `column` = where the runner saw the comment in that line. */
  private badgeDecorations(magic: MagicValue, line: number, column: number | undefined): editor.IModelDeltaDecoration[] {
    const { Range } = this.monaco
    const text = this.model.getLineContent(line)
    const location = locateMagicComment(text, column)
    const badge = formatMagicBadge(magic)
    const inline = !!location?.inline
    const anchor = this.anchor(line, inline && location ? location.end + 1 : this.model.getLineMaxColumn(line))
    const pieces: Array<{ content: string; cls: string }> = []
    if (badge.label) pieces.push({ content: badge.label, cls: 'tw-magic-label' })
    pieces.push({ content: badge.value, cls: `tw-magic-value${badge.kind === 'time' ? ' tw-magic-time' : ''}` })
    if (badge.hits) pieces.push({ content: badge.hits, cls: 'tw-magic-hits' })
    const decorations: editor.IModelDeltaDecoration[] = pieces.map((piece, i) => {
      const classes = ['tw-magic', piece.cls, inline ? 'tw-magic-inline' : 'tw-magic-eol']
      if (i === 0) classes.push('tw-magic-first')
      if (i === pieces.length - 1) classes.push('tw-magic-last')
      return {
        range: anchor,
        options: {
          showIfCollapsed: true,
          stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          after: {
            content: piece.content,
            inlineClassName: classes.join(' '),
            inlineClassNameAffectsLetterSpacing: true,
            cursorStops: this.monaco.editor.InjectedTextCursorStops.None
          }
        }
      }
    })
    // Hover on the comment itself shows the full (untruncated) preview.
    if (location) {
      decorations.push({
        range: new Range(line, location.start + 1, line, location.end + 1),
        options: {
          stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          hoverMessage: { value: '```text\n' + badge.title.replace(/```/g, '`​``') + '\n```' }
        }
      })
    }
    return decorations
  }

  private publishMarkers(): void {
    if (this.model.isDisposed()) return
    const markers: editor.IMarkerData[] = []
    for (const item of this.items) {
      if (!item.marker) continue
      const range = this.model.getDecorationRange(item.ids[0])
      if (!range) continue
      const line = range.startLineNumber
      const maxColumn = this.model.getLineMaxColumn(line)
      const first = Math.max(1, this.model.getLineFirstNonWhitespaceColumn(line) || 1)
      markers.push({ ...item.marker, startLineNumber: line, endLineNumber: line, startColumn: first, endColumn: Math.max(first + 1, maxColumn) })
    }
    this.monaco.editor.setModelMarkers(this.model, MARKER_OWNER, markers)
  }

  /** Remove everything (output cleared / next run). */
  clear(): void {
    this.appliedRunId = null
    this.appliedOrigin = null
    if (this.model.isDisposed()) {
      this.items = []
      return
    }
    const ids = this.items.flatMap((i) => i.ids)
    this.items = []
    if (ids.length) this.model.deltaDecorations(ids, [])
    this.monaco.editor.setModelMarkers(this.model, MARKER_OWNER, [])
  }

  /** Drop the items whose line content changed. */
  private onContentChanged(event: editor.IModelContentChangedEvent): void {
    if (this.items.length === 0 || this.model.isDisposed()) return
    if (event.isFlush) {
      this.clear()
      return
    }
    let min = Number.POSITIVE_INFINITY
    let max = 0
    for (const change of event.changes) {
      const start = change.range.startLineNumber
      const added = (change.text.match(/\n/g) ?? []).length
      min = Math.min(min, start)
      max = Math.max(max, start + added)
    }
    const removed: string[] = []
    let markersChanged = false
    const keep: LineItem[] = []
    for (const item of this.items) {
      const range = this.model.getDecorationRange(item.ids[0])
      if (!range) {
        removed.push(...item.ids)
        markersChanged ||= !!item.marker
        continue
      }
      const line = range.startLineNumber
      if (line >= min - 1 && line <= max + 1 && this.model.getLineContent(line) !== item.text) {
        removed.push(...item.ids)
        markersChanged ||= !!item.marker
        continue
      }
      keep.push(item)
    }
    // (Markers move with the text on their own; they are only re-published when one of them goes away.)
    if (removed.length === 0) return
    this.items = keep
    this.model.deltaDecorations(removed, [])
    if (markersChanged) this.publishMarkers()
  }

  dispose(): void {
    this.listener.dispose()
    if (!this.model.isDisposed()) this.clear()
    this.items = []
    this.pendingOrigin = null
    this.appliedOrigin = null
  }
}
