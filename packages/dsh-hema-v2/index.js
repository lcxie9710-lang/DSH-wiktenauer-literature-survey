/**
 * HEMA v2 harness —— preset 层插件
 *
 * ## 为什么是 preset 层，不是 host 层
 *
 * Web 会话是**按 agent preset 逐代理组合工具**的，host 行不进会话里的 agent。
 * 早先那版（以及 parked eval 里的 armA）走的是 host 层 `insert`：
 * 那在 `dsh-headless` 下能用（headless 不挂 agent-presets roster），
 * 但在你真正使用的 GUI 会话里，工具根本不会出现。
 * 所以本包**不声明 `dsh.bundle`、不带 `cordis.patch.yml`**，
 * 模型可见的行全部写在 `preset/hema-v2/agent.cordis.yml` 里。
 *
 * ## 为什么规则由工具持有，而不是让模型自己数轮数
 *
 * DSH 的 `sendMessage` 只确认送达、**不返回子代理的答案**（工具描述明写），
 * 而且 subagent service 上没有任何 public 的 await-settlement：
 * continuable 子代理拿得到持久化，却无法被代码 await；能 await 的只有 one-shot。
 *
 * 于是本插件的分工恰好落回原始设计那句话：
 *   **Harness = 插件（持有状态、调 JEV、执行封顶）；Agent = 决策者与工人。**
 *
 * 插件负责所有**可被违反的**规则 —— 轮数、阈值、悬置、证据解引用失败即硬拦 ——
 * 并把这些规则放在工具里。模型想做第 4 轮也做不到：`hema_verify` 会直接拒。
 * 模型负责认知工作：分解题目、选定证据、撰写断言与报告，并可以用 continuable
 * subagent 保住 researcher 的对话（`send_message` 在它里面开新一轮）。
 *
 * ## 一次 run 的调用序列（模型侧）
 *
 *   hema_start(topic)                         → runId
 *   hema_decompose_check(runId, subQuestions) → pass / retry / suspend
 *   hema_verify(runId, atom, claims)          → 逐条裁决 / 打回原因 / 逐条证据诊断
 *   ...（被打回就改断言或换证据，再来一次，封顶 3 轮）
 *   hema_report_check(runId, report)          → 校验并**强制**补齐悬置节
 *   hema_finish(runId)                        → 审计与 trace 落盘
 *
 * 每一步都把「喂给 JEV 的 state 全文」写进 `jev-calls.jsonl`：
 * 只看"某条断言被判否"没用，必须能看到判官当时看到的是什么。
 */

import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

import {
  V2_ROOT, dereference,
  search as wikiSearch, prefixSearch as wikiPrefixSearch,
  outlinks as wikiOutlinks, fetchPage, pageOutline, sectionText,
} from './lib/wiki.mjs'
import { lookupTerm, glossarySize } from './lib/glossary.mjs'
import {
  createJev, THRESHOLD, SPECIFICITY_LABELS, judgeClaim, claimQuestions,
  decompositionQuestions, judgeDecomposition,
  perEvidenceQuestions, perEvidenceState, readPerEvidence,
} from './lib/jev.mjs'
import {
  normalizeClaims, assembleState, precheck, locatorLabel,
} from './lib/evidence.mjs'
import {
  DECOMPOSE_DEFAULTS, isHardGate,
  validateSubQuestions, buildDecompositionState, describeFailure,
} from './lib/decompose.mjs'
import { postcheck, enforceSuspension, REPORT_DEFAULTS, SUSPENSION_HEADING, renderBrief, buildReportBrief } from './lib/report.mjs'
import { renderTrace } from './harness/trace.mjs'

export const name = 'hema-v2'
/** 只消费工具注册表，不提供服务；也刻意不依赖任何 npm 包。 */
export const inject = ['tools']

/**
 * 版本路标。
 *
 * 加这个是因为实测吃过两次亏：改了插件、离线测试全绿、但会话里还是老行为 ——
 * 宿主进程一旦 import 过模块就进了 Node 的 ESM 缓存，而 base 里 `hmr` 是 disabled 的，
 * 所以**刷新页面不等于重载代码**。当时唯一的判断办法是对比进程启动时间，
 * 太绕了。现在把它写进工具输出：`hema_start` / `hema_status` 都会回这个号，
 * 一眼就能确认跑的是哪一版。
 *
 * 改插件行为时**记得同时 bump 这里和 package.json 的 version**。
 */
export const VERSION = '0.2.1'

export const DEFAULT_API_KEY_ENV = 'AI_GATEWAY_API_KEY'
export const RUN_ROOT = join(V2_ROOT, 'out', 'sessions')

// ─────────────────────────────────────────────────────────────
// 密钥解析（与 @ghogiel/dsh-jev 同序，含 DSH 凭据库）
// ─────────────────────────────────────────────────────────────

/** 与 dsh-jev 相同的候选 .env 位置 */
function candidateEnvFiles(dshHome) {
  const out = []
  if (process.env.DSH_HOME?.trim()) out.push(join(process.env.DSH_HOME.trim(), '.env'))
  if (process.env.HERMES_HOME?.trim()) out.push(join(process.env.HERMES_HOME.trim(), '.env'))
  out.push(join(V2_ROOT, '.env'))
  if (dshHome) out.push(join(dshHome, '.env'))
  return out
}

function readEnvValue(text, key) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    if (t.slice(0, eq).trim() !== key) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (v) return v
  }
  return undefined
}

/**
 * 解析 JEV key。顺序：行内 config → 环境变量 → **DSH 凭据库** → .env 文件。
 * 与 `@ghogiel/dsh-jev` 保持一致，所以 key 放哪一处都能用。
 */
export async function resolveApiKey(ctx, config = {}) {
  if (typeof config.apiKey === 'string' && config.apiKey.trim()) {
    return { value: config.apiKey.trim(), source: '插件行 config.apiKey' }
  }
  const envName = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.trim()
    ? config.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV

  const fromProcess = process.env[envName]
  if (typeof fromProcess === 'string' && fromProcess.trim()) {
    return { value: fromProcess.trim(), source: `环境变量 ${envName}` }
  }

  const credentials = ctx?.get?.('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(envName)
      if (typeof hit?.value === 'string' && hit.value.trim()) {
        return { value: hit.value.trim(), source: `DSH 凭据库（${hit.source ?? 'stored'}）` }
      }
    } catch (e) {
      ctx?.logger?.warn?.(`hema-v2: 凭据库查询 ${envName} 失败：${e.message}`)
    }
  }

  const dshHome = process.env.DSH_HOME?.trim() || null
  for (const file of candidateEnvFiles(dshHome)) {
    try {
      const v = readEnvValue(readFileSync(file, 'utf8'), envName)
      if (v) return { value: v, source: `文件 ${file}` }
    } catch { /* 缺失或不可读都正常，试下一个 */ }
  }
  return undefined
}

// ─────────────────────────────────────────────────────────────
// run 状态（进程内；插件每个 preset 只挂一次，所以状态按 runId 隔离）
// ─────────────────────────────────────────────────────────────

/**
 * 插件在 preset 的 standing scope 下**只挂载一次**，所有会话共享这一份。
 * 因此状态必须按 runId 显式隔离，不能有"当前 run"这种隐式全局量 ——
 * 否则两个会话同时研究会串。
 */
const runs = new Map()

const slug = (s, n = 32) => String(s ?? 'run')
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, n) || 'run'

function newRunId(topic) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let id = `${slug(topic, 24)}-${stamp}`
  let i = 2
  while (runs.has(id)) id = `${slug(topic, 24)}-${stamp}-${i++}`
  return id
}

function requireRun(runId) {
  const run = runs.get(runId)
  if (!run) throw new Error(`未知 runId「${runId}」。先调用 hema_start 开一个研究主题。`)
  return run
}

function saveRun(run, name, value) {
  try {
    writeFileSync(join(run.dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8')
  } catch { /* 审计写失败不影响主流程 */ }
}

function emit(run, e) {
  try { run.events.push({ at: new Date().toISOString(), ...e }) } catch { /* 忽略 */ }
}

// ─────────────────────────────────────────────────────────────
// 工具定义
// ─────────────────────────────────────────────────────────────

const RENDER_TEXT = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/**
 * 所有工具共用的输出声明：结构宽松，render 给人/模型看。
 *
 * render **必须容错**：DSH 对 `{ok:false, error}` 这类残缺返回值同样会调 render，
 * 而 render 正是模型实际读到的东西。render 一抛异常，模型看到的就是一句内部错误，
 * 而不是"哪里错了、下一步怎么办"。所以每个 render 都先挡空值再取字段。
 */
const out = (render) => ({
  schema: { type: 'object', additionalProperties: true },
  render: (args, value) => {
    if (render === undefined) return RENDER_TEXT(value)
    try {
      return RENDER_TEXT(render(value))
    } catch (e) {
      // 兜底：render 自己坏了也不能让模型看到堆栈
      return RENDER_TEXT(`（结果渲染失败：${e?.message ?? e}）\n\n原始返回值：\n${JSON.stringify(value, null, 2)}`)
    }
  },
})

const errLine = (v) => (v && v.ok === false && v.error ? `错误：${v.error}\n` : '')
const arr = (x) => (Array.isArray(x) ? x : [])

/**
 * `parameters` 必须是**完整的 JSON Schema**，不是 `{ 参数名: {type, required} }` 简写。
 *
 * 这个坑实测踩过，而且只在真机上才炸：
 *   Invalid schema for function 'hema_decompose_check':
 *   schema must be a JSON Schema of 'type: "object"', got 'type: null'
 * 原因：`dsh-wiktenauer` 用 `defineTool()` 注册，它会把简写**规范化**成 JSON Schema；
 * 而本插件为了零依赖用的是**普通对象注册**（与 `@ghogiel/dsh-jev` 一致），
 * 于是简写被当作原始 schema 直接送给模型 —— 没有顶层 `type`，正是 `type: null`。
 *
 * `props` 帮你把「属性表 + 必填表」拼成规范 schema；数组一律带 `items`。
 */
const props = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
})
const str = (description) => ({ type: 'string', description })
const bool = (description) => ({ type: 'boolean', description })
const objArray = (description, properties) => ({
  type: 'array',
  description,
  items: properties ? { type: 'object', properties, additionalProperties: true } : { type: 'object', additionalProperties: true },
})
const strArray = (description) => ({ type: 'array', description, items: { type: 'string' } })

export function apply(ctx, config = {}) {
  const cfg = {
    mode: config.jevMode ?? 'http',
    acceptRate: Number.isFinite(config.acceptRate) ? config.acceptRate : 0.5,
    outRoot: typeof config.outDir === 'string' && config.outDir.trim() ? config.outDir.trim() : RUN_ROOT,
    maxDecomposeRounds: Number.isFinite(config.maxDecomposeRounds) ? config.maxDecomposeRounds : DECOMPOSE_DEFAULTS.maxRounds,
    maxClaimRounds: Number.isFinite(config.maxClaimRounds) ? config.maxClaimRounds : 3,
    maxReportRounds: Number.isFinite(config.maxReportRounds) ? config.maxReportRounds : REPORT_DEFAULTS.maxRounds,
    // 哪些 A 组检查项是硬闸门。实测（真 JEV）：
    //   · 全局 coverage/independent 即使是结构良好的分解也只给 0.59~0.63（阈值 0.7），
    //     与糟糕分解的区分度也很弱（0.51）→ 降为**反馈信号**
    //   · answerable_* 四个子题全部 p=0.95~1.00，而实际证据可得性中位数只有 0.19
    //     → **已删除**（没有预测力）
    // 硬闸门只留下逐子题的 focus（范围松紧），它具体、可操作、可反驳。
    hardKeys: Array.isArray(config.hardKeys) && config.hardKeys.length
      ? config.hardKeys : ['answerable', 'focus'],
    apiKey: config.apiKey,
    apiKeyEnv: config.apiKeyEnv,
  }

  /** 建一次带 per-run 日志的 JEV 客户端 */
  async function makeJev(run) {
    let apiKey = cfg.apiKey
    let keySource = null
    if (cfg.mode === 'http') {
      const resolved = await resolveApiKey(ctx, cfg)
      if (!resolved) {
        throw new Error(
          'JEV 用 http 模式但没有找到 key。任选一处：环境变量 AI_GATEWAY_API_KEY、'
          + 'DSH 凭据库、<DSH_HOME>/.env、或本插件行 config.apiKey。'
          + '（想先只验管道可把本插件行 config.jevMode 设为 fixture。）',
        )
      }
      apiKey = resolved.value
      keySource = resolved.source
    }
    const jev = createJev({
      mode: cfg.mode, apiKey, acceptRate: cfg.acceptRate,
      logPath: join(run.dir, 'jev-calls.jsonl'), runId: run.runId,
    })
    run.keySource = keySource
    return jev
  }

  // ══════════════════════════════════════════════════════════════
  // 数据访问层：Wiktenauer wiki 工具 + 术语表查询
  //
  // 这 6 个工具原本由 v1 的独立包 `@ghogiel/dsh-weinao` 提供，现在并进本插件。
  // 合并的理由有两条，第二条才是关键：
  //
  // 1. 少一个包、少一层版本耦合（v1 那个包本来就是纯数据访问，不含研究流程）。
  // 2. **能把节 anchor 直接交给模型。** v1 的 `wiki_get_page` 只返回纯文本，
  //    于是研究者自行检索到的页面只能给整页定位符（anchor: null）——
  //    这是已知缺口。本插件的证据形态是 {page, anchor, revid}，
  //    所以 `wiki_get_page` 返回**带 anchor 的页面大纲**，`wiki_get_section` 再取正文。
  //    自行检索与 JEV 跳转收集由此具备同等精度。
  //
  // 证据仍然只以定位符传递：这些工具给模型读内容，但模型交给 hema_verify 的
  // 只能是定位符，正文由程序在拼 state 时自己去解引用。
  // ══════════════════════════════════════════════════════════════

  // 注册时顺手记名字：启动日志里的工具数不能手写。
  // 曾经手写成 "7 个工具" 而实际有 12 个 —— 这种数字一旦写死就会在加工具时静默失真。
  const registered = []
  const register = (tool) => { registered.push(tool.name); return ctx.tools.register(tool) }

  // ── wiki_search ─────────────────────────────────────────────
  register({
    name: 'wiki_search',
    description:
      'Full-text search Wiktenauer (the HEMA treatise library). Recall is LOW by design of the wiki: it has no CirrusSearch, so a technique term often returns only 1–3 hits. '
      + 'Treat this as a way to find PAGE TITLES, not content: then read the page with wiki_get_page. '
      + 'If it returns nothing, try wiki_prefix_search with the historical spelling instead.',
    parameters: props({
      query: str('Search keywords. Prefer historical/English terms (e.g. "Zornhau", "Bloßfechten"), not modern Chinese.'),
      limit: { type: 'integer', description: 'Maximum hits, default 10, cap 50.' },
    }, ['query']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      if (v.error) return `错误：${v.error}`
      const hits = arr(v.hits)
      if (!hits.length) return `Wiktenauer 全文检索没有结果。\n改试 wiki_prefix_search（按标题前缀），它对本 wiki 的召回通常更好。`
      return [`全文检索到 ${hits.length} 条（**召回低是本站特性**，别把它当"没有材料"的结论）：`,
        ...hits.map((h, i) => `${i + 1}. ${h.title}${h.wordcount ? `（${h.wordcount} 词）` : ''}\n   ${String(h.snippet ?? '').slice(0, 200)}`),
        '', '下一步：用 wiki_get_page 读最相关的那个标题，拿到带 anchor 的节列表。'].join('\n')
    }),
    async execute(args) {
      const q = String(args.query ?? '').trim()
      if (!q) return { ok: false, error: 'query 不能为空' }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, args.limit)) : 10
      try {
        return { ok: true, hits: await wikiSearch(q, limit) }
      } catch (e) { return { ok: false, error: `wiki 检索失败：${e.message ?? e}` } }
    },
  })

  // ── wiki_prefix_search ──────────────────────────────────────
  register({
    name: 'wiki_prefix_search',
    description:
      'Title-prefix search on Wiktenauer. Use it for spelling variants and disambiguation — the glossary may say "Zornhau" while the page is actually "Zornhaw". '
      + 'This usually beats wiki_search on this wiki.',
    parameters: props({
      prefix: str('Title prefix to match.'),
      limit: { type: 'integer', description: 'Maximum titles, default 10.' },
    }, ['prefix']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      if (v.error) return `错误：${v.error}`
      const titles = arr(v.titles)
      if (!titles.length) return '没有标题匹配这个前缀。'
      return [`前缀匹配到 ${titles.length} 个标题：`, ...titles.map((t, i) => `${i + 1}. ${t}`)].join('\n')
    }),
    async execute(args) {
      const p = String(args.prefix ?? '').trim()
      if (!p) return { ok: false, error: 'prefix 不能为空' }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 10
      try {
        return { ok: true, titles: await wikiPrefixSearch(p, limit) }
      } catch (e) { return { ok: false, error: `前缀检索失败：${e.message ?? e}` } }
    },
  })

  // ── wiki_get_page ───────────────────────────────────────────
  register({
    name: 'wiki_get_page',
    description:
      'Fetch a Wiktenauer page and return its OUTLINE: the revision id, the lead paragraph, and every section with its anchor, heading and size. '
      + 'It deliberately does NOT return the whole text — technique pages run to hundreds of thousands of characters. '
      + 'Pick the sections you need from the outline, then read them with wiki_get_section. '
      + 'The anchors are what you cite: an evidence locator is {page, anchor, revid}.',
    parameters: props({
      title: str('Exact page title, as returned by wiki_search or wiki_prefix_search.'),
      maxSections: { type: 'integer', description: 'How many sections to list, default 60.' },
    }, ['title']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      if (v.error) return `错误：${v.error}`
      const secs = arr(v.sections)
      const lines = [
        `页面：${v.page}`,
        `revid：${v.revid}　全文 ${v.totalChars} 字符　共 ${v.sectionCount} 节${v.sectionCount > secs.length ? `（只列出前 ${secs.length} 节）` : ''}`,
      ]
      if (v.lead) lines.push('', `导言：${v.lead}`)
      lines.push('', `节列表（**anchor 就是证据定位符里要用的那个字段**）：`)
      for (const s of secs) {
        lines.push(`  · ${s.heading || '(无标题)'}　anchor=\`${s.anchor}\`　${s.chars} 字符${s.paired === false ? '　⚠ 标题配对可疑' : ''}`)
      }
      lines.push('', '下一步：wiki_get_section(title, anchor) 读你需要的节。')
      lines.push(`引用这一页时的定位符形如：{"page": ${JSON.stringify(v.page)}, "anchor": "<上面的 anchor>", "revid": ${v.revid}}`)
      return lines.join('\n')
    }),
    async execute(args) {
      const title = String(args.title ?? '').trim()
      if (!title) return { ok: false, error: 'title 不能为空' }
      try {
        const doc = await fetchPage(title)
        return { ok: true, ...pageOutline(doc, { maxSections: Number.isFinite(args.maxSections) ? args.maxSections : 60 }) }
      } catch (e) { return { ok: false, error: `取页失败：${e.message ?? e}` } }
    },
  })

  // ── wiki_get_section ────────────────────────────────────────
  register({
    name: 'wiki_get_section',
    description:
      'Read one section of a Wiktenauer page by its anchor (or the whole page when anchor is empty). This is where the actual treatise text is. '
      + 'Long sections are truncated — read the neighbouring section if you need more.',
    parameters: props({
      title: str('Exact page title.'),
      anchor: str('Section anchor from wiki_get_page. Omit or leave empty to read the whole page (only for short pages).'),
      maxChars: { type: 'integer', description: 'Character budget, default 6000.' },
    }, ['title']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      if (v.error) return `错误：${v.error}`
      if (v.found === false) {
        return [`该 anchor 在这页上不存在：${v.anchor}`, '', '可用的 anchor：', ...arr(v.availableAnchors).map(a => `  · ${a}`)].join('\n')
      }
      const lines = [`${v.page}${v.heading ? ` ／ ${v.heading}` : '（整页）'}　${v.chars} 字符${v.truncated ? `（截断到 ${String(v.text ?? '').length}）` : ''}`, '', String(v.text ?? '')]
      lines.push('', `引用定位符：{"page": ${JSON.stringify(v.page)}, "anchor": ${v.anchor === null ? 'null' : JSON.stringify(v.anchor)}, "revid": ${v.revid}}`)
      return lines.join('\n')
    }),
    async execute(args) {
      const title = String(args.title ?? '').trim()
      if (!title) return { ok: false, error: 'title 不能为空' }
      const anchor = args.anchor === undefined || args.anchor === null || String(args.anchor).trim() === '' ? null : String(args.anchor).trim()
      try {
        const doc = await fetchPage(title)
        return { ok: true, ...sectionText(doc, anchor, { maxChars: Number.isFinite(args.maxChars) ? args.maxChars : 6000 }) }
      } catch (e) { return { ok: false, error: `取节失败：${e.message ?? e}` } }
    },
  })

  // ── wiki_get_links ──────────────────────────────────────────
  register({
    name: 'wiki_get_links',
    description:
      'List a Wiktenauer page\'s internal links. Use it to step from one treatise to related glosses, masters and techniques when your query terms are not finding pages.',
    parameters: props({ title: str('Exact page title.') }, ['title']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      if (v.error) return `错误：${v.error}`
      const links = arr(v.links)
      if (!links.length) return '这一页没有站内链接。'
      return [`${links.length} 个站内链接：`, ...links.slice(0, 80).map((t, i) => `${i + 1}. ${t}`),
        links.length > 80 ? `…（另有 ${links.length - 80} 个）` : ''].filter(Boolean).join('\n')
    }),
    async execute(args) {
      const title = String(args.title ?? '').trim()
      if (!title) return { ok: false, error: 'title 不能为空' }
      try {
        return { ok: true, links: await wikiOutlinks(title) }
      } catch (e) { return { ok: false, error: `取链接失败：${e.message ?? e}` } }
    },
  })

  // ── glossary_lookup ─────────────────────────────────────────
  register({
    name: 'glossary_lookup',
    description:
      'Look up a HEMA term in the bundled bilingual glossary (100+ entries): Chinese → German/English, or reverse. '
      + 'Use it to turn the Chinese wording of a research question into the historical spelling that Wiktenauer actually uses, and back. '
      + 'The glossary is the project\'s domain knowledge; the wiki\'s own spelling may still differ (Zornhau vs Zornhaw), so follow up with wiki_prefix_search.',
    parameters: props({
      term: str('The term to look up, in Chinese or German/English.'),
      limit: { type: 'integer', description: 'Maximum matches per direction, default 12.' },
    }, ['term']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      if (v.error) return `错误：${v.error}`
      const fwd = arr(v.forward)
      const rev = arr(v.reverse)
      const fmt = (rows) => rows.map(r => `  · ${r.zh}${r.de ? ` — de: ${r.de}` : ''}${r.en ? ` — en: ${r.en}` : ''}`)
      const lines = [`术语表（共 ${v.glossarySize} 条）查询：${v.term}`]
      if (!fwd.length && !rev.length) {
        lines.push('', '没有匹配。这本身有信息量：该词可能不在术语表里 ——')
        lines.push('那就直接用 wiki_prefix_search 拿历史拼写去试，别硬造中文术语。')
        return lines.join('\n')
      }
      if (fwd.length) { lines.push('', '中文 → 德/英：', ...fmt(fwd)) }
      if (rev.length) { lines.push('', '德/英 → 中文（写断言时用中文，这个方向更常用）：', ...fmt(rev)) }
      return lines.join('\n')
    }),
    async execute(args) {
      const term = String(args.term ?? '').trim()
      if (!term) return { ok: false, error: 'term 不能为空' }
      try {
        const { forward, reverse } = lookupTerm(term, { limit: Number.isFinite(args.limit) ? args.limit : 12 })
        return { ok: true, term, forward, reverse, glossarySize: glossarySize() }
      } catch (e) { return { ok: false, error: `查术语失败：${e.message ?? e}` } }
    },
  })

  // ── hema_start ──────────────────────────────────────────────
  register({
    name: 'hema_start',
    description:
      'Start a HEMA literature research topic on the v2 harness and get a runId. Every other hema_* tool needs that runId. '
      + 'The harness owns every hard rule (JEV thresholds, retry caps, evidence-suspension), so you cannot exceed them: '
      + 'the tools simply refuse. Flow: hema_start → hema_decompose_check → per sub-question '
      + '(collect evidence → hema_verify → revise and re-verify if rejected) → hema_report_check → hema_finish.',
    parameters: props({
      topic: str('The research topic / question to investigate.'),
    }, ['topic']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      const lim = v.limits ?? {}
      return [
        errLine(v),
        v.pluginVersion ? `插件版本: ${v.pluginVersion}` : '',
        v.runId ? `runId: ${v.runId}` : '',
        v.dir ? `输出目录: ${v.dir}` : '',
        v.mode ? `判官模式: ${v.mode}${v.mode === 'http' ? '' : '（非 http 时裁决是合成数据，只验管道）'}` : '',
        v.keySource ? `JEV key 来源: ${v.keySource}` : '',
        '',
        '下一步：调用 hema_decompose_check(runId, subQuestions)，把研究题目分解为方向集中的子题目。',
        lim.decomposeRounds ? `  · 分解检查封顶 ${lim.decomposeRounds} 轮` : '',
        lim.claimRounds ? `  · 每条子题的断言验证封顶 ${lim.claimRounds} 轮，超过即判「证据悬置」` : '',
        '  · 建议用 continuable subagent 做 researcher：它保留对话，打回时用 send_message 在同一对话里继续，不要重建。',
      ].filter(Boolean).join('\n')
    }),
    async execute(args) {
      const topic = String(args.topic ?? '').trim()
      if (!topic) return { ok: false, error: 'topic 不能为空' }
      const runId = newRunId(topic)
      const dir = join(cfg.outRoot, runId)
      mkdirSync(dir, { recursive: true })
      const run = {
        runId, topic, dir, mode: cfg.mode,
        createdAt: new Date().toISOString(),
        jev: null, keySource: null,
        decomposition: null,
        chains: {},          // atom -> { terms, rounds: [], accepted: [], insufficient: [], passedIds: Map }
        report: null,
        events: [],
        stats: { jevCalls: 0 },
      }
      run.jev = await makeJev(run)
      runs.set(runId, run)
      emit(run, { type: 'run_start', topic })
      return {
        ok: true, runId, dir, mode: cfg.mode, keySource: run.keySource,
        pluginVersion: VERSION,
        limits: {
          decomposeRounds: cfg.maxDecomposeRounds,
          claimRounds: cfg.maxClaimRounds,
          reportRounds: cfg.maxReportRounds,
        },
      }
    },
  })

  // ── hema_decompose_check ────────────────────────────────────
  register({
    name: 'hema_decompose_check',
    description:
      'Submit your decomposition of the research topic for the JEV A-group check (coverage / independence / per-sub-question '
      + 'answerability and focus). The harness counts rounds and caps them; when the cap is exhausted it returns '
      + 'status "suspend" and you must ask the user to edit the decomposition instead of retrying. '
      + 'A decomposition the user edited themselves is accepted without re-checking — call hema_decompose_check with '
      + 'userEdited: true to record that.',
    parameters: props({
      runId: str('The runId returned by hema_start.'),
      subQuestions: objArray(
        'Array of { id, text, terms? }. terms are historical (German/English) terms used to resolve starting wiki pages.',
        {
          id: str('Short stable id, e.g. "sq1".'),
          text: str('The sub-question.'),
          terms: strArray('Historical terms involved in this sub-question.'),
        },
      ),
      userEdited: bool('True when the user authored or edited this decomposition: accept without re-checking.'),
    }, ['runId', 'subQuestions']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      const sqs = arr(v.subQuestions)
      const lines = [errLine(v).trimEnd(), `状态: ${v.status ?? '?'}`, `第 ${v.round ?? '?'}／${v.maxRounds ?? '?'} 轮`].filter(Boolean)
      if (v.status === 'pass' || v.status === 'already_accepted') {
        lines.push(`分解已接受（${sqs.length} 条子题目）${v.userEdited ? ' —— 用户编辑，未重新检查' : ''}`, '', '接下来的子题目：')
        for (const s of sqs) lines.push(`  · ${s?.id}: ${s?.text}${s?.terms?.length ? `　terms: ${s.terms.join(', ')}` : ''}`)
        lines.push('', '对每条子题目：取证 → hema_verify（被打回就用 send_message 让同一个 researcher 改，别重建）。')
      } else if (v.status === 'retry') {
        if (arr(v.shapeIssues).length) {
          lines.push('', '结构不合法（先改格式，别急着调 JEV）：')
          for (const i of arr(v.shapeIssues)) lines.push(`  · ${i.code}`)
        }
        if (arr(v.failed).length) {
          lines.push('', '未通过项（[硬性] 决定去向；[提示] 只是改进建议）：')
          for (const f of arr(v.failed)) lines.push(`  · ${f.gate === 'hard' ? '[硬性]' : '[提示]'} ${f.label}：${f.detail}`)
        }
      } else if (v.status === 'suspend') {
        lines.push('', '轮数已用尽 —— **请把下面的分解交给用户编辑**，不要自行再试：')
        for (const s of sqs) lines.push(`  · ${s?.id}: ${s?.text}`)
        if (v.hint) lines.push('', v.hint)
        lines.push('', '用户改好后，调用 hema_decompose_check 时带 userEdited: true —— 用户编辑过的分解不再重新检查。')
      }
      return lines.join('\n')
    }),
    async execute(args) {
      const run = requireRun(String(args.runId ?? ''))
      if (run.decomposition?.status === 'accepted') {
        return { ok: true, status: 'already_accepted', round: run.decomposition.round, maxRounds: cfg.maxDecomposeRounds, subQuestions: run.decomposition.subQuestions }
      }
      const round = (run.decomposition?.round ?? 0) + 1
      const raw = Array.isArray(args.subQuestions) ? args.subQuestions : []

      // 用户编辑过的分解：按冻结规则**不再重新检查**
      if (args.userEdited === true) {
        const { subQuestions, issues } = validateSubQuestions(raw, DECOMPOSE_DEFAULTS)
        run.decomposition = { status: 'accepted', reason: 'USER_EDITED', round, subQuestions, userEdited: true, judgement: null }
        saveRun(run, '01-decomposition.json', run.decomposition)
        emit(run, { type: 'decompose_user_accepted', count: subQuestions.length, shapeIssues: issues })
        return { ok: true, status: 'pass', round, maxRounds: cfg.maxDecomposeRounds, subQuestions, userEdited: true, shapeIssues: issues }
      }

      if (round > cfg.maxDecomposeRounds) {
        return {
          ok: true, status: 'suspend', round: round - 1, maxRounds: cfg.maxDecomposeRounds,
          subQuestions: run.decomposition?.subQuestions ?? [], hint: run.decomposition?.hint ?? null,
        }
      }

      const { subQuestions, issues } = validateSubQuestions(raw, DECOMPOSE_DEFAULTS)
      if (issues.some(i => ['TOO_FEW_SUBQUESTIONS', 'EMPTY_SUBQUESTION', 'DUPLICATE_ID'].includes(i.code))) {
        run.decomposition = { status: 'needs_human', reason: 'SHAPE_INVALID', round, subQuestions, shapeIssues: issues, judgement: null }
        return { ok: true, status: 'retry', round, maxRounds: cfg.maxDecomposeRounds, shapeIssues: issues, failed: [], subQuestions }
      }

      run.stats.jevCalls++
      const res = await run.jev.ask(
        buildDecompositionState(run.topic, subQuestions),
        decompositionQuestions(subQuestions),
        { phase: 'decompose', label: `decompose-r${round}`, atom: run.topic, round },
      )
      if (!res.ok) return { ok: false, error: `JEV 调用失败：${res.error}` }

      const judgement = judgeDecomposition(res.answers, subQuestions)
      const gated = judgement.items.filter(i => isHardGate(i.key, { hardKeys: cfg.hardKeys }))
      const advisory = judgement.items.filter(i => !isHardGate(i.key, { hardKeys: cfg.hardKeys }))
      const gatedFailed = gated.filter(i => !i.pass)
      const pass = gatedFailed.length === 0

      run.decomposition = {
        status: pass ? 'accepted' : 'needs_human', reason: pass ? 'JEV_CHECK_PASSED' : 'CHECK_FAILED',
        round, subQuestions, judgement, gatedFailedCount: gatedFailed.length,
        advisoryFailedCount: advisory.filter(i => !i.pass).length,
        hint: gatedFailed.length ? `卡住的硬性检查：${gatedFailed.map(f => f.label).join('；')}` : null,
      }
      saveRun(run, '01-decomposition.json', run.decomposition)
      emit(run, {
        type: pass ? 'decompose_accepted' : 'decompose_rejected', round,
        gatedFailedKeys: gatedFailed.map(f => f.key), advisoryFailedKeys: advisory.filter(i => !i.pass).map(f => f.key),
      })

      if (pass) return { ok: true, status: 'pass', round, maxRounds: cfg.maxDecomposeRounds, subQuestions, judgement }

      const failed = [...gatedFailed, ...advisory.filter(i => !i.pass)].map(f => ({
        key: f.key, label: f.label, detail: describeFailure(f),
        gate: isHardGate(f.key, { hardKeys: cfg.hardKeys }) ? 'hard' : 'advisory',
      }))
      if (round >= cfg.maxDecomposeRounds) {
        return { ok: true, status: 'suspend', round, maxRounds: cfg.maxDecomposeRounds, subQuestions, failed, hint: run.decomposition.hint }
      }
      return { ok: true, status: 'retry', round, maxRounds: cfg.maxDecomposeRounds, subQuestions, failed }
    },
  })

  // ── hema_verify ─────────────────────────────────────────────
  register({
    name: 'hema_verify',
    description:
      'Submit an evidence-claim package for one sub-question and have JEV judge it. Each claim needs an id, the claim text, and '
      + 'evidence as WIKI LOCATORS — never quoted text: {"page": "...", "anchor": "...", "revid": 123} or a "Page#Anchor" string. '
      + 'The harness dereferences the locators, assembles what JEV sees, and applies the threshold. Evidence that cannot be '
      + 'dereferenced is a hard failure. Claims that already passed and are resubmitted unchanged are frozen and not re-judged. '
      + 'The harness counts rounds and caps them: at the cap a still-failing claim becomes "insufficient" (evidence suspended) '
      + 'and can never be silently accepted. On rejection it returns a per-evidence diagnosis telling you WHICH source failed.',
    parameters: props({
      runId: str('The runId returned by hema_start.'),
      atom: str('The sub-question these claims answer.'),
      claims: objArray(
        'Array of { id, claim, subQuestion?, evidence: [ {page, anchor, revid} | "Page#Anchor" ] }.',
        {
          id: str('Short stable id, e.g. "c1".'),
          claim: str('The assertion text, in the language of the research question.'),
          subQuestion: str('Optional: the atomic proposition this claim answers.'),
          evidence: {
            type: 'array',
            description: 'Wiki locators only — never quoted text. Each item is {page, anchor?, revid?} '
              + '(a bare "Page#Anchor" string is also accepted by the harness).',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                page: str('Wiktenauer page title, e.g. "Zornhaw".'),
                anchor: str('Section anchor; omit for the whole page.'),
                revid: { type: 'integer', description: 'Revision id that pins the version; omit to use the current one.' },
              },
              required: ['page'],
            },
          },
        },
      ),
    }, ['runId', 'atom', 'claims']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      if (v.error) return `错误：${v.error}`
      const results = arr(v.results)
      const counts = v.counts ?? {}
      const lines = [`状态：${v.status ?? '?'}　第 ${v.round ?? '?'}／${v.maxRounds ?? '?'} 轮`]
      lines.push(`本轮：送判 ${counts.verified ?? 0} 条；证据不成立被硬拦 ${counts.hardBlocked ?? 0} 条；冻结免验 ${counts.frozen ?? 0} 条`)
      if (results.length) {
        lines.push('', '逐条裁决：')
        for (const c of results) {
          const mark = c?.verdict === 'passed' ? '✔ 通过' : c?.verdict === 'insufficient' ? '⛔ 证据不成立' : '✘ 判否'
          lines.push(`  [${c?.id ?? '?'}] ${mark}${c?.frozen ? '（冻结：文本未变，未重复验证）' : ''}`)
          lines.push(`      ${String(c?.claim ?? '').slice(0, 120)}`)
          if (c?.verdict !== 'passed') {
            for (const r of arr(c?.reasons)) lines.push(`      · ${r}`)
            for (const s of arr(c?.sources)) lines.push(`      · 证据：${s}`)
            const diag = arr(c?.diagnosis)
            if (diag.length) {
              const bad = diag.filter(d => !d.supports)
              const good = diag.filter(d => d.supports)
              if (good.length) lines.push(`      ✔ 单独看支持该断言的来源：${good.map(d => d.label).join('；')}`)
              if (bad.length) lines.push(`      ✘ **不支持**的来源（考虑换掉）：${bad.map(d => `${d.label}（p=${d.p}）`).join('；')}`)
              if (!bad.length) lines.push('      注：每条来源单独看都不支持 —— 问题更可能在断言表述本身，而不是来源选择。')
            }
          }
        }
      }
      if (v.status === 'retry') {
        lines.push('', `还有 ${v.remaining ?? '?'} 轮。请针对上面的原因**换证据**或**改断言**，然后重新提交**全部**断言（已通过的可以原样带回）。`)
      } else if (v.status === 'suspend') {
        const ins = arr(v.insufficient)
        lines.push('', `轮数用尽。以下 ${ins.length || (v.insufficientCount ?? 0)} 条断言已判为「证据悬置」——它们不会成为结论，但会照实写进报告：`)
        for (const i of ins) lines.push(`  · [${i?.id}] ${String(i?.claim ?? '').slice(0, 110)}`)
      } else if (v.status === 'pass') {
        lines.push('', `全部通过（累计通过 ${v.acceptedCount ?? 0} 条）。继续下一条子题目，或开始写报告。`)
      }
      return lines.join('\n')
    }),
    async execute(args) {
      const run = requireRun(String(args.runId ?? ''))
      const atom = String(args.atom ?? '').trim()
      if (!atom) return { ok: false, error: 'atom 不能为空' }
      const chain = run.chains[atom] ?? (run.chains[atom] = { rounds: [], accepted: [], insufficient: [], passedIds: new Map() })
      const round = chain.rounds.length + 1

      const { claims, errors } = normalizeClaims(args.claims, { atom })
      if (!claims.length) {
        return { ok: false, error: `没有有效断言（形状错误：${JSON.stringify(errors)}）` }
      }
      if (round > cfg.maxClaimRounds) {
        return {
          ok: true, status: 'suspend', round: cfg.maxClaimRounds, maxRounds: cfg.maxClaimRounds,
          counts: { verified: 0, hardBlocked: 0, frozen: 0 }, results: [],
          insufficient: chain.insufficient, insufficientCount: chain.insufficient.length,
          acceptedCount: chain.accepted.length,
        }
      }

      // 冻结：已通过且文本未变的不重复问 JEV
      const toVerify = []
      const frozen = []
      for (const c of claims) {
        const p = chain.passedIds.get(c.id)
        if (p && p.claimText === c.claim) frozen.push(c)
        else toVerify.push(c)
      }

      const { state, perClaim } = await assembleState({ atom, claims: toVerify })
      const pc = precheck(toVerify, perClaim)
      const HARD = new Set(['NO_EVIDENCE', 'EVIDENCE_UNRESOLVABLE'])
      const hardBlocked = new Set(pc.issues.filter(i => HARD.has(i.code)).map(i => i.id))
      const askable = toVerify.filter(c => !hardBlocked.has(c.id))

      let answers = {}
      if (askable.length) {
        run.stats.jevCalls++
        const res = await run.jev.ask(state, claimQuestions(askable), {
          phase: 'claim-verify', label: `verify-${slug(atom, 16)}-r${round}`, atom, round,
        })
        if (!res.ok) return { ok: false, error: `JEV 调用失败：${res.error}` }
        answers = res.answers
      }

      const results = []
      const newlyPassed = []
      const failedThisRound = []
      for (const c of toVerify) {
        const pcm = perClaim.find(p => p.id === c.id)
        const sources = pcm?.sources ?? []
        const srcLabels = sources.map(s => s.label)

        if (hardBlocked.has(c.id)) {
          const issue = pc.issues.find(i => i.id === c.id && HARD.has(i.code))
          const rec = {
            id: c.id, claim: c.claim, verdict: 'insufficient', reason: issue.code,
            reasons: [issue.detail], sources: srcLabels, diagnosis: null,
          }
          results.push(rec); failedThisRound.push(rec)
          continue
        }

        const v = judgeClaim(answers, c)
        if (v.pass) {
          chain.passedIds.set(c.id, { claimText: c.claim, verdict: v, sources: srcLabels, round })
          newlyPassed.push(c.id)
          results.push({ id: c.id, claim: c.claim, verdict: 'passed', sources: srcLabels, reasons: [] })
          continue
        }

        // 失败路径的逐条证据诊断（只在判否、且挂了多个来源时问）
        let diagnosis = null
        if (sources.length >= 2) {
          const askSrc = sources.slice(0, 4)
          run.stats.jevCalls++
          const dres = await run.jev.ask(
            perEvidenceState(c, askSrc, atom),
            perEvidenceQuestions(c, askSrc),
            { phase: 'evidence-diagnosis', label: `diag-${c.id}-${slug(atom, 12)}-r${round}`, atom, round },
          )
          if (dres.ok) diagnosis = readPerEvidence(dres.answers, c.id, askSrc)
        }
        const rec = {
          id: c.id, claim: c.claim, verdict: 'rejected', reasons: v.reasons,
          sources: srcLabels, diagnosis,
          support: v.support, onTopic: v.onTopic, specificity: v.specificity,
        }
        results.push(rec); failedThisRound.push(rec)
      }

      for (const c of frozen) {
        const p = chain.passedIds.get(c.id)
        results.push({ id: c.id, claim: c.claim, verdict: 'passed', frozen: true, sources: p.sources, reasons: [] })
      }

      // 结算本轮的 insufficient（轮数用尽后仍失败的）
      const exhausted = round >= cfg.maxClaimRounds
      const stillFailing = new Map(chain.insufficient.map(i => [i.id, i]))
      for (const f of failedThisRound) {
        stillFailing.set(f.id, {
          id: f.id, claim: f.claim, reason: f.reason ?? 'ROUNDS_EXHAUSTED',
          detail: f.reason ? f.reasons[0] : `${cfg.maxClaimRounds} 轮内未通过验证，按「证据悬置」处理`,
          roundsAttempted: round, lastReasons: f.reasons, sources: f.sources ?? [],
        })
      }
      for (const id of chain.passedIds.keys()) stillFailing.delete(id)
      chain.insufficient = [...stillFailing.values()]
      chain.accepted = [...chain.passedIds.entries()].map(([id, v]) => ({
        id, claim: v.claimText, round: v.round, sources: v.sources,
        support: v.verdict.support, onTopic: v.verdict.onTopic, specificity: v.verdict.specificity,
      }))

      chain.rounds.push({
        round, results, failed: failedThisRound.map(f => ({ id: f.id, claim: f.claim, reasons: f.reasons, diagnosis: f.diagnosis })),
        verified: askable.length, hardBlocked: hardBlocked.size, frozen: frozen.length,
      })
      saveRun(run, `02-chain-${slug(atom, 24)}.json`, {
        atom, terms: chain.terms,
        accepted: chain.accepted, insufficient: chain.insufficient,
        rounds: chain.rounds.map(r => ({ round: r.round, verified: r.verified, hardBlocked: r.hardBlocked, frozen: r.frozen, results: r.results })),
      })
      emit(run, {
        type: 'verify_round', atom, round,
        passed: newlyPassed, rejected: failedThisRound.map(f => f.id),
      })

      const allPassed = chain.insufficient.length === 0
      const status = allPassed ? 'pass' : (exhausted ? 'suspend' : 'retry')
      return {
        ok: true, status, round, maxRounds: cfg.maxClaimRounds, remaining: Math.max(0, cfg.maxClaimRounds - round),
        counts: { verified: askable.length, hardBlocked: hardBlocked.size, frozen: frozen.length },
        results, acceptedCount: chain.accepted.length,
        insufficient: chain.insufficient, insufficientCount: chain.insufficient.length,
      }
    },
  })

  // ── hema_report_check ──────────────────────────────────────
  register({
    name: 'hema_report_check',
    description:
      'Submit the draft report for the deterministic post-check and get back the corrected report. This check does not involve a '
      + 'model: it verifies that a suspension section exists and names every unconfirmed claim, that every confirmed claim is '
      + 'reflected, and that the body does not cite a suspended source by its locator. When the draft misses suspended items the '
      + 'harness inserts them itself, so the returned report always carries the complete suspension list — do not drop it.',
    parameters: props({
      runId: str('The runId returned by hema_start.'),
      report: str('The draft report as Markdown.'),
    }, ['runId', 'report']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      if (v.error) return `错误：${v.error}`
      const lines = [v.pass ? '校验通过' : `校验未通过（${arr(v.issues).length} 项）`]
      for (const i of arr(v.issues)) lines.push(`  · [${i?.code}] ${i?.detail}`)
      // 原稿的问题也要报出来：不然模型不知道自己漏了悬置节，只看到"已补齐"，
      // 下一稿还会漏。补齐是兜底，不是可以依赖的行为。
      if (arr(v.draftIssues).length && !v.pass) {
        lines.push('', '你的原稿本身的问题：')
        for (const i of arr(v.draftIssues)) lines.push(`  · [${i?.code}] ${i?.detail}`)
      }
      if (v.appendedByCode) {
        lines.push('', '注：悬置节缺失条目已由程序补齐 —— 请使用返回的报告全文，不要用你的原稿覆盖它。')
        lines.push('（程序补齐是兜底，不是可以依赖的行为：下一稿请自己逐条写全悬置项。）')
      }
      lines.push('', '--- 报告全文 ---', '', String(v.report ?? ''))
      return lines.join('\n')
    }),
    async execute(args) {
      const run = requireRun(String(args.runId ?? ''))
      const draft = String(args.report ?? '')
      const accepted = Object.values(run.chains).flatMap(c => c.accepted)
      const insufficient = Object.values(run.chains).flatMap(c => c.insufficient)
      const brief = buildReportBrief({
        question: run.topic,
        decomposition: run.decomposition,
        chains: Object.keys(run.chains).map(a => ({ id: a, atom: a })),
        accepted, insufficient,
      })
      const enforced = enforceSuspension(draft, brief.insufficient)
      const check = postcheck(enforced, brief)
      // 原稿单独检查一次：补齐后自然"不缺悬置节"，只报补后结果会让模型
      // 永远不知道自己漏了 —— 下一稿还会漏，兜底就成了常态。
      const draftCheck = draft.trim() === enforced.trim() ? check : postcheck(draft, brief)
      const appendedByCode = enforced.trim() !== draft.trim()
      run.report = { draft, final: enforced, pass: check.pass, issues: check.issues, draftIssues: draftCheck.issues, appendedByCode, brief }
      saveRun(run, '04-report.md', enforced)
      saveRun(run, '04-report-check.json', { pass: check.pass, issues: check.issues, draftIssues: draftCheck.issues, appendedByCode })
      saveRun(run, '03-brief.json', brief)
      emit(run, { type: 'report_checked', pass: check.pass, appendedByCode, issues: check.issues.map(i => i.code), draftIssues: draftCheck.issues.map(i => i.code) })
      return {
        ok: true, pass: check.pass, issues: check.issues, draftIssues: draftCheck.issues,
        appendedByCode, report: enforced,
        stats: { accepted: accepted.length, insufficient: insufficient.length },
      }
    },
  })

  // ── hema_status ────────────────────────────────────────────
  register({
    name: 'hema_status',
    description: 'Read the harness-held state of a run: round counts used and remaining, and the accepted/insufficient claim tallies. '
      + 'Use it when you are unsure how many rounds are left — do not guess, the harness is authoritative.',
    parameters: props({ runId: str('The runId returned by hema_start.') }, ['runId']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      if (v.error) return `错误：${v.error}`
      const chains = arr(v.chains)
      const lines = [`runId: ${v.runId ?? '?'}`, `题目: ${v.topic ?? '?'}`, v.pluginVersion ? `插件版本: ${v.pluginVersion}` : '', `判官: ${v.mode ?? '?'}`, '']
      lines.push(`分解: ${v.decomposition?.status ?? '?'}${v.decomposition?.round ? `（第 ${v.decomposition.round}/${v.maxDecomposeRounds ?? '?'} 轮）` : ''}`)
      lines.push('', `子题目进度（验证封顶 ${v.maxClaimRounds ?? '?'} 轮）：`)
      if (!chains.length) lines.push('  （还没有）')
      for (const c of chains) {
        lines.push(`  · ${c?.atom}`)
        lines.push(`      验证轮数 ${c?.verifyRounds ?? 0}/${v.maxClaimRounds ?? '?'}`)
        lines.push(`      已通过 ${c?.accepted ?? 0} 条　证据悬置 ${c?.insufficient ?? 0} 条`)
      }
      const t = v.totals ?? {}
      lines.push('', `合计：通过 ${t.accepted ?? 0} 条，证据悬置 ${t.insufficient ?? 0} 条`)
      lines.push(`JEV 调用：${v.jevCalls ?? '?'}`)
      lines.push(`输出目录：${v.dir ?? '?'}`)
      return lines.join('\n')
    }),
    async execute(args) {
      const run = requireRun(String(args.runId ?? ''))
      const chains = Object.entries(run.chains).map(([atom, c]) => ({
        atom, verifyRounds: c.rounds?.length ?? 0,
        accepted: c.accepted?.length ?? 0,
        insufficient: c.insufficient?.length ?? 0,
      }))
      return {
        ok: true, runId: run.runId, topic: run.topic, mode: run.mode, dir: run.dir,
        pluginVersion: VERSION,
        maxDecomposeRounds: cfg.maxDecomposeRounds, maxClaimRounds: cfg.maxClaimRounds,
        decomposition: {
          status: run.decomposition?.status ?? 'pending',
          round: run.decomposition?.round ?? 0,
        },
        chains,
        totals: {
          accepted: chains.reduce((a, c) => a + c.accepted, 0),
          insufficient: chains.reduce((a, c) => a + c.insufficient, 0),
        },
        jevCalls: run.stats.jevCalls,
      }
    },
  })

  // ── hema_finish ────────────────────────────────────────────
  register({
    name: 'hema_finish',
    description: 'Close a run and write the audit trail and the human-readable trace to disk. Call it last; the runId stays readable '
      + 'in hema_status but the run should not be extended afterwards.',
    parameters: props({ runId: str('The runId returned by hema_start.') }, ['runId']),
    output: out((v) => {
      if (!v || typeof v !== 'object') return String(v ?? '')
      if (v.error) return `错误：${v.error}`
      return [
        `审计已落盘：${v.dir ?? '?'}`, '',
        '  ├ 00-trace.md          全链路时间线（含跳转轨迹与逐条裁决）',
        '  ├ 00-audit.json        汇总审计',
        '  ├ 00-events.jsonl      事件流',
        '  ├ 01-decomposition.json',
        '  ├ 02-chain-*.json',
        '  ├ 03-brief.json / 04-report.md / 04-report-check.json',
        `  └ jev-calls.jsonl      ${v.jevCalls ?? '?'} 次 JEV 调用（含喂进去的 state 全文）`,
        '',
        `本次：通过 ${v.accepted ?? 0} 条，证据悬置 ${v.insufficient ?? 0} 条`,
      ].join('\n')
    }),
    async execute(args) {
      const run = requireRun(String(args.runId ?? ''))
      const chains = Object.entries(run.chains).map(([atom, c]) => ({
        atom, accepted: c.accepted ?? [], insufficient: c.insufficient ?? [],
        history: (c.rounds ?? []).map(r => ({ round: r.round, claims: r.results, verifiedCount: r.verified, hardBlockedCount: r.hardBlocked, frozenCount: r.frozen })),
      }))
      const accepted = chains.flatMap(c => c.accepted.map(a => ({ ...a, atom: c.atom })))
      const insufficient = chains.flatMap(c => c.insufficient.map(a => ({ ...a, atom: c.atom })))

      let jevRecords = []
      try {
        jevRecords = readFileSync(join(run.dir, 'jev-calls.jsonl'), 'utf8')
          .split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      } catch { /* 没有就没有 */ }

      saveRun(run, '00-events.jsonl', run.events.map(e => JSON.stringify(e)).join('\n') + '\n')
      saveRun(run, '00-audit.json', {
        runId: run.runId, topic: run.topic, at: new Date().toISOString(),
        mode: run.mode, keySource: run.keySource,
        limits: { decompose: cfg.maxDecomposeRounds, claims: cfg.maxClaimRounds },
        decomposition: run.decomposition,
        chains: chains.map(c => ({
          atom: c.atom, rounds: c.history.length,
          accepted: c.accepted.map(a => ({ id: a.id, claim: a.claim, sources: a.sources })),
          insufficient: c.insufficient.map(i => ({ id: i.id, claim: i.claim, reason: i.reason, lastReasons: i.lastReasons })),
        })),
        report: run.report ? { pass: run.report.pass, issues: run.report.issues, appendedByCode: run.report.appendedByCode } : null,
        jev: { calls: jevRecords.length, byPhase: jevRecords.reduce((a, r) => { const k = r.phase ?? '?'; a[k] = (a[k] ?? 0) + 1; return a }, {}) },
      })
      saveRun(run, '00-trace.md', renderTrace({
        runId: run.runId, question: run.topic,
        decomposition: run.decomposition,
        chains,
        report: run.report
          ? { writerPassed: run.report.pass, rounds: 1, appendedByCode: run.report.appendedByCode, stats: { chars: run.report.final.length }, history: [{ round: 1, chars: run.report.final.length, check: { pass: run.report.pass, issues: run.report.issues } }] }
          : null,
        jevRecords,
        config: {
          jevMode: run.mode, acceptRate: cfg.acceptRate,
          maxDecomposeRounds: cfg.maxDecomposeRounds, maxClaimRounds: cfg.maxClaimRounds, maxReportRounds: cfg.maxReportRounds,
        },
      }))
      emit(run, { type: 'run_finish', accepted: accepted.length, insufficient: insufficient.length })
      saveRun(run, '00-events.jsonl', run.events.map(e => JSON.stringify(e)).join('\n') + '\n')

      return {
        ok: true, runId: run.runId, dir: run.dir,
        jevCalls: jevRecords.length,
        accepted: accepted.length, insufficient: insufficient.length,
      }
    },
  })

  ctx.logger?.info?.(`hema-v2 v${VERSION}: 已注册 ${registered.length} 个工具（${registered.join(', ')}）`
    + `｜判官模式 ${cfg.mode}；分解封顶 ${cfg.maxDecomposeRounds} 轮、断言 ${cfg.maxClaimRounds} 轮`)
}

// 供探针直接单测工具体，不必起一个 DSH 进程
export const __test = { runs, apply }
