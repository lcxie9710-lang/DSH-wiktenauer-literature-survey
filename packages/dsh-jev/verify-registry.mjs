/**
 * Mount the plugin through the harness's REAL tool registry and dispatch
 * through its full pipeline.
 *
 * The other verifier checks the plugin's own behaviour against the harness's
 * schema validators. This one composes the registry the way a preset mount does
 * — SystemPrompt plus ToolRuntime, then the plugin — and calls the tool through
 * `ctx.tools.execute`, so registration, visibility, dispatch, canonical-value
 * validation against `output.schema`, and content materialization are all the
 * harness's own code paths rather than a stub.
 *
 * Usage: node verify-registry.mjs
 */

import { existsSync, readdirSync } from 'node:fs'
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
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}

/** Directory holding the harness's @deepseek-ai packages. */
function harnessPackages() {
  const candidates = []
  const npmCache = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx')
  if (existsSync(npmCache)) {
    for (const entry of readdirSync(npmCache)) candidates.push(join(npmCache, entry, 'node_modules', '@deepseek-ai'))
  }
  const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  candidates.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'))
  return candidates.find((candidate) => existsSync(join(candidate, 'dsh-tools', 'package.json')))
}

const packages = harnessPackages()
if (packages === undefined) {
  console.error('could not locate the harness packages; set DSH_HOME or install @deepseek-ai/dsh')
  process.exit(2)
}
console.log(`harness packages: ${packages}`)
const load = async (relative) => import(pathToFileURL(join(packages, relative)).href)

const cordis = await load('cordis/lib/index.js')
const Context = cordis.Context ?? cordis.default
const { default: SystemPrompt } = await load('dsh-system-prompt/lib/index.js')
const { default: ToolRuntime } = await load('dsh-tools/lib/index.js')
const plugin = await import(pathToFileURL(join(import.meta.dirname, 'index.js')).href)

const args = {
  state: 'The support agent issued a full refund to the customer on the third call, then emailed a confirmation.',
  questions: {
    refunded: { type: 'boolean', instructions: 'Was a refund issued?', criteria: { true: 'An amount was refunded', false: 'No refund mentioned' } },
    channel: { type: 'choice', instructions: 'How was the customer told?', criteria: { email: 'by email', chat: 'in chat', phone: 'by phone' } },
  },
}

console.log('\n1. mount exactly as a preset does')
const ctx = new Context()
const mounts = []
mounts.push(await ctx.plugin(SystemPrompt, {}))
mounts.push(await ctx.plugin(ToolRuntime, {}))
mounts.push(await ctx.plugin(plugin, {}))
check('the plugin mounted without throwing', true)

console.log('\n2. registry view')
const schemas = ctx.tools.schemas()
const schema = schemas.find((entry) => entry.name === 'jev_evaluate')
check('jev_evaluate is visible to the model', schema !== undefined, `visible: ${schemas.map((entry) => entry.name).join(', ')}`)
check('the model-facing schema carries its parameters', schema !== undefined && schema.parameters?.required?.includes('state') === true, JSON.stringify(schema?.parameters?.required))
check('the registry resolves the definition', ctx.tools.get('jev_evaluate') !== undefined)
check('the tool is reachable by name only', ctx.tools.get('jev_evaluate')?.name === 'jev_evaluate')

console.log('\n3. dispatch through the full pipeline')
const signal = new AbortController().signal
const result = await ctx.tools.execute({ callId: 'verify-1', name: 'jev_evaluate', arguments: args, signal })
check('the call completes without a tool error', result.isError === false, result.isError ? JSON.stringify(result.error) : '')
check('the canonical value passed output validation', result.value?.ok === true, JSON.stringify(result.value)?.slice(0, 200))
check('content was materialized by the render projection', Array.isArray(result.content) && result.content[0]?.type === 'text' && result.content[0].text.length > 0, JSON.stringify(result.content)?.slice(0, 200))
check('answers carry the projected values', typeof result.value?.answers?.refunded?.probability === 'number' && typeof result.value?.answers?.channel?.choice === 'string')
console.log('\n--- model-facing content ---')
console.log(result.content?.[0]?.text)
console.log('--- end ---')

console.log('\n4. failure paths through the same pipeline')
const invalid = await ctx.tools.execute({
  callId: 'verify-2',
  name: 'jev_evaluate',
  arguments: { state: 'x', questions: { q: { type: 'bogus', instructions: 'y' } } },
  signal,
})
check('invalid questions come back as ok:false, not a thrown error', invalid.isError === false && invalid.value?.ok === false, JSON.stringify(invalid.value)?.slice(0, 200))
check('the model sees the actionable reason', typeof invalid.content?.[0]?.text === 'string' && /boolean.*choice.*score/.test(invalid.content[0].text), invalid.content?.[0]?.text)

const unknown = await ctx.tools.execute({ callId: 'verify-3', name: 'jev_not_a_tool', arguments: {}, signal })
check('an unknown tool name fails as a tool error', unknown.isError === true, JSON.stringify(unknown))

// Unmount in reverse order and let the event loop drain: exiting with live
// fibers trips a libuv teardown assertion on Windows.
for (const mount of mounts.reverse()) await mount.dispose()

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
