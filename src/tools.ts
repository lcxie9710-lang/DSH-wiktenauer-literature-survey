/**
 * The four model-facing Wiktenauer tools.
 *
 * Ported from the `@mcp.tool()` handlers in `wiktenauer_mcp.py`. Each tool
 * returns a canonical structured value (not prose) so the model receives a
 * rendered text projection while programmatic consumers get structured data.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import {
  wikiGetLinks,
  wikiGetPage,
  wikiPrefixSearch,
  wikiSearch,
} from './wiktenauer.js'
import type { GlossaryStore } from './glossary.js'

function renderError(message: string): string {
  return `Error: ${message}`
}

export function registerWikiTools(ctx: Context, _glossary: GlossaryStore) {
  ctx.tools.register(defineTool({
    name: 'wiki_search',
    description:
      'Full-text search the Wiktenauer wiki (HEMA treatise library) and return matching page titles with snippets. ' +
      'MUST be called before wiki_get_page for every research question. Translates modern/Chinese terms to historical terms first.',
    parameters: {
      keyword: { type: 'string', required: true, description: 'Search keyword (prefer historical/English HEMA terms)' },
      limit: { type: 'integer', description: 'Maximum results, default 10' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                snippet: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { hits: Array<{ title: string; snippet: string }>; error?: string }
        if (v.error) return [{ type: 'text', text: v.error }]
        const hits = v.hits
        if (hits.length === 0) return [{ type: 'text', text: 'No results found on Wiktenauer.' }]
        const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.snippet}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const result = await wikiSearch(args.keyword, args.limit ?? 10)
      if (!result.ok) return { hits: [], error: renderError(result.message) }
      if (result.kind !== 'search') return { hits: [], error: 'Unexpected search result' }
      return { hits: result.hits }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_get_page',
    description:
      'Fetch the full plain-text content of one Wiktenauer page (exact title match). ' +
      'Call after wiki_search on the most relevant result. Preserves heading/paragraph structure.',
    parameters: {
      title: { type: 'string', required: true, description: 'Exact page title as returned by wiki_search' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { text: string; error?: string }
        if (v.error) return [{ type: 'text', text: v.error }]
        return [{ type: 'text', text: v.text }]
      },
    },
    async execute(args) {
      const result = await wikiGetPage(args.title)
      if (!result.ok) return { text: '', error: renderError(result.message) }
      if (result.kind !== 'page') return { text: '', error: 'Unexpected page result' }
      return { text: result.text }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_prefix_search',
    description:
      'Prefix-based title search on Wiktenauer. Use for term disambiguation and discovering spelling variants ' +
      '(e.g. search "Zwer" to find "Zwerchhau"). Falls back to this when wiki_search returns nothing.',
    parameters: {
      prefix: { type: 'string', required: true, description: 'Title prefix to match' },
      limit: { type: 'integer', description: 'Maximum results, default 10' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          titles: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { titles: string[]; error?: string }
        if (v.error) return [{ type: 'text', text: v.error }]
        if (v.titles.length === 0) return [{ type: 'text', text: 'No titles match that prefix.' }]
        return [{ type: 'text', text: v.titles.map((t, i) => `${i + 1}. ${t}`).join('\n') }]
      },
    },
    async execute(args) {
      const result = await wikiPrefixSearch(args.prefix, args.limit ?? 10)
      if (!result.ok) return { titles: [], error: renderError(result.message) }
      if (result.kind !== 'titles') return { titles: [], error: 'Unexpected prefix result' }
      return { titles: result.titles }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_get_links',
    description:
      'Get internal links of one Wiktenauer page. Use to discover related/connected concepts in the HEMA corpus ' +
      '(e.g. from one master treatise to related glosses).',
    parameters: {
      title: { type: 'string', required: true, description: 'Exact page title' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          links: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { links: string[]; error?: string }
        if (v.error) return [{ type: 'text', text: v.error }]
        if (v.links.length === 0) return [{ type: 'text', text: 'This page has no internal links.' }]
        return [{ type: 'text', text: v.links.map((t, i) => `${i + 1}. ${t}`).join('\n') }]
      },
    },
    async execute(args) {
      const result = await wikiGetLinks(args.title)
      if (!result.ok) return { links: [], error: renderError(result.message) }
      if (result.kind !== 'links') return { links: [], error: 'Unexpected links result' }
      return { links: result.links }
    },
  }))
}
