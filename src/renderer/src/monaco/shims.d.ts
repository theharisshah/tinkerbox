/**
 * Type shims for monaco-editor deep imports that ship without declarations.
 * `monaco-editor/languages/definitions/php/php` resolves (package "exports" `./*`) to
 * `esm/vs/languages/definitions/php/php.js`, which exports Monaco's PHP Monarch grammar.
 */
declare module 'monaco-editor/languages/definitions/php/php' {
  import type { languages } from 'monaco-editor/editor/editor.api'

  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage & {
    phpKeywords: string[]
    phpCompileTimeConstants: string[]
    phpPreDefinedVariables: string[]
    escapes: RegExp
  }
}
