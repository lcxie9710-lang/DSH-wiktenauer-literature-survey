/**
 * weinao (维脑 Agent) — HEMA literature research plugin for DeepSeek Harness.
 *
 * Registers four Wiktenauer wiki tools plus a glossary-backed prompt section
 * that teaches the model the domain workflow (search → read → synthesize →
 * cite) and injects the user's term-mapping context.
 *
 * Installable as a bundle:
 *   dsh plugin --profile web add @wiktenauer-literature-survey/dsh-weinao
 * or by inserting its cordis.patch.yml rows into your profile.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { GlossaryStore } from './glossary.js'
import { registerWikiTools } from './tools.js'

export const name = 'weinao'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /**
   * Directory for the local glossary JSON file.
   * Defaults to `<harness home>/wiktenauer/glossary.json` where the harness
   * home is `$DSH_HOME` or `~/.dsh`.
   */
  glossaryDir?: string
  /**
   * Prompt-section order for the HEMA workflow section (default 1000).
   * Lower runs earlier; the persona is order 0.
   */
  sectionOrder?: number
}

export const Config: z<Config> = z.object({
  glossaryDir: z.string(),
  sectionOrder: z.number(),
})

const WORKFLOW_SECTION = `
# HEMA Literature Research Tools

These tools query the Wiktenauer library of historical European martial arts
treatises. Use them when the user asks a HEMA-related question, or when you
need to look up historical fighting manuals, techniques, or masters. They are
ordinary tools: your role and conversation policy are unchanged, and you use
these tools only when they help answer the user's actual question.

## Using the tools

1. To answer a HEMA question, search first: call wiki_search with historical
   or English search terms (translate modern or Chinese terms if needed).
2. Read the most relevant result with wiki_get_page.
3. If search returns nothing, try wiki_prefix_search with a shorter prefix, or
   wiki_get_links on a related page.
4. When you cite facts from these tools, name the source page.

## Rules

- Only call these tools when they are relevant to the user's question.
- For non-HEMA questions, answer normally; do not refuse, and do not force a
  Wiktenauer lookup.
`.trim()

export function apply(ctx: Context, config: Config = {}): void {
  const home = process.env.DSH_HOME ? join(process.env.DSH_HOME) : join(homedir(), '.dsh')
  const glossary = new GlossaryStore(
    config.glossaryDir ? join(config.glossaryDir, 'glossary.json') : join(home, 'wiktenauer', 'glossary.json'),
  )

  // Domain workflow + glossary context as one ordered prompt section.
  ctx.systemPrompt.section({
    name: 'hema-workflow',
    order: config.sectionOrder ?? 1000,
    text: () => {
      const context = glossary.getContextForPrompt()
      return context === '（术语表为空，无已知映射）'
        ? WORKFLOW_SECTION
        : `${WORKFLOW_SECTION}\n\n${context}`
    },
  })

  // The four wiki tools.
  registerWikiTools(ctx, glossary)

  ctx.logger.info('weinao (维脑 Agent): registered 4 wiki tools and glossary prompt section')
}
