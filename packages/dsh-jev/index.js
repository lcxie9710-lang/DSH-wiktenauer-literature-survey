/**
 * dsh-jev — the JEV evaluation model (`typesafe-ai/jev`) as a model-callable
 * DeepSeek Harness tool.
 *
 * JEV is not a language model. One call takes a `state` plus typed `questions`
 * and returns structured verdicts — a probability, a chosen option, or an
 * ordered score — and never prose. It has no context and no memory, so every
 * fact it must judge has to travel inside `state`.
 *
 * The module registers one tool and provides no service, so it is installed as
 * a plain dependency of a profile and named by an agent-preset row. There is no
 * `dsh.bundle` and no `cordis.patch.yml`: nothing here belongs on the host
 * plane, and a preset is what decides which sessions can call it.
 *
 * The wire protocol is the Vercel AI Gateway evaluation-model endpoint:
 * `POST <base>/evaluation-model`, the model id in the `ai-model-id` header (the
 * body carries no `model` field), four mandatory protocol headers, and
 * `boolean` as the yes/no discriminator. The direct TypeSafe API spells that
 * discriminator `noul`; it is accepted here as a synonym and normalized, so a
 * model that learned the other spelling still gets an answer.
 *
 * @module @ghogiel/dsh-jev
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Plugin name shown by the loader. */
export const name = 'jev'

/** The one service this plugin consumes: the tool registry. */
export const inject = ['tools']

const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai'
const DEFAULT_MODEL_ID = 'typesafe-ai/jev'
const DEFAULT_API_KEY_ENV = 'AI_GATEWAY_API_KEY'
const DEFAULT_TIMEOUT_MS = 120_000

/** Gateway protocol constants observed in the `@ai-sdk/gateway` client. */
const GATEWAY_PROTOCOL_VERSION = '0.0.1'
const EVALUATION_SPEC_VERSION = '4'

/** Question discriminators the gateway accepts. */
const QUESTION_TYPES = ['boolean', 'choice', 'score']

/** Direct-API spellings tolerated on input and normalized to the gateway name. */
const QUESTION_TYPE_ALIASES = { noul: 'boolean' }

/** Keys a question may carry into the request; anything else is reported. */
const QUESTION_KEYS = ['type', 'instructions', 'criteria']

/**
 * The canonical output contract every successful call returns. One shape covers
 * success and failure so the model reads a stable value: `ok` says which, and
 * exactly one of `answers` / `error` is meaningful.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Whether JEV returned answers. False means `error` explains why not.' },
    model: { type: 'string', description: 'The evaluation model id that answered.' },
    answers: {
      type: 'object',
      additionalProperties: true,
      description: 'Question id -> answer. boolean: { type, probability }. choice: { type, choice, probabilities, confidence? }. score: { type, score, scoreLabel?, probabilities, confidence? }.',
    },
    usage: {
      type: 'object',
      additionalProperties: true,
      description: 'Gateway-reported token counts for this call.',
    },
    rounding: {
      type: 'object',
      additionalProperties: true,
      description: 'Decimal places the gateway rounded probabilities and scores to.',
    },
    costUsd: { type: 'string', description: 'Gateway-reported cost of this call in US dollars.' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Accepted-but-suspicious input, and any gateway warnings.' },
    error: { type: 'string', description: 'Why the call produced no answers.' },
  },
  required: ['ok'],
  additionalProperties: false,
}

/**
 * Model-facing argument schema. `questions` is a map of question id to question,
 * which JSON Schema cannot type per value, so the description carries the
 * contract and the body validates it; a rejected question comes back as an
 * actionable `error` instead of a gateway 400.
 */
const PARAMETERS = {
  type: 'object',
  properties: {
    state: {
      description:
        'The complete material to judge: a string, or structured JSON (chat log, record, object, array). ' +
        'JEV sees nothing else — no conversation history, no files, no earlier call.',
      oneOf: [
        { type: 'string', description: 'Plain text (a message, a transcript, a claim).' },
        { type: 'object', additionalProperties: true, description: 'One structured record, or a map of fields to judge.' },
        { type: 'array', items: {}, description: 'A list — for example a chat log of { role, content } turns.' },
      ],
    },
    questions: {
      type: 'object',
      additionalProperties: true,
      description:
        'Map of question id -> question, at least one entry. Ids are yours; answers come back under the same ids. ' +
        'Each question is an object: { "type": "boolean" | "choice" | "score", "instructions": string | object, "criteria": ... }. ' +
        'boolean — criteria optional, {"true": "<what counts as yes>", "false": "<what counts as no>"}; the answer is the probability of true. ' +
        'choice — criteria required, a map of >= 2 option id -> description; the answer is one of those ids plus every probability. ' +
        'score — criteria required, an ordered array of >= 2 grade labels where index 0 is the lowest; the answer is an index plus every probability. ' +
        'Ask several questions in one call: they are judged against the same state for one price.',
    },
    timeoutSeconds: {
      type: 'integer',
      description: 'Per-call deadline in seconds. Defaults to 120 when omitted.',
    },
  },
  required: ['state', 'questions'],
}

/**
 * Render one answer line for the model.
 * @param id - the caller's question id.
 * @param answer - one normalized answer object.
 * @returns A single-line summary; unknown answer shapes fall back to JSON.
 */
function formatAnswer(id, answer) {
  const confidence = typeof answer.confidence === 'number' ? ` · confidence ${answer.confidence}` : ''
  if (answer.type === 'boolean' && typeof answer.probability === 'number') {
    return `${id} [boolean] p(true) = ${answer.probability}${confidence}`
  }
  if (answer.type === 'choice' && typeof answer.choice === 'string') {
    const chosen = typeof answer.probabilities?.[answer.choice] === 'number' ? ` (p ${answer.probabilities[answer.choice]})` : ''
    const others = Object.entries(answer.probabilities ?? {})
      .filter(([option]) => option !== answer.choice)
      .map(([option, probability]) => `${option} ${probability}`)
    return `${id} [choice] → ${answer.choice}${chosen}${others.length > 0 ? `; others: ${others.join(', ')}` : ''}${confidence}`
  }
  if (answer.type === 'score' && typeof answer.score === 'number') {
    const label = typeof answer.scoreLabel === 'string' ? ` = ${JSON.stringify(answer.scoreLabel)}` : ''
    const chosen = typeof answer.probabilities?.[String(Math.round(answer.score))] === 'number'
      ? ` (p ${answer.probabilities[String(Math.round(answer.score))]})`
      : ''
    const levels = Object.entries(answer.probabilities ?? {}).map(([index, probability]) => `${index} ${probability}`)
    return `${id} [score] → ${answer.score}${label}${chosen}${levels.length > 0 ? `; levels: ${levels.join(', ')}` : ''}${confidence}`
  }
  return `${id} ${JSON.stringify(answer)}`
}

/**
 * Project a canonical call value onto the model-facing text.
 * @param value - the value the tool body returned.
 * @returns One text block carrying the verdicts, or the failure reason.
 */
function renderValue(value) {
  if (value.ok !== true) return [{ type: 'text', text: `JEV call produced no answers: ${value.error ?? 'unknown reason'}` }]
  const lines = [`JEV judgement (${value.model})`]
  for (const [id, answer] of Object.entries(value.answers ?? {})) lines.push(`- ${formatAnswer(id, answer)}`)
  const meta = []
  if (value.costUsd !== undefined) meta.push(`cost $${value.costUsd}`)
  if (value.usage !== undefined) {
    meta.push(`${value.usage.inputTokens ?? '?'} in / ${value.usage.outputTokens ?? '?'} out tokens`)
  }
  if (meta.length > 0) lines.push(`(${meta.join('; ')})`)
  if (Array.isArray(value.warnings) && value.warnings.length > 0) lines.push(`warnings: ${value.warnings.join('; ')}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Whether a value is an ordinary JSON object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one key out of a dotenv-style file.
 * @param text - the file contents.
 * @param key - the variable name to look for.
 * @returns The value, or undefined when the key is absent or blank.
 */
function readEnvValue(text, key) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    if (line.slice(0, separator).trim().replace(/^export\s+/, '') !== key) continue
    let value = line.slice(separator + 1).trim()
    const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)
    if (value !== '') return value
  }
  return undefined
}

/**
 * Places to look for the key after the harness credential store declines.
 *
 * The store already covers the launch environment, the stored credential file,
 * the project `.env`, and `<harness home>/.env`; these are the remaining
 * sources a machine may hold, including one a sibling tool configured.
 * @returns Candidate `.env` paths, most authoritative first.
 */
function candidateEnvFiles() {
  const harnessHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  const candidates = [join(harnessHome, '.env')]
  const hermesHome = process.env.HERMES_HOME?.trim()
  if (hermesHome) candidates.push(join(hermesHome, '.env'))
  return candidates
}

/**
 * Resolve the gateway key for one call, so a rotated key takes effect on the
 * next request without a restart.
 * @param ctx - the plugin context, read for an optional credential store.
 * @param config - the preset row's configuration.
 * @returns The key with the source that supplied it, or undefined when absent.
 */
async function resolveApiKey(ctx, config) {
  if (typeof config.apiKey === 'string' && config.apiKey.trim() !== '') {
    return { value: config.apiKey.trim(), source: 'the plugin row\'s apiKey config' }
  }
  const envName = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.trim() !== '' ? config.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV

  const fromProcess = process.env[envName]
  if (typeof fromProcess === 'string' && fromProcess.trim() !== '') {
    return { value: fromProcess.trim(), source: `the ${envName} environment variable` }
  }

  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(envName)
      if (typeof hit?.value === 'string' && hit.value.trim() !== '') {
        return { value: hit.value.trim(), source: `the DSH credential store (${hit.source ?? 'stored'})` }
      }
    } catch (error) {
      ctx.logger.warn(`jev: credential store lookup for ${envName} failed: ${error.message}`)
    }
  }

  for (const file of candidateEnvFiles()) {
    try {
      const value = readEnvValue(readFileSync(file, 'utf8'), envName)
      if (value !== undefined) return { value, source: `${file}` }
    } catch {
      // Absent or unreadable candidates are expected; the next one may hold the key.
    }
  }
  return undefined
}

/**
 * Validate the questions map and compile it into the request body's form.
 * @param input - the model-supplied `questions` argument.
 * @returns The wire questions, plus every rejection and every tolerated oddity.
 */
function normalizeQuestions(input) {
  const errors = []
  const warnings = []
  const questions = {}
  if (!isPlainObject(input)) {
    return { questions, errors: ['questions must be an object mapping question id to question'], warnings }
  }
  const ids = Object.keys(input)
  if (ids.length === 0) errors.push('questions must contain at least one question')

  for (const id of ids) {
    const at = `questions.${id}`
    const question = input[id]
    if (!isPlainObject(question)) {
      errors.push(`${at} must be an object`)
      continue
    }
    const declared = question.type
    const type = typeof declared === 'string' ? QUESTION_TYPE_ALIASES[declared] ?? declared : undefined
    if (type === undefined || !QUESTION_TYPES.includes(type)) {
      errors.push(`${at}.type must be "boolean", "choice", or "score" (received ${JSON.stringify(declared)})`)
      continue
    }
    if (declared !== type) warnings.push(`${at}.type ${JSON.stringify(declared)} was read as ${JSON.stringify(type)} (the gateway name)`)
    if (!Object.hasOwn(question, 'instructions')) {
      errors.push(`${at}.instructions is required (a string, or structured JSON)`)
      continue
    }
    const extra = Object.keys(question).filter((key) => !QUESTION_KEYS.includes(key))
    if (extra.length > 0) warnings.push(`${at} ignored unknown ${extra.length === 1 ? 'key' : 'keys'}: ${extra.join(', ')}`)

    const criteria = question.criteria
    if (type === 'choice') {
      if (!isPlainObject(criteria)) {
        errors.push(`${at}.criteria is required for a choice question: a map of >= 2 option id -> description`)
        continue
      }
      const options = Object.keys(criteria)
      if (options.length < 2) errors.push(`${at}.criteria needs at least 2 options (received ${options.length})`)
    } else if (type === 'score') {
      if (!Array.isArray(criteria) || criteria.length < 2) {
        errors.push(`${at}.criteria is required for a score question: an ordered array of >= 2 grade labels, index 0 lowest`)
        continue
      }
      if (criteria.some((label) => typeof label !== 'string')) errors.push(`${at}.criteria must be an array of strings`)
    } else if (criteria !== undefined) {
      if (!isPlainObject(criteria)) errors.push(`${at}.criteria must be an object such as {"true": "...", "false": "..."} when given`)
      else {
        const unexpected = Object.keys(criteria).filter((key) => key !== 'true' && key !== 'false')
        if (unexpected.length > 0) warnings.push(`${at}.criteria has non-standard ${unexpected.length === 1 ? 'key' : 'keys'}: ${unexpected.join(', ')}`)
      }
    }

    questions[id] = criteria === undefined ? { type, instructions: question.instructions } : { type, instructions: question.instructions, criteria }
  }
  return { questions, errors, warnings }
}

/**
 * Turn one gateway response body into the canonical value.
 * @param body - the parsed response.
 * @param sent - the questions this call actually sent, for score labels and warnings.
 * @returns The canonical value, with gateway-only metadata folded into its answers.
 */
function normalizeResponse(body, sent) {
  const rawAnswers = isPlainObject(body?.answers) ? body.answers : {}
  const confidence = isPlainObject(body?.providerMetadata?.typesafe?.confidence) ? body.providerMetadata.typesafe.confidence : {}
  const answers = {}
  for (const [id, raw] of Object.entries(rawAnswers)) {
    if (!isPlainObject(raw)) {
      answers[id] = raw
      continue
    }
    const answer = { ...raw }
    const reported = confidence[id]
    if (typeof reported === 'number') answer.confidence = reported
    const criteria = sent[id]?.criteria
    if (answer.type === 'score' && typeof answer.score === 'number' && Array.isArray(criteria)) {
      const label = criteria[Math.round(answer.score)]
      if (typeof label === 'string') answer.scoreLabel = label
    }
    answers[id] = answer
  }

  const value = {
    ok: true,
    model: typeof body?.model === 'string' ? body.model : DEFAULT_MODEL_ID,
    answers,
  }
  const missing = Object.keys(sent).filter((id) => !Object.hasOwn(answers, id))
  if (isPlainObject(body?.usage)) value.usage = body.usage
  if (isPlainObject(body?.rounding)) value.rounding = body.rounding
  const cost = body?.providerMetadata?.gateway?.cost
  if (typeof cost === 'string') value.costUsd = cost
  value.warnings = [...(Array.isArray(body?.warnings) ? body.warnings.filter((entry) => typeof entry === 'string') : [])]
  if (missing.length > 0) value.warnings.push(`the gateway returned no answer for: ${missing.join(', ')}`)
  return value
}

/**
 * Describe a failed HTTP response, naming the known cause of a recognized status.
 * @param status - the response status code.
 * @param detail - the response body text.
 * @param model - the model id the call asked for.
 * @returns A message the model can act on.
 */
function describeHttpFailure(status, detail, model) {
  const trimmed = detail.trim().slice(0, 600)
  const hints = []
  if (status === 401 || status === 403) hints.push('the gateway rejected the API key: set AI_GATEWAY_API_KEY for the DSH host, or point the preset row\'s apiKeyEnv at the variable that holds it')
  if (status === 400) hints.push('a 400 usually means a protocol header or the request body was rejected; the raw message follows')
  if (status === 404) hints.push(`the gateway has no model ${model} — the only JEV id there is typesafe-ai/jev`)
  if (status === 429) hints.push('the gateway is rate-limiting this key; retry later or raise the plan')
  const suffix = hints.length > 0 ? ` (${hints.join('; ')})` : ''
  return `HTTP ${status}${suffix}: ${trimmed === '' ? '(empty response body)' : trimmed}`
}

/**
 * Register the JEV tool on the calling context's tool scope.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the preset row's configuration; every field is optional.
 */
export function apply(ctx, config = {}) {
  const baseUrl = (typeof config.baseUrl === 'string' && config.baseUrl.trim() !== '' ? config.baseUrl.trim() : DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = typeof config.model === 'string' && config.model.trim() !== '' ? config.model.trim() : DEFAULT_MODEL_ID
  const defaultTimeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const endpoint = `${baseUrl}/evaluation-model`

  ctx.tools.register({
    name: 'jev_evaluate',
    description:
      'Judge supplied material with JEV (typesafe-ai/jev), an evaluation model rather than a language model: it answers typed ' +
      'questions about a state with probabilities, a chosen option, or an ordered score, and never with prose. Everything to be ' +
      'judged must be inside `state` — JEV has no conversation history and no memory of earlier calls. Use it for classification, ' +
      'routing, gating, and scoring where a calibrated probability is more useful than a sentence. Probabilities come back rounded ' +
      'to two decimals. Several questions in one call share the same state and cost.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderValue(value),
    },
    timeoutMs: defaultTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { questions, errors, warnings } = normalizeQuestions(args.questions)
      const timeoutMs = Number.isFinite(args.timeoutSeconds) && args.timeoutSeconds > 0 ? args.timeoutSeconds * 1000 : defaultTimeoutMs
      if (errors.length > 0) {
        return { ok: false, error: `invalid questions: ${errors.join('; ')}` }
      }

      const key = await resolveApiKey(ctx, config)
      if (key === undefined) {
        return {
          ok: false,
          error:
            'no API gateway key. Set AI_GATEWAY_API_KEY in the DSH host environment, save it in the harness credential store, ' +
            'add it to <DSH_HOME>/.env, or give the preset row a config.apiKey.',
        }
      }

      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const signal = exec?.signal === undefined ? timeoutSignal : AbortSignal.any([exec.signal, timeoutSignal])
      let response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key.value}`,
            'Content-Type': 'application/json',
            'ai-gateway-protocol-version': GATEWAY_PROTOCOL_VERSION,
            'ai-gateway-auth-method': 'api-key',
            'ai-evaluation-model-specification-version': EVALUATION_SPEC_VERSION,
            'ai-model-id': model,
            'X-Title': 'DeepSeek Harness',
          },
          body: JSON.stringify({ state: args.state, questions }),
          signal,
        })
      } catch (error) {
        if (timeoutSignal.aborted) return { ok: false, error: `JEV did not answer within ${Math.round(timeoutMs / 1000)}s` }
        if (exec?.signal?.aborted === true) return { ok: false, error: 'JEV call was cancelled' }
        return { ok: false, error: `JEV request failed before a response: ${error.message}` }
      }

      const text = await response.text()
      if (!response.ok) {
        return { ok: false, error: `JEV request failed, ${describeHttpFailure(response.status, text, model)}` }
      }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        return { ok: false, error: `JEV returned a non-JSON body (HTTP ${response.status}): ${text.trim().slice(0, 300)}` }
      }
      if (!isPlainObject(body?.answers)) {
        return { ok: false, error: `JEV returned no answers object: ${text.trim().slice(0, 300)}` }
      }
      const value = normalizeResponse(body, questions)
      if (warnings.length > 0) value.warnings = [...warnings, ...(value.warnings ?? [])]
      return value
    },
  })

  ctx.logger.info(`jev: registered jev_evaluate (${model} via ${endpoint})`)
}
