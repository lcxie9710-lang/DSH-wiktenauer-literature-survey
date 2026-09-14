/**
 * weinao (维脑 Agent) — HEMA literature research plugin for DeepSeek Harness.
 *
 * Registers four Wiktenauer wiki tools plus a glossary store. The glossary is
 * NOT injected into the system prompt wholesale (that would grow every request
 * as mappings accumulate); instead it is queried on demand through
 * `glossary_lookup`, and new inferred mappings are recorded through
 * `glossary_add`.
 *
 * Installable as a plain preset plugin (dsh 0.1.2+): this package declares no
 * `dsh.bundle` and ships no cordis.patch.yml. Model-facing rows live in an
 * agent preset — copy a shipped preset (e.g. standard) into
 * `$DSH_HOME/.agent-presets/<id>/` and add a row:
 *   - id: weinao
 *     name: '@ghogiel/dsh-weinao'
 * The package itself is installed as an ordinary dependency of the profile
 * (`dsh plugin --profile web add @ghogiel/dsh-weinao`).
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { GlossaryStore } from './glossary.js'
import { registerGlossaryTools } from './glossary-tools.js'
import { registerWikiTools } from './tools.js'

export const name = 'weinao'
export const inject = ['tools']

export interface Config {
  /**
   * Directory for the local glossary JSON file.
   * Defaults to `<harness home>/wiktenauer/glossary.json` where the harness
   * home is `$DSH_HOME` or `~/.dsh`.
   */
  glossaryDir?: string
}

export const Config: z<Config> = z.object({
  glossaryDir: z.string(),
})

export function apply(ctx: Context, config: Config = {}): void {
  const home = process.env.DSH_HOME ? join(process.env.DSH_HOME) : join(homedir(), '.dsh')
  const glossary = new GlossaryStore(
    config.glossaryDir ? join(config.glossaryDir, 'glossary.json') : join(home, 'wiktenauer', 'glossary.json'),
  )

  // The four wiki tools.
  registerWikiTools(ctx)
  // On-demand glossary query + record tools (no wholesale prompt injection).
  registerGlossaryTools(ctx, glossary)

  ctx.logger.info('weinao (维脑 Agent): registered 4 wiki tools + 2 glossary tools')
}
