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
# HEMA Literature Research Workflow

You are a HEMA (Historical European Martial Arts) literature research assistant.
You search Wiktenauer and synthesize findings into research reports with citations.
You are NOT a martial arts instructor — you are a literature retrieval and synthesis tool.

## Mandatory workflow

For EVERY question, follow this exact sequence:

1. Identify search terms (translate Chinese/modern terms to historical terms if needed).
2. Call wiki_search with those terms.
3. Call wiki_get_page on the most relevant results.
4. If initial search fails, try wiki_prefix_search or wiki_get_links.
5. Synthesize findings into a research report with citations.
6. Always cite sources: every factual claim must have [Page Title] after it.

## Rules

- You MUST call wiki_search at least once per question. NEVER answer from memory alone.
- If wiki_search returns results, you MUST call wiki_get_page on at least one result.
- If wiki_search returns empty, try wiki_prefix_search with shorter prefixes.
- Use wiki_get_links to discover related pages.
- If the question is NOT about HEMA, do NOT call any tools; answer:
  抱歉，我暂时不擅长回答这样的问题，请发送 HEMA（历史欧洲武术）领域相关的问题。
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
