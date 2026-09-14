/**
 * On-demand glossary tools: query mappings by term and record newly inferred
 * mappings. The glossary is deliberately NOT injected into the system prompt —
 * it would grow every request as mappings accumulate. The model calls these
 * tools only when it needs a term's mapping or has inferred a new one.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { GlossaryStore, TermMapping } from './glossary.js'

/** Project one mapping to a plain structured row. */
function row(m: TermMapping): {
  id: string
  source_term: string
  target_term: string
  source_language: string
  target_language: string
  confidence: number
  status: 'confirmed' | 'inferred'
} {
  return {
    id: m.id,
    source_term: m.source_term,
    target_term: m.target_term,
    source_language: m.source_language,
    target_language: m.target_language,
    confidence: m.confidence,
    status: m.source === 'user_confirmed' || m.source === 'expert_added' ? 'confirmed' : 'inferred',
  }
}

export function registerGlossaryTools(ctx: Context, glossary: GlossaryStore) {
  ctx.tools.register(defineTool({
    name: 'glossary_lookup',
    description:
      'Look up the local bilingual glossary for one source term (default Chinese → target language). ' +
      'Use before translating a term in a HEMA context so previously confirmed mappings stay consistent. ' +
      'Returns every mapping for the term, confirmed/expert first, each with confidence and status.',
    parameters: {
      term: { type: 'string', required: true, description: 'Source term to look up (e.g. "交击")' },
      source_language: { type: 'string', description: 'Source language code, default "zh"' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          term: { type: 'string' },
          mappings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                source_term: { type: 'string' },
                target_term: { type: 'string' },
                source_language: { type: 'string' },
                target_language: { type: 'string' },
                confidence: { type: 'number' },
                status: { type: 'string', enum: ['confirmed', 'inferred'] },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { term: string; mappings: Array<{ target_term: string; status: string; confidence: number }>; error?: string }
        if (v.error) return [{ type: 'text', text: v.error }]
        if (v.mappings.length === 0) {
          return [{ type: 'text', text: `No glossary mapping for "${v.term}". You may infer a translation and record it with glossary_add.` }]
        }
        const lines = v.mappings.map((m) => `- ${m.target_term} [${m.status}, confidence ${m.confidence.toFixed(2)}]`)
        return [{ type: 'text', text: `Mappings for "${v.term}":\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      const matches = glossary.lookup(args.term, args.source_language ?? 'zh')
      return { term: args.term, mappings: matches.map(row) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'glossary_add',
    description:
      'Record a newly inferred bilingual term mapping (marked "inferred", awaiting user confirmation). ' +
      'Call this when translating a HEMA term that has no existing glossary mapping, so later answers reuse the same translation.',
    parameters: {
      source_term: { type: 'string', required: true, description: 'Source term (e.g. Chinese "交击")' },
      target_term: { type: 'string', required: true, description: 'Target term (e.g. German/English "Zwerchhau")' },
      source_language: { type: 'string', description: 'Source language code, default "zh"' },
      target_language: { type: 'string', description: 'Target language code, default "de"' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          source_term: { type: 'string' },
          target_term: { type: 'string' },
          status: { type: 'string', enum: ['inferred'] },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { source_term: string; target_term: string; status: string; error?: string }
        if (v.error) return [{ type: 'text', text: v.error }]
        return [{
          type: 'text',
          text: `Recorded inferred mapping ${v.source_term} → ${v.target_term} (${v.status}). Tell the user it awaits their confirmation.`,
        }]
      },
    },
    async execute(args) {
      // Guard against duplicate accumulation: if this source term already has
      // a mapping, point the model at the existing one instead of adding a
      // near-copy. Only a genuinely new term is recorded.
      const sourceLang = args.source_language ?? 'zh'
      const existing = glossary.lookup(args.source_term, sourceLang)
      if (existing.length > 0) {
        const ref = existing[0]!
        return {
          source_term: args.source_term,
          target_term: ref.target_term,
          error: `term "${args.source_term}" already has a mapping (${ref.target_term}); reuse it instead of adding`,
        }
      }
      const id = glossary.addMapping({
        source_term: args.source_term,
        target_term: args.target_term,
        source_language: sourceLang,
        target_language: args.target_language ?? 'de',
        confidence: 0.5,
        source: 'llm_inferred',
      })
      return { id, source_term: args.source_term, target_term: args.target_term, status: 'inferred' as const }
    },
  }))
}
