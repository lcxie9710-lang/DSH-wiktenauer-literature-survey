import { describe, expect, it } from 'vitest'
import { htmlToText } from '../src/wiktenauer.ts'

describe('htmlToText', () => {
  it('strips tags and preserves paragraph boundaries', () => {
    const html = '<h2>Zwerchhau</h2><p>First <b>paragraph</b>.</p><p>Second paragraph.</p>'
    const text = htmlToText(html)
    expect(text).toContain('Zwerchhau')
    expect(text).toContain('First paragraph.')
    expect(text).toContain('Second paragraph.')
    expect(text).not.toContain('<')
  })

  it('marks list items with bullets', () => {
    const html = '<ul><li>Alpha</li><li>Beta</li></ul>'
    const text = htmlToText(html)
    expect(text).toContain('• Alpha')
    expect(text).toContain('• Beta')
  })

  it('decodes common HTML entities', () => {
    expect(htmlToText('a &amp; b &lt;c&gt;')).toBe('a & b <c>')
  })

  it('handles empty input', () => {
    expect(htmlToText('')).toBe('')
  })
})
