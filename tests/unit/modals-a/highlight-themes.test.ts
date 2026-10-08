import { describe, expect, it } from 'vitest'
import { highlightPhpLines, tokenizePhp } from '@/components/modals/history/highlight'
import { copyName, previewPalette, themeToJson } from '@/components/modals/themes/themeJson'
import { CHANGELOG_MARKDOWN, markdownToHtml, renderChangelog, stripTitle } from '@/components/modals/settings/changelog'
import { builtinThemes, getTheme } from '@/themes'
import { fromCustomTheme } from '@/themes/build'

describe('PHP preview highlighter', () => {
  it('classifies the common tokens', () => {
    const tokens = tokenizePhp(`<?php // hi\n$user = new User();\nUser::find(1)->name; echo 'x' . null;`).filter((t) => t.type !== 'plain')
    expect(tokens).toEqual([
      { type: 'tag', text: '<?php' },
      { type: 'comment', text: '// hi' },
      { type: 'variable', text: '$user' },
      { type: 'keyword', text: 'new' },
      { type: 'class', text: 'User' },
      { type: 'class', text: 'User' },
      { type: 'function', text: 'find' },
      { type: 'number', text: '1' },
      { type: 'keyword', text: 'echo' },
      { type: 'string', text: "'x'" },
      { type: 'constant', text: 'null' }
    ])
  })

  it('splits multi-line tokens into lines and keeps empty lines', () => {
    const lines = highlightPhpLines("/* a\nb */\n\n$x = 'one\ntwo';")
    expect(lines).toHaveLength(5)
    expect(lines[0]).toEqual([{ type: 'comment', text: '/* a' }])
    expect(lines[1]).toEqual([{ type: 'comment', text: 'b */' }])
    expect(lines[2]).toEqual([])
    expect(lines[4][0]).toEqual({ type: 'string', text: "two'" })
    expect(lines.flat().map((t) => t.text).join('')).toBe("/* ab */$x = 'onetwo';")
  })
})

describe('theme helpers', () => {
  it('exports a theme as Monaco JSON whose chrome survives the custom-theme round trip', () => {
    for (const theme of builtinThemes()) {
      const json = themeToJson(theme)
      expect(json.base).toBe(theme.monaco.base)
      const copy = fromCustomTheme({ id: 'custom:copy', name: 'Copy', file: '/tmp/copy.json', theme: JSON.parse(JSON.stringify(json)) })
      expect(copy.dark).toBe(theme.dark)
      for (const v of ['--tw-accent', '--tw-accent-fg', '--tw-bg', '--tw-surface', '--tw-text', '--tw-editor-bg'] as const) {
        expect(copy.vars[v].toLowerCase(), `${theme.id} ${v}`).toBe(theme.vars[v].toLowerCase())
      }
    }
  })

  it('suggests a free copy name', () => {
    expect(copyName('Dracula', ['Dracula'])).toBe('Dracula Custom')
    expect(copyName('Dracula', ['Dracula', 'dracula custom', 'Dracula Custom 2'])).toBe('Dracula Custom 3')
  })

  it('derives preview colors from the Monaco rules', () => {
    const palette = previewPalette(getTheme('dracula')!)
    expect(palette.editorBg).toMatch(/^#[0-9a-f]{6}/i)
    for (const color of Object.values(palette.tokens)) expect(color).toMatch(/^#[0-9a-f]{3,8}$/i)
    expect(palette.tokens.string).not.toBe(palette.tokens.keyword)
  })
})

describe('changelog', () => {
  it('drops the document title', () => {
    expect(stripTitle('# Changelog\n\n## 1.0\n- x')).toBe('## 1.0\n- x')
  })

  it('renders markdown to HTML', () => {
    const html = markdownToHtml('# Changelog\n\n## 0.1.0\n\n### Running code\n- Run PHP with `⌘R`')
    expect(html).toContain('<h2>0.1.0</h2>')
    expect(html).toContain('<code>⌘R</code>')
    expect(html).not.toContain('Changelog')
  })

  it('imports the repository CHANGELOG.md', () => {
    expect(CHANGELOG_MARKDOWN).toMatch(/^# Changelog/)
    expect(markdownToHtml(CHANGELOG_MARKDOWN)).toContain('<h3>Running code</h3>')
  })

  it('never returns unsanitized HTML when no DOM is available', () => {
    // The node test environment has no DOM, so DOMPurify cannot run: the text comes back escaped.
    const html = renderChangelog('## Hi <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
