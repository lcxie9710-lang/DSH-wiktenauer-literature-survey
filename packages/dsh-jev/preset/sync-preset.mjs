/**
 * Build the `conditioned-reflex` agent preset from the DSH build that is
 * installed on this machine.
 *
 * The preset is the shipped `standard` composition plus one row for
 * `@ghogiel/dsh-jev`. Copying the installed file rather than a checked-in copy
 * is deliberate: the rows of `standard` are the current build's, so an upgrade
 * of DSH cannot leave this preset naming rows that no longer exist.
 *
 * Writes `conditioned-reflex/agent.cordis.yml` next to this script; that
 * directory's `preset.yml` is authored by hand. Copy the whole directory to
 * `<DSH_HOME>/.agent-presets/conditioned-reflex/` to install it.
 *
 * Usage: node sync-preset.mjs
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The row this preset exists for. */
const ROW = `
# ── JEV (typesafe-ai/jev) evaluation model ──────────────────────────────────
# Registers jev_evaluate: closed-form judgement (probability / choice / score)
# on one supplied state. The tool body is model-callable rather than model-like,
# so the plugin is a plain profile dependency and never a bundle; this row is
# the only thing that makes the tool visible, and only to sessions on this preset.
- id: jev-evaluate
  name: '@ghogiel/dsh-jev'
`

/** Locate the shipped preset inside the installed DSH build. */
function findShippedStandard() {
  const candidates = []
  const npmCache = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx')
  if (existsSync(npmCache)) {
    for (const entry of readdirSync(npmCache)) {
      candidates.push(join(npmCache, entry, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'))
    }
  }
  const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  candidates.push(join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'))
  candidates.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'))
  return candidates.find((candidate) => existsSync(candidate))
}

const standardPath = findShippedStandard()
if (standardPath === undefined) {
  console.error('could not locate the installed standard preset; set DSH_HOME or install @deepseek-ai/dsh')
  process.exit(2)
}
console.log(`source preset: ${standardPath}`)

const source = readFileSync(standardPath, 'utf8')
const withoutTrailingBlankLines = source.replace(/[\s\uFEFF]+$/, '')
if (/^\s*-\s*id:\s*jev-evaluate\s*$/m.test(withoutTrailingBlankLines)) {
  console.error('the source preset already carries a jev-evaluate row; refusing to append a duplicate')
  process.exit(2)
}

const target = join(import.meta.dirname, 'conditioned-reflex', 'agent.cordis.yml')
writeFileSync(target, `${withoutTrailingBlankLines}\n${ROW}`)
console.log(`wrote ${target}`)
console.log(`install with: copy ${join(import.meta.dirname, 'conditioned-reflex')} to <DSH_HOME>/.agent-presets/conditioned-reflex/`)
