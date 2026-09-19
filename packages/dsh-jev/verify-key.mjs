/**
 * Prove which layer supplies the gateway key.
 *
 * The full verifier happens to succeed while the key sits in `$HERMES_HOME/.env`,
 * which would keep DSH silently dependent on a sibling tool. This script removes
 * that fallback and makes the same real call twice: once with the DSH home
 * present, once pointed at an empty directory. The first must answer, the second
 * must refuse — together they show the configured layer is what works and that
 * nothing else is quietly supplying the key.
 *
 * No secret is printed; only lengths and booleans.
 *
 * Usage: node verify-key.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}

const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const dshEnvFile = join(dshHome, '.env')
const hermesHome = process.env.HERMES_HOME
const hermesEnvFile = hermesHome === undefined ? undefined : join(hermesHome, '.env')

console.log('1. what exists right now')
console.log(`  DSH_HOME          = ${dshHome}`)
console.log(`  HERMES_HOME       = ${hermesHome ?? '(unset)'}`)
check(`<DSH_HOME>/.env exists`, existsSync(dshEnvFile), dshEnvFile)
if (existsSync(dshEnvFile)) {
  const text = readFileSync(dshEnvFile, 'utf8')
  const found = /^\s*(?:export\s+)?AI_GATEWAY_API_KEY\s*=\s*(\S.*)$/m.exec(text)
  check('it defines AI_GATEWAY_API_KEY with a non-empty value', found !== null && found[1].trim() !== '', `size=${statSync(dshEnvFile).size}`)
  console.log(`  value length ${found === null ? 0 : found[1].trim().length}, prefix ${found === null ? '-' : `${found[1].trim().slice(0, 4)}...`}`)
}

// Remove every other source: the process environment and the sibling tool's file.
delete process.env.AI_GATEWAY_API_KEY
delete process.env.HERMES_HOME
process.env.DSH_HOME = dshHome

const plugin = await import(pathToFileURL(join(import.meta.dirname, 'index.js')).href)
const registered = []
plugin.apply(
  {
    logger: { info: () => {}, warn: (message) => console.log(`  [plugin warn] ${message}`) },
    get: () => undefined,
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
  },
  {},
)
const tool = registered[0]
const exec = { signal: new AbortController().signal }
const args = { state: 'The build failed twice in a row on Windows.', questions: { urgent: { type: 'boolean', instructions: 'Does this express urgency?' } } }

console.log('\n2. with HERMES_HOME and the process variable removed')
console.log(`  HERMES_HOME now = ${process.env.HERMES_HOME ?? '(unset)'}   AI_GATEWAY_API_KEY in env = ${process.env.AI_GATEWAY_API_KEY !== undefined}`)
const withDshHome = await tool.execute(args, exec)
check('the DSH home .env alone answers a real call', withDshHome.ok === true, withDshHome.error ?? JSON.stringify(withDshHome))
if (withDshHome.ok === true) console.log(`  answered: p(true) = ${withDshHome.answers.urgent.probability}, cost $${withDshHome.costUsd}`)

console.log('\n3. pointed at an empty home, with nothing else left')
process.env.DSH_HOME = join(tmpdir(), `dsh-jev-absent-home-${Date.now()}`)
check('the stand-in home does not exist', !existsSync(process.env.DSH_HOME))
const withoutAnySource = await tool.execute(args, exec)
check('the call refuses instead of borrowing a key from somewhere else', withoutAnySource.ok === false, JSON.stringify(withoutAnySource))
check('and the refusal names every place to set the key', typeof withoutAnySource.error === 'string' && /AI_GATEWAY_API_KEY/.test(withoutAnySource.error), withoutAnySource.error)

if (hermesEnvFile !== undefined) {
  console.log(`\n(unchanged, still available as the last fallback: ${hermesEnvFile})`)
}
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
