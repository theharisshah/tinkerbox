import { describe, expect, it } from 'vitest'
import { classifyValue, displayValue, normalizePanels, panelRowCount, panelToText } from '@/components/modals/panels/panelUtils'

describe('normalizePanels', () => {
  it('keeps well-formed panels as they are', () => {
    const panels = [
      {
        title: 'App Information',
        sections: [{ title: 'Environment', rows: [{ key: 'Laravel Version', value: '12.20.0' }] }]
      }
    ]
    expect(normalizePanels(panels)).toEqual(panels)
  })

  it('drops junk and stringifies values', () => {
    const result = normalizePanels([
      null,
      'nope',
      { title: '', sections: [{ title: 'Drivers', rows: [{ key: 'Cache', value: 'redis' }, { key: '', value: 'x' }, { key: 'Debug', value: true }, 7] }] },
      { title: 'Empty', sections: [{ title: 'Nothing', rows: [] }] },
      { title: 'No sections' },
      { title: '  Custom  ', sections: [{ title: null, rows: [{ key: 'Count', value: 3 }, { key: 'List', value: ['a', 'b'] }, { key: 'Null', value: null }] }] }
    ])
    expect(result).toEqual([
      { title: 'Panel 3', sections: [{ title: 'Drivers', rows: [{ key: 'Cache', value: 'redis' }, { key: 'Debug', value: 'true' }] }] },
      {
        title: 'Custom',
        sections: [{ title: '', rows: [{ key: 'Count', value: '3' }, { key: 'List', value: '["a","b"]' }, { key: 'Null', value: '' }] }]
      }
    ])
  })

  it('returns an empty list for anything that is not an array', () => {
    expect(normalizePanels(null)).toEqual([])
    expect(normalizePanels({ title: 'x' })).toEqual([])
  })
})

describe('value display', () => {
  it('classifies values', () => {
    expect(classifyValue('true')).toBe('on')
    expect(classifyValue('ENABLED')).toBe('on')
    expect(classifyValue('false')).toBe('off')
    expect(classifyValue('Not Cached')).toBe('off')
    expect(classifyValue('')).toBe('empty')
    expect(classifyValue('null')).toBe('empty')
    expect(classifyValue('http://localhost:8000')).toBe('url')
    expect(classifyValue('https://example.test/path?x=1')).toBe('url')
    expect(classifyValue('/Users/me/Sites/shop')).toBe('path')
    expect(classifyValue('~/Sites/shop')).toBe('path')
    expect(classifyValue('C:\\www\\shop')).toBe('path')
    expect(classifyValue('8.3.12')).toBe('number')
    expect(classifyValue('128 MB')).toBe('number')
    expect(classifyValue('redis')).toBe('text')
    expect(classifyValue('Laravel 12')).toBe('text')
  })

  it('renders booleans as states and empty values as a dash', () => {
    expect(displayValue('true')).toBe('Enabled')
    expect(displayValue('false')).toBe('Disabled')
    expect(displayValue('CACHED')).toBe('CACHED')
    expect(displayValue('')).toBe('—')
    expect(displayValue('redis')).toBe('redis')
    expect(displayValue('true', 'Cache')).toBe('Cached')
    expect(displayValue('false', 'Caching')).toBe('Not cached')
    expect(displayValue('false', 'Environment')).toBe('Disabled')
  })

  it('formats a panel as text and counts rows', () => {
    const panel = {
      title: 'App Information',
      sections: [
        { title: 'Environment', rows: [{ key: 'PHP Version', value: '8.3.12' }, { key: 'Debug Mode', value: 'true' }] },
        { title: '', rows: [{ key: 'Cache', value: 'file' }] }
      ]
    }
    expect(panelToText(panel)).toBe(
      ['App Information', '', 'Environment', '  PHP Version  8.3.12', '  Debug Mode   true', '', '  Cache  file'].join('\n')
    )
    expect(panelRowCount(panel)).toBe(3)
  })
})
