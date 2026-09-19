/**
 * Verify the generated `conditioned-reflex` preset before it is installed.
 *
 * Checks that both files parse the way the preset roster reads them, that the
 * composition is a list of named rows, and that the only difference from the
 * shipped `standard` preset is the JEV row this preset exists for.
 *
 * Usage: node verify-preset.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks++
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures++
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` 鈥?${detail}`}`)
  return false
}

/** Load js-yaml out of the installed DSH profile, which already depends on it. */
async function loadYaml() {
  const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  const candidates = [
    join(dshHome, 'profiles', 'node_modules', 'js-yaml', 'index.js'),
    join(dshHome, 'profiles', 'web', 'node_modules', 'js-yaml', 'index.js'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) return undefined
  const module = await import(pathToFileURL(found).href)
  return module.default ?? module
}

/** Candidate paths of the shipped `standard` preset inside an installed DSH build. */
function shippedStandardCandidates() {
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
  return candidates
}

const yaml = await loadYaml()
if (yaml === undefined) {
  console.error('js-yaml not found under the installed profile; cannot verify the preset')
  process.exit(2)
}

/**
 * Parse a DSH composition.
 *
 * Composition files may carry `!!js` scalar values, which the harness loader
 * evaluates itself; the structure checker here only needs them as opaque text.
 * @param text - the file contents.
 * @returns The parsed structure.
 */
function parse(text) {
  const jsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => value })
  return yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([jsTag]) })
}

const here = import.meta.dirname
const presetPath = join(here, 'conditioned-reflex', 'preset.yml')
const compositionPath = join(here, 'conditioned-reflex', 'agent.cordis.yml')

console.log('1. preset.yml')
const preset = parse(readFileSync(presetPath, 'utf8'))
check('parses as a mapping', typeof preset === 'object' && preset !== null && !Array.isArray(preset))
check('display name is "conditioned reflex"', preset?.name === 'conditioned reflex', JSON.stringify(preset?.name))
check('carries a description', typeof preset?.description === 'string' && preset.description !== '')
check('carries an order', typeof preset?.order === 'number', JSON.stringify(preset?.order))

console.log('\n2. agent.cordis.yml')
const rows = parse(readFileSync(compositionPath, 'utf8'))
check('parses as a top-level array of rows', Array.isArray(rows), typeof rows)
check('every row is an object with a string name', Array.isArray(rows) && rows.every((row) => typeof row?.name === 'string' && row.name !== ''), 'a nameless row is reported as broken')
const jevRows = Array.isArray(rows) ? rows.filter((row) => row.name === '@ghogiel/dsh-jev') : []
check('names @ghogiel/dsh-jev exactly once', jevRows.length === 1, `count=${jevRows.length}`)
check('the JEV row id is jev-evaluate', jevRows[0]?.id === 'jev-evaluate', JSON.stringify(jevRows[0]))
check('the JEV row is enabled', jevRows[0]?.disabled === undefined, JSON.stringify(jevRows[0]?.disabled))

console.log('\n3. composition against the shipped standard preset')
const standardPath = shippedStandardCandidates().find((candidate) => existsSync(candidate))
if (check('the shipped standard preset is available for comparison', standardPath !== undefined)) {
  const standard = parse(readFileSync(standardPath, 'utf8'))
  check('this composition has exactly one row more than standard', rows.length === standard.length + 1, `${rows.length} vs ${standard.length}`)
  check(
    'every standard row survives, in the same order',
    JSON.stringify(rows.slice(0, standard.length).map((row) => row.id)) === JSON.stringify(standard.map((row) => row.id)),
  )
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
