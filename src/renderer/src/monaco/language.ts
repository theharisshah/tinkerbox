import type { languages } from 'monaco-editor/editor/editor.api'
import { conf as phpConf, language as phpLanguage } from 'monaco-editor/languages/definitions/php/php'

/**
 * `tinkwell-php`: PHP without the `<?php` open tag. Builds on Monaco's PHP grammar (keyword lists, comment / string
 * conventions, folding markers) but the tokenizer starts in PHP code instead of HTML, still tolerates a leading
 * `<?php`, and adds what scratch code needs: heredoc / nowdoc, string interpolation, attributes, PHP 8 keywords,
 * function / class / property / constant tokens and highlighted magic comments.
 *
 * Pure data (no Monaco runtime import) so the grammar can be unit tested with Monaco's Monarch tokenizer.
 */

export const LANGUAGE_ID = 'tinkwell-php'

/** Token class postfix (themes prefix-match "keyword" → "keyword.php"). */
export const TOKEN_POSTFIX = '.php'

/**
 * Words for double-click selection, word navigation and completion ranges: `$variable` keeps its `$`, identifiers,
 * numbers. Backslashes, `->` and `::` separate words.
 */
export const WORD_PATTERN = /(-?\d*\.\d\w*)|(\$?[A-Za-z_\x80-\uffff][\w\x80-\uffff]*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s$]+)/g

const IDENT = '[A-Za-z_\\x80-\\uffff][\\w\\x80-\\uffff]*'

/** PHP 7/8 keywords missing from Monaco's list. */
const EXTRA_KEYWORDS = ['fn', 'match', 'enum', 'readonly', 'finally', 'from', 'yield', 'abstract', 'final', 'self', 'parent', 'never']

/** Type declarations, highlighted like keywords ("keyword.type"). */
const TYPE_KEYWORDS = ['int', 'float', 'bool', 'string', 'void', 'mixed', 'iterable', 'callable', 'object', 'array', 'never', 'static']

const LITERAL_CONSTANTS = ['true', 'false', 'null', 'TRUE', 'FALSE', 'NULL', 'True', 'False', 'Null']

function unique(list: string[]): string[] {
  return [...new Set(list)]
}

type MonarchRule = languages.IMonarchLanguageRule

/** Monarch definition of `tinkwell-php`. */
export function createPhpLanguage(): languages.IMonarchLanguage {
  const base = phpLanguage
  const keywords = unique(
    [...base.phpKeywords, ...EXTRA_KEYWORDS].filter((k) => !['true', 'false', 'null'].includes(k) && !TYPE_KEYWORDS.includes(k))
  )
  const constants = unique([...LITERAL_CONSTANTS, ...base.phpCompileTimeConstants])
  const predefined = unique([...base.phpPreDefinedVariables, '$this'])

  const name = IDENT
  const qualified = `\\\\?(?:${name}\\\\)*${name}`

  const heredocBody = (interpolate: boolean): MonarchRule[] => {
    const rules: MonarchRule[] = [
      [
        new RegExp(`^(\\s*)(${name})`),
        {
          cases: {
            '$2==$S2': { token: 'string.heredoc.delimiter', next: '@pop' },
            '@default': 'string.heredoc'
          }
        }
      ]
    ]
    if (interpolate) {
      rules.push(
        [new RegExp(`\\$${name}(?:\\??->${name})?`), 'variable'],
        [/@escapes/, 'string.escape'],
        [/[^$\\]+/, 'string.heredoc'],
        [/[$\\]/, 'string.heredoc']
      )
    } else {
      rules.push([/.+/, 'string.heredoc'])
    }
    return rules
  }

  return {
    defaultToken: '',
    tokenPostfix: TOKEN_POSTFIX,
    keywords,
    typeKeywords: TYPE_KEYWORDS,
    constants,
    predefined,
    escapes: /\\(?:[nrtvef\\$"]|[0-7]{1,3}|x[0-9A-Fa-f]{1,2}|u\{[0-9A-Fa-f]+\})/,
    brackets: [
      { open: '{', close: '}', token: 'delimiter.curly' },
      { open: '[', close: ']', token: 'delimiter.square' },
      { open: '(', close: ')', token: 'delimiter.parenthesis' }
    ],
    tokenizer: {
      // The code starts in PHP mode; a leading `<?php` (or a stray `?>`) is tolerated as a meta tag.
      root: [
        [/<\?(?:php\b|=)?/, 'metatag'],
        [/\?>/, 'metatag'],
        { include: '@whitespace' },

        // heredoc / nowdoc
        [new RegExp(`<<<[ \\t]*'(${name})'`), { token: 'string.heredoc.delimiter', next: '@nowdoc.$1' }],
        [new RegExp(`<<<[ \\t]*"?(${name})"?`), { token: 'string.heredoc.delimiter', next: '@heredoc.$1' }],

        // attributes #[...]
        [/#\[/, 'annotation'],

        // variables
        [/\$+[A-Za-z_\x80-\uffff][\w\x80-\uffff]*/, { cases: { '@predefined': 'variable.predefined', '@default': 'variable' } }],

        // ->member / ?->member (calls are functions, the rest properties)
        [new RegExp(`(\\??->)(\\s*)(${name})(?=\\s*\\()`), ['operator', '', 'function']],
        [new RegExp(`(\\??->)(\\s*)(${name})`), ['operator', '', 'property']],

        // ::class, ::method(), ::CONSTANT / ::Case, ::$static
        [/(::)(class)\b/, ['operator', 'keyword']],
        [new RegExp(`(::)(${name})(?=\\s*\\()`), ['operator', 'function']],
        [new RegExp(`(::)(${name})`), ['operator', 'constant']],

        // declarations / type positions
        [new RegExp(`(new|instanceof|extends|implements|insteadof)(\\s+)(${qualified})`), ['keyword', '', 'type']],
        [new RegExp(`(class|interface|trait|enum)(\\s+)(${name})(?=\\s*(?:\\{|extends|implements|:|$))`), ['keyword', '', 'type']],

        // Name:: (class before a static access, including all-caps facades like DB::)
        [new RegExp(`${qualified}(?=\\s*::)`), 'type'],

        // calls: name(
        [
          new RegExp(`${qualified}(?=\\s*\\()`),
          {
            cases: {
              '@keywords': 'keyword',
              '@typeKeywords': 'keyword.type',
              '@constants': 'constant',
              '@default': 'function'
            }
          }
        ],

        // qualified names App\Models\User, \Exception
        [new RegExp(`\\\\?(?:${name}\\\\)+${name}`), 'type'],
        [new RegExp(`\\\\${name}`), 'type'],

        // identifiers
        [
          new RegExp(name),
          {
            cases: {
              '@keywords': 'keyword',
              '@typeKeywords': 'keyword.type',
              '@constants': 'constant',
              '~[A-Z][A-Z0-9_]+': 'constant',
              '~[A-Z][\\w\\x80-\\uffff]*': 'type',
              '@default': 'identifier'
            }
          }
        ],

        // strings
        [/"/, 'string', '@dqString'],
        [/'/, 'string', '@sqString'],
        [/`/, 'string', '@backtick'],

        // numbers (PHP 7.4 numeric separators)
        [/0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*/, 'number.hex'],
        [/0[bB][01](?:_?[01])*/, 'number.binary'],
        [/0[oO][0-7](?:_?[0-7])*/, 'number.octal'],
        [/(?:\d(?:_?\d)*)?\.\d(?:_?\d)*(?:[eE][-+]?\d+)?/, 'number.float'],
        [/\d(?:_?\d)*[eE][-+]?\d+/, 'number.float'],
        [/\d(?:_?\d)*/, 'number'],

        // brackets, delimiters, operators
        [/[{}()[\]]/, '@brackets'],
        [/[;,]/, 'delimiter'],
        [/=>|<=>|\?\?=?|\.\.\.|[=!]==?|<=|>=|&&|\|\||\*\*=?|<<=?|>>=?|[-+*/%.&|^]=|\+\+|--|[-+*/%=<>!&|^~?:.@\\]/, 'operator'],
        [/./, '']
      ],

      whitespace: [
        [/[ \t\r\n]+/, ''],
        // magic comments: //?, //? label, #?, /*?*/, /*?->expr*/, /*?.*/
        [/(?:\/\/|#)\?.*$/, 'comment.magic'],
        [/\/\*\?.*?\*\//, 'comment.magic'],
        [/\/\*\*(?!\/)/, 'comment.doc', '@docComment'],
        [/\/\*/, 'comment', '@comment'],
        [/(?:\/\/|#(?!\[)).*$/, 'comment']
      ],

      comment: [
        [/[^*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/\*/, 'comment']
      ],

      docComment: [
        [/@[A-Za-z][\w-]*/, 'comment.doc.tag'],
        [/[^*@]+/, 'comment.doc'],
        [/\*\//, 'comment.doc', '@pop'],
        [/[*@]/, 'comment.doc']
      ],

      dqString: [
        [/[^\\"$]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string'],
        [new RegExp(`\\$${name}(?:\\??->${name})?`), 'variable'],
        [/\$/, 'string'],
        [/"/, 'string', '@pop']
      ],

      sqString: [
        [/[^\\']+/, 'string'],
        [/\\['\\]/, 'string.escape'],
        [/\\/, 'string'],
        [/'/, 'string', '@pop']
      ],

      backtick: [
        [/[^\\`$]+/, 'string'],
        [/\\./, 'string.escape'],
        [new RegExp(`\\$${name}`), 'variable'],
        [/\$/, 'string'],
        [/`/, 'string', '@pop']
      ],

      heredoc: heredocBody(true),
      nowdoc: heredocBody(false)
    }
  }
}

// IndentAction values (monaco.languages.IndentAction) — kept numeric so this module stays runtime-free.
const INDENT_NONE = 0 as languages.IndentAction
const INDENT_OUTDENT = 2 as languages.IndentAction

/** Language configuration: Monaco's PHP configuration plus the `$variable` word pattern and doc comment rules. */
export function createPhpConf(): languages.LanguageConfiguration {
  return {
    ...phpConf,
    wordPattern: WORD_PATTERN,
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')']
    ],
    autoClosingPairs: [
      { open: '{', close: '}', notIn: ['string'] },
      { open: '[', close: ']', notIn: ['string'] },
      { open: '(', close: ')', notIn: ['string'] },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
      { open: '`', close: '`', notIn: ['string', 'comment'] },
      { open: '/**', close: ' */', notIn: ['string'] }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '`', close: '`' }
    ],
    indentationRules: {
      increaseIndentPattern: /^((?!\/\/).)*(\{([^}"'`/]*|(\t|[ ])*\/\/.*)|\([^)"'`/]*|\[[^\]"'`/]*)$/,
      decreaseIndentPattern: /^((?!.*?\/\*).*\*\/)?\s*[}\])].*$/
    },
    onEnterRules: [
      {
        beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/,
        afterText: /^\s*\*\/$/,
        action: { indentAction: INDENT_OUTDENT, appendText: ' * ' }
      },
      { beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/, action: { indentAction: INDENT_NONE, appendText: ' * ' } },
      { beforeText: /^(\t|( {2}))* \*( ([^*]|\*(?!\/))*)?$/, action: { indentAction: INDENT_NONE, appendText: '* ' } },
      { beforeText: /^(\t|( {2}))* \*\/\s*$/, action: { indentAction: INDENT_NONE, removeText: 1 } }
    ]
  }
}
