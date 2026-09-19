/**
 * Verification harness for the dsh-jev plugin.
 *
 * Checks the plugin against the harness's OWN validators — imported from the
 * installed DSH copy that the running host loads — then exercises the tool body
 * against the live Vercel AI Gateway. Everything here is read-only outside the
 * plugin's own module; no DSH profile is touched.
 *
 * Usage: node verify.mjs
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

/** Locate the dsh-tools module the running harness loads. */
function findHarnessTools() {
  const candidates = []
  const npmCache = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx')
  if (existsSync(npmCache)) {
    for (const entry of readdirSync(npmCache)) {
      candidates.push(join(npmCache, entry, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
    }
  }
  const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  candidates.push(join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  candidates.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  return candidates.find((candidate) => existsSync(candidate))
}

const toolsPath = findHarnessTools()
if (toolsPath === undefined) {
  console.error('could not locate the harness dsh-tools build; set DSH_HOME or install @deepseek-ai/dsh')
  process.exit(2)
}
console.log(`harness validators: ${toolsPath}`)
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(toolsPath).href)

// ---------------------------------------------------------------- plugin load

const plugin = await import(pathToFileURL(join(import.meta.dirname, 'index.js')).href)
const registered = []
const stubCtx = {
  logger: { info: (message) => console.log(`  [plugin] ${message}`), warn: (message) => console.log(`  [plugin warn] ${message}`) },
  get: () => undefined,
  tools: {
    register: (definition) => {
      registered.push(definition)
      return () => {}
    },
  },
}
plugin.apply(stubCtx, {})

console.log('\n1. plugin surface')
check('exports name', plugin.name === 'jev', `name=${plugin.name}`)
check('injects the tool registry', Array.isArray(plugin.inject) && plugin.inject.includes('tools'), JSON.stringify(plugin.inject))
check('registers exactly one tool', registered.length === 1, `count=${registered.length}`)
const tool = registered[0]
check('tool is named jev_evaluate', tool?.name === 'jev_evaluate', `name=${tool?.name}`)
check('execute is a function', typeof tool?.execute === 'function')
check('render is a function', typeof tool?.output?.render === 'function')
check('declares a cooperative timeout', typeof tool?.timeoutMs === 'number' && tool.timeoutMs > 0, `timeoutMs=${tool?.timeoutMs}`)
check('classifies as concurrency-safe', tool?.isConcurrencySafe?.({}) === true)

console.log('\n2. schemas against the harness checker')
try {
  assertSupportedJsonSchema(tool.parameters)
  check('parameters satisfy the supported JSON Schema subset', true)
} catch (error) {
  check('parameters satisfy the supported JSON Schema subset', false, error.message)
}
try {
  assertSupportedJsonSchema(tool.output.schema)
  check('output schema satisfies the supported JSON Schema subset', true)
} catch (error) {
  check('output schema satisfies the supported JSON Schema subset', false, error.message)
}

const validArgs = {
  state: 'The support agent issued a full refund to the customer on the third call.',
  questions: {
    refunded: { type: 'boolean', instructions: 'Was a refund issued?', criteria: { true: 'An amount was refunded', false: 'No refund mentioned' } },
    department: { type: 'choice', instructions: 'Which department handled this?', criteria: { billing: 'billing', technical: 'technical', other: 'anything else' } },
    frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['calm', 'mildly annoyed', 'furious'] },
  },
}
const paramViolations = validateJsonSchemaValue(tool.parameters, validArgs, '')
check('model-style arguments pass the declared parameter schema', paramViolations.length === 0, paramViolations.join('; '))

console.log('\n3. body validation without a network call')
const exec = { signal: new AbortController().signal }
const badType = await tool.execute({ state: 'x', questions: { q: { type: 'foo', instructions: 'y' } } }, exec)
check('unknown discriminator is rejected with the accepted set', badType.ok === false && /boolean.*choice.*score/.test(badType.error), JSON.stringify(badType))
const oneOption = await tool.execute({ state: 'x', questions: { q: { type: 'choice', instructions: 'y', criteria: { only: 'one' } } } }, exec)
check('a one-option choice is rejected', oneOption.ok === false && /at least 2 options/.test(oneOption.error), JSON.stringify(oneOption))
const noInstructions = await tool.execute({ state: 'x', questions: { q: { type: 'boolean' } } }, exec)
check('a question without instructions is rejected', noInstructions.ok === false && /instructions is required/.test(noInstructions.error), JSON.stringify(noInstructions))
const noKeyCfg = { apiKeyEnv: 'DSH_KEYSENTINEL_ABSENT_VARIABLE' }
registered.length = 0
plugin.apply(stubCtx, noKeyCfg)
const noKey = await registered[0].execute({ state: 'x', questions: { q: { type: 'boolean', instructions: 'y' } } }, exec)
check('a missing key fails with remediation, not a throw', noKey.ok === false && /no API gateway key/.test(noKey.error), JSON.stringify(noKey))

// ------------------------------------------------------------- live JEV calls

console.log('\n4. live gateway calls (real spend, fractions of a cent)')
check('AI_GATEWAY_API_KEY is NOT in the host environment (so the .env fallback supplies it)', process.env.AI_GATEWAY_API_KEY === undefined, `value present`)
const live = await tool.execute(validArgs, exec)
if (check('boolean + choice + score answered in one call', live.ok === true, live.error ?? JSON.stringify(live))) {
  const outputViolations = validateJsonSchemaValue(tool.output.schema, live, '')
  check('the canonical value satisfies the declared output schema', outputViolations.length === 0, outputViolations.join('; '))
  check('boolean answer carries a probability', typeof live.answers.refunded?.probability === 'number', JSON.stringify(live.answers.refunded))
  check('choice answer names one of the offered options', ['billing', 'technical', 'other'].includes(live.answers.department?.choice), JSON.stringify(live.answers.department))
  check('choice answer carries every probability', Object.keys(live.answers.department?.probabilities ?? {}).length === 3, JSON.stringify(live.answers.department))
  check('score answer carries its criteria label', typeof live.answers.frustration?.scoreLabel === 'string', JSON.stringify(live.answers.frustration))
  check('cost is reported', typeof live.costUsd === 'string' && live.costUsd !== '', JSON.stringify(live.costUsd))
  check('usage is reported', typeof live.usage?.inputTokens === 'number', JSON.stringify(live.usage))
  const rendered = tool.output.render(validArgs, live)
  check('render returns one non-empty text block', rendered.length === 1 && rendered[0].type === 'text' && rendered[0].text.length > 0, JSON.stringify(rendered).slice(0, 200))
  console.log('\n--- rendered for the model ---')
  console.log(rendered[0].text)
  console.log('--- end ---\n')
}

const noulCall = await tool.execute(
  {
    state: 'Payout failed three days in a row and the customer wrote in capitals.',
    questions: { urgent: { type: 'noul', instructions: 'Does this express urgency?' }, severity: { type: 'score', instructions: 'Severity', criteria: ['low', 'medium', 'high'] } },
  },
  exec,
)
check('the direct-API spelling "noul" is accepted as boolean', noulCall.ok === true, noulCall.error ?? JSON.stringify(noulCall))
if (noulCall.ok === true) {
  check('"noul" is reported as a tolerated spelling in warnings', Array.isArray(noulCall.warnings) && noulCall.warnings.some((w) => /noul/.test(w)), JSON.stringify(noulCall.warnings))
  check('normalized answer reports type boolean', noulCall.answers.urgent?.type === 'boolean', JSON.stringify(noulCall.answers.urgent))
  check('the canonical value still satisfies the output schema', validateJsonSchemaValue(tool.output.schema, noulCall, '').length === 0)
}

console.log('\n5. model-facing parameters')
console.log(JSON.stringify(tool.parameters, null, 2))

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
