/**
 * Runs Monaco's real Monarch compiler + tokenizer in Node (they live in Monaco's platform-independent "common"
 * layer) so the `tinkwell-php` grammar can be tested without a browser.
 */
// @ts-expect-error — deep import without declarations
import { compile } from 'monaco-editor/editor/standalone/common/monarch/monarchCompile'
// @ts-expect-error — deep import without declarations
import { MonarchTokenizer } from 'monaco-editor/editor/standalone/common/monarch/monarchLexer'
import { createPhpLanguage, LANGUAGE_ID } from '../../../src/renderer/src/monaco/language'

export interface Tok {
  text: string
  type: string
}

interface RawToken {
  offset: number
  type: string
}

interface TokenizeResult {
  tokens: RawToken[]
  endState: unknown
}

interface Tokenizer {
  getInitialState(): unknown
  tokenize(line: string, hasEOL: boolean, state: unknown): TokenizeResult
}

let tokenizer: Tokenizer | null = null

function getTokenizer(): Tokenizer {
  if (tokenizer) return tokenizer
  const lexer = compile(LANGUAGE_ID, createPhpLanguage())
  const config = { getValue: () => 20000, onDidChangeConfiguration: () => ({ dispose() {} }) }
  const languageService = { requestBasicLanguageFeatures() {}, isRegisteredLanguageId: () => false, getLanguageIdByLanguageName: () => null }
  const themeService = { getColorTheme: () => ({ tokenTheme: {} }) }
  tokenizer = new MonarchTokenizer(languageService, themeService, LANGUAGE_ID, lexer, config) as Tokenizer
  return tokenizer
}

/** Tokenize a multi-line source; returns one array of tokens per line (empty-typed whitespace dropped). */
export function tokenizeLines(source: string): Tok[][] {
  const t = getTokenizer()
  let state = t.getInitialState()
  const out: Tok[][] = []
  for (const line of source.split('\n')) {
    const result = t.tokenize(line, true, state)
    state = result.endState
    const toks: Tok[] = []
    result.tokens.forEach((tok, i) => {
      const end = i + 1 < result.tokens.length ? result.tokens[i + 1].offset : line.length
      const text = line.slice(tok.offset, end)
      if (text.trim() === '' && tok.type === '') return
      toks.push({ text, type: tok.type })
    })
    out.push(toks)
  }
  return out
}

/** Type of the first token whose text equals `text` (searching all lines). */
export function typeOf(source: string, text: string): string | undefined {
  for (const line of tokenizeLines(source)) {
    const found = line.find((t) => t.text === text)
    if (found) return found.type
  }
  return undefined
}
