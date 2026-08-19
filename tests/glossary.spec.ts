import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GlossaryStore, CONFIDENCE_DELTA, NEGATIVE_FEEDBACK_THRESHOLD } from '../src/glossary.ts'

function makeStore(): { store: GlossaryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wiktenauer-test-'))
  return { store: new GlossaryStore(join(dir, 'glossary.json')), dir }
}

describe('GlossaryStore', () => {
  it('creates an empty glossary file on first use', () => {
    const { store, dir } = makeStore()
    const raw = readFileSync(join(dir, 'glossary.json'), 'utf8')
    const data = JSON.parse(raw) as { mappings: unknown[]; version: string }
    expect(data.mappings).toEqual([])
    expect(data.version).toBe('1.0.0')
    expect(store.getContextForPrompt()).toContain('（术语表为空，无已知映射）')
  })

  it('adds a mapping and looks it up sorted by source priority', () => {
    const { store } = makeStore()
    const id = store.addMapping({
      source_term: '交击',
      target_term: 'Zwerchhau',
      source_language: 'zh',
      target_language: 'de',
      confidence: 0.6,
    })
    expect(id).toBeTruthy()
    // Add a confirmed one with lower confidence: it must sort first.
    store.addMapping({
      source_term: '交击',
      target_term: 'Zwerchhau',
      source_language: 'zh',
      target_language: 'de',
      confidence: 0.4,
      source: 'user_confirmed',
    })
    const hits = store.lookup('交击', 'zh')
    expect(hits).toHaveLength(2)
    expect(hits[0]!.source).toBe('user_confirmed')
    expect(hits[1]!.confidence).toBe(0.6)
  })

  it('confirmMapping raises confidence and marks source trusted', () => {
    const { store } = makeStore()
    const id = store.addMapping({ source_term: '交击', target_term: 'Zwerchhau' })
    store.confirmMapping(id)
    const hit = store.lookup('交击')[0]!
    expect(hit.source).toBe('user_confirmed')
    expect(hit.confidence).toBeCloseTo(0.5 + CONFIDENCE_DELTA, 10)
  })

  it('rejectMapping lowers confidence and removes after threshold', () => {
    const { store } = makeStore()
    const id = store.addMapping({ source_term: '交击', target_term: 'Zwerchhau' })
    for (let i = 0; i < NEGATIVE_FEEDBACK_THRESHOLD; i++) {
      store.rejectMapping(id)
    }
    expect(store.lookup('交击')).toHaveLength(0)
    expect(() => store.rejectMapping(id)).toThrow(/Mapping not found/)
  })

  it('getContextForPrompt separates confirmed and inferred sections', () => {
    const { store } = makeStore()
    const id = store.addMapping({ source_term: '交击', target_term: 'Zwerchhau', confidence: 0.8 })
    store.confirmMapping(id)
    store.addMapping({ source_term: '横劈', target_term: 'Zwerchhau', confidence: 0.7 })
    const ctx = store.getContextForPrompt()
    expect(ctx).toContain('【已确认术语映射（可信）】')
    expect(ctx).toContain('【LLM 推断映射（待确认，可用但必须告知用户）】')
    expect(ctx).toContain('交击')
    expect(ctx).toContain('横劈')
  })

  it('getContextForPrompt filters by terms when requested', () => {
    const { store } = makeStore()
    store.addMapping({ source_term: '交击', target_term: 'Zwerchhau' })
    store.addMapping({ source_term: '横劈', target_term: 'Zwerchhau' })
    const ctx = store.getContextForPrompt(['交击'])
    expect(ctx).toContain('交击')
    expect(ctx).not.toContain('横劈')
  })
})
