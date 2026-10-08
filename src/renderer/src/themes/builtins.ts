import type { ThemeSpec } from './types'

/**
 * Built-in theme palettes: Tinkerbox's own (Tinkerbox, Graphite, Paper, Glacier, Sage, Lagoon) and popular
 * open-source editor palettes. `buildTheme()` turns each spec into CSS variables and Monaco theme data. Ids are lower
 * kebab-case; the main process normalizes them the same way (src/main/themes.ts BUILTIN_CHROME) for the native window
 * background. Replaced ids of older versions are mapped in RENAMED_THEMES (./index.ts).
 */
export const BUILTIN_THEME_SPECS: ThemeSpec[] = [
  {
    id: 'tinkerbox',
    name: 'Tinkerbox',
    dark: false,
    chrome: {
      bg: '#f3f0fb',
      bgAlt: '#efebf9',
      surface: '#ffffff',
      border: '#e2dcf2',
      text: '#2b2340',
      textMuted: '#7b7296',
      accent: '#7c3aed',
      accentFg: '#ffffff',
      accentSoft: '#efe7fe',
      hover: '#e8e3f6',
      active: '#e3d8fc',
      sidebarBg: '#f3f0fb',
      titlebarBg: '#f3f0fb'
    },
    editor: {
      background: '#ffffff',
      foreground: '#2b2340',
      lineHighlight: '#f8f6fe',
      selection: '#ddd0fb',
      cursor: '#c026d3',
      lineNumber: '#c0b9d6',
      lineNumberActive: '#7c3aed',
      indentGuide: '#efecf6',
      indentGuideActive: '#d9d2ec'
    },
    syntax: {
      comment: '#9890b0',
      string: '#0f7b55',
      number: '#c2410c',
      keyword: '#7c3aed',
      variable: '#b4237a',
      function: '#2557d6',
      class: '#0b7285',
      constant: '#b45309',
      property: '#8f2a8f',
      operator: '#6a6286'
    }
  },
  {
    id: 'tinkerbox-dark',
    name: 'Tinkerbox Dark',
    dark: true,
    chrome: {
      bg: '#16141f',
      bgAlt: '#1b1926',
      surface: '#221f2f',
      border: '#2e2a3e',
      text: '#e7e2f6',
      textMuted: '#8e87a8',
      accent: '#a78bfa',
      accentFg: '#16141f',
      hover: '#24212f',
      active: '#2f2846',
      sidebarBg: '#16141f',
      titlebarBg: '#16141f'
    },
    editor: {
      background: '#1b1926',
      foreground: '#e7e2f6',
      lineHighlight: '#221f30',
      selection: '#3d3463',
      cursor: '#f472b6',
      lineNumber: '#4d4766',
      lineNumberActive: '#c4b5fd'
    },
    syntax: {
      comment: '#6f6889',
      string: '#8be0a4',
      number: '#fdba74',
      keyword: '#c4b5fd',
      variable: '#f9a8d4',
      function: '#93c5fd',
      class: '#67e8f9',
      constant: '#fcd34d',
      property: '#f0abfc'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: true,
    chrome: {
      bg: '#21222c',
      bgAlt: '#1d1e26',
      surface: '#282a36',
      border: '#353849',
      text: '#f8f8f2',
      textMuted: '#9aa3c7',
      accent: '#ff79c6',
      accentFg: '#21222c',
      hover: '#2c2e3b',
      active: '#3d3547',
      sidebarBg: '#21222c',
      titlebarBg: '#21222c'
    },
    editor: {
      background: '#282a36',
      foreground: '#f8f8f2',
      lineHighlight: '#2f3141',
      selection: '#44475a',
      cursor: '#f8f8f0',
      lineNumber: '#6272a4',
      lineNumberActive: '#f8f8f2'
    },
    syntax: {
      comment: '#6272a4',
      string: '#f1fa8c',
      number: '#bd93f9',
      keyword: '#ff79c6',
      variable: '#f8f8f2',
      function: '#50fa7b',
      class: '#8be9fd',
      constant: '#bd93f9',
      property: '#66d9ef',
      operator: '#ff79c6'
    }
  },
  {
    id: 'graphite',
    name: 'Graphite',
    dark: true,
    chrome: {
      bg: '#15171c',
      bgAlt: '#1a1d23',
      surface: '#20242c',
      border: '#2d323c',
      text: '#e6e8ec',
      textMuted: '#8a919e',
      accent: '#f0a33a',
      accentFg: '#1a1408',
      hover: '#232831',
      active: '#3a2f1c',
      sidebarBg: '#15171c',
      titlebarBg: '#15171c'
    },
    editor: {
      background: '#1a1d23',
      foreground: '#e6e8ec',
      lineHighlight: '#20242c',
      selection: '#3b3324',
      cursor: '#f0a33a',
      lineNumber: '#4a505c',
      lineNumberActive: '#f5bd6b'
    },
    syntax: {
      comment: '#6c7380',
      string: '#9fd28a',
      number: '#f19a6b',
      keyword: '#f0a33a',
      variable: '#e8b4d0',
      function: '#83b8f2',
      class: '#e7cf7a',
      constant: '#b9a3f0',
      property: '#8fd3cf'
    }
  },
  {
    id: 'paper',
    name: 'Paper',
    dark: false,
    chrome: {
      bg: '#f7f4ee',
      bgAlt: '#f2eee6',
      surface: '#fffdf9',
      border: '#e4ddd0',
      text: '#2a2620',
      textMuted: '#7d7466',
      accent: '#2f5bb7',
      accentFg: '#ffffff',
      hover: '#ece6da',
      active: '#dfe6f6',
      sidebarBg: '#f7f4ee',
      titlebarBg: '#f7f4ee'
    },
    editor: {
      background: '#fffdf9',
      foreground: '#2a2620',
      lineHighlight: '#faf6ee',
      selection: '#d9e2f5',
      cursor: '#2f5bb7',
      lineNumber: '#c8bfae',
      lineNumberActive: '#2f5bb7'
    },
    syntax: {
      comment: '#8f8574',
      string: '#3f7a3a',
      number: '#b0521c',
      keyword: '#2f5bb7',
      variable: '#9b3a6b',
      function: '#7a4fb3',
      class: '#0f6e75',
      constant: '#a5671a',
      property: '#6b5a2e'
    }
  },
  {
    id: 'material',
    name: 'Material',
    dark: true,
    chrome: {
      bg: '#1f292e',
      bgAlt: '#222d33',
      surface: '#263238',
      border: '#34454d',
      text: '#eeffff',
      textMuted: '#80989f',
      accent: '#80cbc4',
      accentFg: '#1f292e',
      hover: '#2a363c',
      active: '#2c4446',
      sidebarBg: '#1f292e',
      titlebarBg: '#1f292e'
    },
    editor: {
      background: '#263238',
      foreground: '#eeffff',
      lineHighlight: '#2c3a41',
      selection: '#3a4f58',
      cursor: '#ffcc00',
      lineNumber: '#4b6470',
      lineNumberActive: '#b0bec5'
    },
    syntax: {
      comment: '#546e7a',
      string: '#c3e88d',
      number: '#f78c6c',
      keyword: '#c792ea',
      variable: '#f07178',
      function: '#82aaff',
      class: '#ffcb6b',
      constant: '#f78c6c',
      property: '#80cbc4',
      operator: '#89ddff'
    }
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    dark: true,
    chrome: {
      bg: '#010e1a',
      bgAlt: '#011221',
      surface: '#0b2942',
      border: '#13324d',
      text: '#d6deeb',
      textMuted: '#7f95ae',
      accent: '#82aaff',
      accentFg: '#011627',
      hover: '#0a2036',
      active: '#13305a',
      sidebarBg: '#010e1a',
      titlebarBg: '#010e1a'
    },
    editor: {
      background: '#011627',
      foreground: '#d6deeb',
      lineHighlight: '#0b2034',
      selection: '#1d3b53',
      cursor: '#80a4c2',
      lineNumber: '#4b6479',
      lineNumberActive: '#c5e4fd'
    },
    syntax: {
      comment: '#637777',
      string: '#ecc48d',
      number: '#f78c6c',
      keyword: '#c792ea',
      variable: '#addb67',
      function: '#82aaff',
      class: '#ffcb8b',
      constant: '#ff5874',
      property: '#7fdbca',
      operator: '#7fdbca'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: true,
    chrome: {
      bg: '#272c36',
      bgAlt: '#2a303b',
      surface: '#323946',
      border: '#3e4656',
      text: '#e5e9f0',
      textMuted: '#8f9bb3',
      accent: '#88c0d0',
      accentFg: '#2e3440',
      hover: '#2f3541',
      active: '#36495a',
      sidebarBg: '#272c36',
      titlebarBg: '#272c36'
    },
    editor: {
      background: '#2e3440',
      foreground: '#d8dee9',
      lineHighlight: '#353c4a',
      selection: '#434c5e',
      cursor: '#d8dee9',
      lineNumber: '#4c566a',
      lineNumberActive: '#d8dee9'
    },
    syntax: {
      comment: '#616e88',
      string: '#a3be8c',
      number: '#b48ead',
      keyword: '#81a1c1',
      variable: '#d8dee9',
      function: '#88c0d0',
      class: '#8fbcbb',
      constant: '#ebcb8b',
      property: '#8fbcbb',
      operator: '#81a1c1'
    }
  },
  {
    id: 'shades-of-purple',
    name: 'Shades of Purple',
    dark: true,
    chrome: {
      bg: '#1e1e3f',
      bgAlt: '#222246',
      surface: '#2d2b55',
      border: '#3d3a75',
      text: '#ffffff',
      textMuted: '#a599e9',
      accent: '#fad000',
      accentFg: '#1e1e3f',
      hover: '#28284f',
      active: '#433c5c',
      sidebarBg: '#1e1e3f',
      titlebarBg: '#1e1e3f'
    },
    editor: {
      background: '#2d2b55',
      foreground: '#ffffff',
      lineHighlight: '#353266',
      selection: '#b362ff66',
      cursor: '#fad000',
      lineNumber: '#a599e9',
      lineNumberActive: '#fad000'
    },
    syntax: {
      comment: '#b362ff',
      string: '#a5ff90',
      number: '#ff628c',
      keyword: '#ff9d00',
      variable: '#e1efff',
      function: '#fad000',
      class: '#9effff',
      constant: '#ff628c',
      property: '#9effff',
      operator: '#ff9d00'
    }
  },
  {
    id: 'glacier',
    name: 'Glacier',
    dark: false,
    chrome: {
      bg: '#eef4f8',
      bgAlt: '#e8f0f6',
      surface: '#fbfdff',
      border: '#d5e2ec',
      text: '#1f2f3d',
      textMuted: '#647b8d',
      accent: '#1677a8',
      accentFg: '#ffffff',
      hover: '#e1ebf3',
      active: '#d3e8f5',
      sidebarBg: '#eef4f8',
      titlebarBg: '#eef4f8'
    },
    editor: {
      background: '#fbfdff',
      foreground: '#1f2f3d',
      lineHighlight: '#f2f7fb',
      selection: '#cfe5f4',
      cursor: '#1677a8',
      lineNumber: '#b4c6d4',
      lineNumberActive: '#1677a8'
    },
    syntax: {
      comment: '#86999f',
      string: '#227a6c',
      number: '#c0562a',
      keyword: '#1a6fb0',
      variable: '#8a3fa8',
      function: '#2a5fcf',
      class: '#0d7c8c',
      constant: '#b06d12',
      property: '#5b4bb5'
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    dark: true,
    chrome: {
      bg: '#00222b',
      bgAlt: '#00262f',
      surface: '#073642',
      border: '#0d4553',
      text: '#93a1a1',
      textMuted: '#62777c',
      accent: '#2aa198',
      accentFg: '#002b36',
      hover: '#032f3a',
      active: '#0a4049',
      sidebarBg: '#00222b',
      titlebarBg: '#00222b'
    },
    editor: {
      background: '#002b36',
      foreground: '#93a1a1',
      lineHighlight: '#073642',
      selection: '#0e4a59',
      cursor: '#d30102',
      lineNumber: '#3e5d65',
      lineNumberActive: '#93a1a1'
    },
    syntax: {
      comment: '#586e75',
      string: '#2aa198',
      number: '#d33682',
      keyword: '#859900',
      variable: '#268bd2',
      function: '#b58900',
      class: '#cb4b16',
      constant: '#6c71c4',
      property: '#268bd2'
    }
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    dark: false,
    chrome: {
      bg: '#f4eedb',
      bgAlt: '#f1ead4',
      surface: '#fdf6e3',
      border: '#e4dcc3',
      text: '#586e75',
      textMuted: '#738385',
      accent: '#268bd2',
      accentFg: '#fdf6e3',
      hover: '#ece5cf',
      active: '#dbe6e6',
      sidebarBg: '#f4eedb',
      titlebarBg: '#f4eedb'
    },
    editor: {
      background: '#fdf6e3',
      foreground: '#586e75',
      lineHighlight: '#f6efd9',
      selection: '#eee8d5',
      cursor: '#657b83',
      lineNumber: '#b9b6a8',
      lineNumberActive: '#586e75'
    },
    syntax: {
      comment: '#93a1a1',
      string: '#2aa198',
      number: '#d33682',
      keyword: '#859900',
      variable: '#268bd2',
      function: '#b58900',
      class: '#cb4b16',
      constant: '#6c71c4',
      property: '#268bd2'
    }
  },
  {
    id: 'github',
    name: 'GitHub',
    dark: false,
    chrome: {
      bg: '#f6f8fa',
      bgAlt: '#f3f5f7',
      surface: '#ffffff',
      border: '#d8dee4',
      text: '#1f2328',
      textMuted: '#656d76',
      accent: '#0969da',
      accentFg: '#ffffff',
      hover: '#eaeef2',
      active: '#ddf4ff',
      sidebarBg: '#f6f8fa',
      titlebarBg: '#f6f8fa'
    },
    editor: {
      background: '#ffffff',
      foreground: '#1f2328',
      lineHighlight: '#f6f8fa',
      selection: '#0969da33',
      cursor: '#0969da',
      lineNumber: '#8c959f',
      lineNumberActive: '#1f2328'
    },
    syntax: {
      comment: '#6e7781',
      string: '#0a3069',
      number: '#0550ae',
      keyword: '#cf222e',
      variable: '#953800',
      function: '#8250df',
      class: '#953800',
      constant: '#0550ae',
      property: '#0550ae',
      operator: '#cf222e'
    }
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    dark: true,
    chrome: {
      bg: '#010409',
      bgAlt: '#0a0d12',
      surface: '#161b22',
      border: '#262c35',
      text: '#e6edf3',
      textMuted: '#8b949e',
      accent: '#4493f8',
      accentFg: '#ffffff',
      hover: '#11161d',
      active: '#14273f',
      sidebarBg: '#010409',
      titlebarBg: '#010409'
    },
    editor: {
      background: '#0d1117',
      foreground: '#e6edf3',
      lineHighlight: '#161b22',
      selection: '#264f78',
      cursor: '#4493f8',
      lineNumber: '#3d444d',
      lineNumberActive: '#e6edf3'
    },
    syntax: {
      comment: '#8b949e',
      string: '#a5d6ff',
      number: '#79c0ff',
      keyword: '#ff7b72',
      variable: '#ffa657',
      function: '#d2a8ff',
      class: '#ffa657',
      constant: '#79c0ff',
      property: '#79c0ff',
      operator: '#ff7b72'
    }
  },
  {
    id: 'sage',
    name: 'Sage',
    dark: false,
    chrome: {
      bg: '#f2f2ea',
      bgAlt: '#ecede2',
      surface: '#fcfcf7',
      border: '#dcdccb',
      text: '#2b2e22',
      textMuted: '#737862',
      accent: '#677a32',
      accentFg: '#ffffff',
      hover: '#e7e8da',
      active: '#e3e8cc',
      sidebarBg: '#f2f2ea',
      titlebarBg: '#f2f2ea'
    },
    editor: {
      background: '#fcfcf7',
      foreground: '#2b2e22',
      lineHighlight: '#f6f6ee',
      selection: '#e0e6c4',
      cursor: '#677a32',
      lineNumber: '#c3c5b2',
      lineNumberActive: '#677a32'
    },
    syntax: {
      comment: '#8f9480',
      string: '#5e7a1c',
      number: '#b8572a',
      keyword: '#8a5a1e',
      variable: '#9a4a73',
      function: '#2f6b8f',
      class: '#3f7f6c',
      constant: '#7d4fa0',
      property: '#6d6a2a'
    }
  },
  {
    id: 'lagoon',
    name: 'Lagoon',
    dark: true,
    chrome: {
      bg: '#0e1d24',
      bgAlt: '#11232b',
      surface: '#162c35',
      border: '#213b46',
      text: '#d9ecef',
      textMuted: '#7fa1aa',
      accent: '#2fc4b2',
      accentFg: '#05201c',
      hover: '#18323c',
      active: '#174440',
      sidebarBg: '#0e1d24',
      titlebarBg: '#0e1d24'
    },
    editor: {
      background: '#11232b',
      foreground: '#d9ecef',
      lineHighlight: '#162c35',
      selection: '#1d4a4f',
      cursor: '#2fc4b2',
      lineNumber: '#3d5a64',
      lineNumberActive: '#5fd8c8'
    },
    syntax: {
      comment: '#6a8a94',
      string: '#a8d98a',
      number: '#f5a97f',
      keyword: '#4fd1c1',
      variable: '#f2a7c3',
      function: '#7cc4f5',
      class: '#f3d67c',
      constant: '#c3a6f5',
      property: '#8fe0d3'
    }
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    dark: true,
    chrome: {
      bg: '#21252b',
      bgAlt: '#23272e',
      surface: '#2c313a',
      border: '#363c47',
      text: '#d7dae0',
      textMuted: '#8b929e',
      accent: '#61afef',
      accentFg: '#21252b',
      hover: '#292d35',
      active: '#2c3e52',
      sidebarBg: '#21252b',
      titlebarBg: '#21252b'
    },
    editor: {
      background: '#282c34',
      foreground: '#abb2bf',
      lineHighlight: '#2c313c',
      selection: '#3e4451',
      cursor: '#528bff',
      lineNumber: '#4b5263',
      lineNumberActive: '#abb2bf'
    },
    syntax: {
      comment: '#5c6370',
      string: '#98c379',
      number: '#d19a66',
      keyword: '#c678dd',
      variable: '#e06c75',
      function: '#61afef',
      class: '#e5c07b',
      constant: '#d19a66',
      property: '#e06c75',
      operator: '#56b6c2'
    }
  },
  {
    id: 'monokai',
    name: 'Monokai',
    dark: true,
    chrome: {
      bg: '#1e1f1c',
      bgAlt: '#21221e',
      surface: '#2d2e27',
      border: '#3b3c33',
      text: '#f8f8f2',
      textMuted: '#9a9a87',
      accent: '#a6e22e',
      accentFg: '#1e1f1c',
      hover: '#272822',
      active: '#33401f',
      sidebarBg: '#1e1f1c',
      titlebarBg: '#1e1f1c'
    },
    editor: {
      background: '#272822',
      foreground: '#f8f8f2',
      lineHighlight: '#2f302a',
      selection: '#49483e',
      cursor: '#f8f8f0',
      lineNumber: '#57584f',
      lineNumberActive: '#f8f8f2'
    },
    syntax: {
      comment: '#75715e',
      string: '#e6db74',
      number: '#ae81ff',
      keyword: '#f92672',
      variable: '#f8f8f2',
      function: '#a6e22e',
      class: '#66d9ef',
      constant: '#ae81ff',
      property: '#fd971f',
      operator: '#f92672'
    }
  }
]
