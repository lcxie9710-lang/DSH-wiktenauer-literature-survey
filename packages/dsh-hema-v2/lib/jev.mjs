/**
 * JEV 客户端 + 三组问题契约 + 阈值判定
 *
 * JEV 是 evaluation model：一次调用吃 `state` + 一组带类型的 `questions`，
 * 返回结构化裁决（概率 / 选项 / 分数），从不输出散文。**它没有 context 也没有 memory**，
 * 所以「证据以定位符传递、需要时才解引用拼 state」这个设计，正好是它强制要求的。
 *
 * wire protocol（从 dsh-jev/index.js 读出，非猜测）：
 *   POST <base>/evaluation-model
 *   headers: Authorization: Bearer <key>
 *            ai-gateway-protocol-version: 0.0.1
 *            ai-gateway-auth-method: api-key
 *            ai-evaluation-model-specification-version: 4
 *            ai-model-id: typesafe-ai/jev
 *            X-Title: DeepSeek Harness
 *   body:   { state, questions }
 *   resp:   { answers: { <qid>: {type, ...} } }
 *
 * 问题类型：
 *   boolean  criteria 可选 {true,false}         → { type, probability }
 *   choice   criteria 必填，≥2 个 选项id→描述    → { type, choice, probabilities, confidence? }
 *   score    criteria 必填，≥2 个 有序等级标签   → { type, score, scoreLabel?, probabilities, confidence? }
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { V2_ROOT, tokenize } from './wiki.mjs'
import { normalizeTerms } from './glossary.mjs'

/** 统一通过阈值：所有 boolean 的 p(true)、choice 的目标选项概率，都用它 */
export const THRESHOLD = 0.7

/** score 类问题的等级标签（index 0 最低） */
export const SPECIFICITY_LABELS = ['纯废话或同义反复', '含糊', '有信息量', '具体可查证']
export const FOCUS_LABELS = ['过宽', '偏宽', '合适', '偏窄', '过窄']

/** score 类问题的"可接受等级集合"——按概率质量和判定，比"argmax 必须等于某级"稳 */
export const SPECIFICITY_ACCEPT = ['有信息量', '具体可查证']
export const FOCUS_ACCEPT = ['偏宽', '合适', '偏窄']

export const SUPPORT_VERDICTS = [
  'SUPPORTED', 'PARTIALLY_SUPPORTED', 'CONTRADICTED', 'NOT_IN_SOURCE', 'AMBIGUOUS',
]

const LOG_PATH = join(V2_ROOT, 'out', 'jev-log.jsonl')

// ─────────────────────────────────────────────────────────────
// 问题契约（三组）
// ─────────────────────────────────────────────────────────────

/**
 * A 组 · 分解检查。
 * 全部【正向表述】：「真/目标选项」= 通过。
 *
 * **只有两个全局二元判断 + 每个子题一个 focus。** 原来还有一个逐子题的
 * `answerable_*`（"该子题能否通过 wiki 文献取证回答"），**已按实测删除**：
 * 一次真实 run 里四个子题目（含明显的后世社会史问题）全部拿到 p=0.95–1.00，
 * 而同一批子题目的实际证据可得性中位数只有 0.19、只收集到 0–3 页。
 * 它对"能不能取到证"**没有预测力**，却占着一个硬闸门的位置 ——
 * 只会多花调用、多造否决理由。宁可少一个假闸门。
 */
export function decompositionQuestions(subQuestions) {
  const questions = {
    coverage: {
      type: 'boolean',
      instructions: 'state 中列出的子题目，合起来是否覆盖了原问题的主要方面？',
      criteria: { true: '覆盖了原问题的主要方面', false: '有明显方面被漏掉' },
    },
    independent: {
      type: 'boolean',
      instructions: '这些子题目之间是否相互独立、没有明显的内容重叠？',
      criteria: { true: '相互独立、无明显重叠', false: '存在明显重叠' },
    },
  }
  for (const sq of subQuestions) {
    questions[`focus_${sq.id}`] = {
      type: 'score',
      instructions: `子题目「${sq.text}」的范围松紧程度如何？（过宽=需要整本书才能回答；合适=可在一个研究轮次内取证回答；过窄=几乎没有研究价值）`,
      criteria: FOCUS_LABELS,
    }
  }
  return questions
}

/**
 * B 组 + C 组 · 断言验证（同一次调用，共享 state 与成本）。
 * B 判"证据是否支持断言"；C 防 claim 漂移（是否仍在回答原子命题 + 具体程度）。
 */
export function claimQuestions(claims) {
  const questions = {}
  for (const c of claims) {
    questions[`support_${c.id}`] = {
      type: 'choice',
      instructions: `state 里【证据 ${c.id}】给出的证据文本，是否支持【断言 ${c.id}】「${c.claim}」？请只根据证据文本本身判断，不要因为断言"看起来合理"就判 SUPPORTED。`,
      criteria: {
        SUPPORTED: '证据明确表达了该断言的内容',
        PARTIALLY_SUPPORTED: '证据部分支持，但有不一致或缺漏的细节',
        CONTRADICTED: '证据表达了与断言相反的意思',
        NOT_IN_SOURCE: '证据里找不到与该断言相关的内容',
        AMBIGUOUS: '证据与该断言相关，但表述含糊，无法确定是否支持',
      },
    }
    questions[`on_topic_${c.id}`] = {
      type: 'boolean',
      instructions: `断言「${c.claim}」是否仍然在回答原子命题「${c.subQuestion}」？（不是问它是否正确，而是问它有没有跑题或被削弱成废话）`,
      criteria: { true: '仍在回答该原子命题', false: '已经偏离该原子命题，或已被削弱到失去信息量' },
    }
    questions[`specificity_${c.id}`] = {
      type: 'score',
      instructions: `断言「${c.claim}」的具体程度如何？`,
      criteria: SPECIFICITY_LABELS,
    }
  }
  return questions
}

/**
 * 失败路径专用：逐条证据诊断。
 *
 * 只有在断言**已被判否**时才问，因为这是纯诊断、不参与通过判定，
 * 属于失败路径的额外成本。目的很具体：researcher 被打回时需要知道
 * 「是我这条断言错了，还是我引错了来源」，否则它只能盲改。
 *
 * 一条断言挂多个来源时，聚合判定说不出哪个来源有问题 ——
 * 而"换掉错的那个来源"往往正是修好它的最短路径。
 *
 * @param {{id:string, claim:string, subQuestion:string}} claim
 * @param {Array<{label:string}>} sources
 */
export function perEvidenceQuestions(claim, sources) {
  const questions = {}
  sources.forEach((s, i) => {
    questions[`ev_${claim.id}_${i}`] = {
      type: 'boolean',
      instructions: `【证据 ${i + 1}】单独来看，是否支持断言「${claim.claim}」？`
        + `只根据这一段证据判断，不要参考其他来源，也不要因为断言看起来合理就判真。`,
      criteria: { true: '这一段证据本身就支持该断言', false: '这一段证据本身不支持该断言' },
    }
  })
  return questions
}

/** 逐条证据诊断用的 state：每条来源单独成块，便于判官分别看 */
export function perEvidenceState(claim, sources, atom = '') {
  const blocks = [`【原子命题】${atom || claim.subQuestion || ''}`, `【断言】${claim.claim}`]
  sources.forEach((s, i) => {
    blocks.push(`【证据 ${i + 1}】`, `<来源：${s.label}>`, String(s.text ?? '(无内容)'))
  })
  return blocks.join('\n')
}

/** 把诊断答案折成可读清单，塞进给 researcher 的打回说明 */
export function readPerEvidence(answers, claimId, sources) {
  return sources.map((s, i) => {
    const a = answers?.[`ev_${claimId}_${i}`]
    const p = typeof a?.probability === 'number' ? a.probability : null
    return {
      index: i + 1,
      label: s.label,
      supports: p !== null && p >= THRESHOLD,
      p,
    }
  })
}

// ─────────────────────────────────────────────────────────────
// 判定：把 answers 折成 通过/不通过
// ─────────────────────────────────────────────────────────────

const pOf = (a) => (typeof a?.probability === 'number' ? a.probability : null)

/** boolean 通过 */
export function passBoolean(answer) {
  const p = pOf(answer)
  return { pass: p !== null && p >= THRESHOLD, p, threshold: THRESHOLD }
}

/**
 * choice 通过：**目标选项的概率必须 ≥ 阈值**。
 * 没有 probabilities 时才退回 argmax 判等。故意不用 `||`——否则
 * choice=SUPPORTED 但 p=0.55（PARTIALLY 0.40）这种犹豫裁决会蒙混过关，
 * 而它恰恰是最该被打回重搜的情况。
 */
export function passChoice(answer, target) {
  const raw = answer?.probabilities?.[target]
  const p = typeof raw === 'number' ? raw : null
  const chosen = answer?.choice ?? null
  const pass = p !== null ? p >= THRESHOLD : chosen === target
  return { pass, chosen, p, target, threshold: THRESHOLD, judgedBy: p !== null ? 'probability' : 'argmax' }
}

/**
 * score 通过：**可接受等级的概率质量和 ≥ 阈值**。
 *
 * 比"argmax 必须正好落在某一级"稳：概率摊在相邻两级时，质量法仍能正确通过。
 * 实测（真 JEV）：空泛断言 mass=0、半空泛 0.49、具体 0.98 —— 单调且区分清晰。
 *
 * **注意真 JEV 的 score 语义**（实测得出，与直觉相反）：
 *   `score` 是**浮点期望值**（4 级量表上返回 0.69 / 1.48 / 2.93），**不是整数索引**；
 *   而且**不返回 `scoreLabel`**。所以标签必须由概率分布的 argmax 推出来，
 *   绝不能拿 `score` 去当数组下标。
 */
export function passScore(answer, acceptLabels, labels) {
  const probs = answer?.probabilities ?? {}
  let mass = 0
  let bestIdx = -1
  let bestP = -1
  for (const [k, v] of Object.entries(probs)) {
    const idx = Number(k)
    const label = Number.isFinite(idx) ? labels[idx] : undefined
    const p = typeof v === 'number' ? v : 0
    if (acceptLabels.includes(label)) mass += p
    if (p > bestP) { bestP = p; bestIdx = idx }
  }
  return {
    pass: mass >= THRESHOLD,
    mass: Number(mass.toFixed(4)),
    // 优先用返回值（若某天 JEV 开始返回），否则按分布 argmax 推，最后才退回浮点 score 取整
    scoreLabel: answer?.scoreLabel
      ?? (Number.isFinite(bestIdx) ? labels[bestIdx] : undefined)
      ?? (typeof answer?.score === 'number' ? labels[Math.round(answer.score)] : null)
      ?? null,
    scoreValue: typeof answer?.score === 'number' ? answer.score : null,
    accept: acceptLabels, threshold: THRESHOLD,
  }
}

/** A 组总判定 */
export function judgeDecomposition(answers, subQuestions) {
  const items = []
  items.push({ key: 'coverage', label: '覆盖原问题主要方面', ...passBoolean(answers.coverage) })
  items.push({ key: 'independent', label: '子题目相互独立', ...passBoolean(answers.independent) })
  for (const sq of subQuestions) {
    items.push({ key: `focus_${sq.id}`, label: `子题范围合适: ${sq.text}`, ...passScore(answers[`focus_${sq.id}`], FOCUS_ACCEPT, FOCUS_LABELS) })
  }
  const failed = items.filter(i => !i.pass)
  return { pass: failed.length === 0, items, failed, failedCount: failed.length }
}

/** B+C 组总判定（每条断言） */
export function judgeClaim(answers, claim) {
  const b = passChoice(answers[`support_${claim.id}`], 'SUPPORTED')
  const onTopic = passBoolean(answers[`on_topic_${claim.id}`])
  const spec = passScore(answers[`specificity_${claim.id}`], SPECIFICITY_ACCEPT, SPECIFICITY_LABELS)
  const reasons = []
  if (!b.pass) reasons.push(`证据不支持（judged=${b.chosen}, p(SUPPORTED)=${b.p}）`)
  if (!onTopic.pass) reasons.push(`已偏离原子命题（p=${onTopic.p}）`)
  if (!spec.pass) reasons.push(`断言过于空泛（可接受等级质量=${spec.mass}）`)
  return { pass: reasons.length === 0, support: b, onTopic, specificity: spec, reasons }
}

// ─────────────────────────────────────────────────────────────
// 客户端：http（真 JEV）/ stub（本地联调）
// ─────────────────────────────────────────────────────────────

/**
 * 模糊词面重叠：精确匹配置信，或长度 ≥6 的词共享前 4 字符前缀。
 * stub 必须用这个 —— 否则 Zornhaw(页) vs Zornhau(术语表) 差一个字母就判零相关，
 * 走出来的图完全随机，探针也就验不到收集路径。
 */
export function fuzzyShared(wordsA, wordsB) {
  const exact = new Set(wordsB)
  const prefixes = new Set(wordsB.filter(w => w.length >= 6).map(w => w.slice(0, 4)))
  let n = 0
  for (const w of wordsA) {
    if (exact.has(w)) { n++; continue }
    if (w.length >= 6 && prefixes.has(w.slice(0, 4))) n++
  }
  return n
}

function logRecord(rec, logPath = LOG_PATH) {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, JSON.stringify(rec) + '\n', 'utf8')
  } catch { /* 日志失败不影响主流程 */ }
}

/**
 * stub 判官：不需要网络，用确定性启发式给出**形状正确**的 answers。
 * 用途：把 1c–5 全部跑通（抓取/切片/循环/轮数/状态机/审计），只有裁决质量是假的。
 *
 * 启发式（故意做得简单，只保证形状与单调性）：
 *   support      —— 断言归一化后的源语言词在证据文本里的命中率
 *   on_topic     —— 只判退化（断言无内容词）；漂移检测 stub 无能为力，交真 JEV
 *   specificity  —— 断言源语言词数
 *   relevance    —— 页面标题与原子命题的模糊共有词
 *   next         —— 候选标题与原子命题的模糊共有词中最高者
 *
 * 因此 stub 通过 ≠ 裁决正确。它的价值在于让 1c–5 的抓取/切片/循环/轮数/状态机/审计全部可跑。
 */
export function makeStubAnswers(state, questions) {
  const st = typeof state === 'string' ? state : JSON.stringify(state)
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const grab = (tag) => {
    const m = st.match(new RegExp(`【${esc(tag)}】([\\s\\S]*?)(?=【|$)`))
    return m ? m[1].trim() : ''
  }
  const subq = grab('原子命题')

  // 多断言 state（evidence.mjs 的规范格式）：`【断言 c1】` / `【证据 c1】`
  // 旧单断言格式（【断言】/【证据文本】）保留兜底，便于早期探针复用。
  const idOf = (qid) => qid.replace(/^(support|on_topic|specificity)_/, '')
  const claimTextFor = (qid) => grab(`断言 ${idOf(qid)}`) || grab('断言')
  const evidenceFor = (qid) => grab(`证据 ${idOf(qid)}`) || grab('证据文本') || grab('当前页面内容') || ''
  const wordsOf = (t) => [...new Set(tokenize(normalizeTerms(t)))]
  /**
   * 断言对证据的覆盖率。这里有两处必须小心，都是踩过的坑：
   *
   * 1. **两边要做同样的归一化。** 早先只归一化断言、不归一化证据，
   *    于是术语表把断言里的中文换成德语后，那些德语词在未归一化的证据里找不到，
   *    覆盖率被无端拉低。
   *
   * 2. **证据是否含中文，决定用哪把尺子。**
   *    · 证据含中文 → 全部词都参与核对（中文 bigram 有意义）。
   *    · 证据是纯德/英文 → **只用拉丁词**。因为中文 bigram 在德英正文里
   *      永远不可能出现，拿它算覆盖率会把每一条中文断言都判成 NOT_IN_SOURCE
   *      —— 不是断言错了，是尺子错了。这时可核对的内容就是术语
   *      （Zornhau / Vom Tag / upper right），它们才真的能去证据里查。
   *
   * 注意不能简单地对两种尺子取 max：断言里只要含一个专名（Zornhau），
   * 拉丁覆盖率就恒为 1.0，弱断言也会被放过，尺子就失去区分力了。
   * 真 JEV 是语义判定，不受这里影响；这里只是让 stub 的尺子对准。
   */
  const supportRatio = (qid) => {
    const claimRaw = claimTextFor(qid)
    const evRaw = evidenceFor(qid)
    const ev = normalizeTerms(evRaw).toLowerCase()
    const all = wordsOf(claimRaw)
    if (!all.length) return 0
    const evHasCJK = /[\u3400-\u9fff]/.test(evRaw)
    const toks = evHasCJK ? all : all.filter(w => /^[a-zà-ÿ]{3,}$/i.test(w))
    const use = toks.length ? toks : all
    return use.filter(x => ev.includes(x)).length / use.length
  }

  const answers = {}
  for (const [id, q] of Object.entries(questions)) {
    if (id.startsWith('support_')) {
      const ratio = supportRatio(id)
      let verdict, probs
      if (ratio >= 0.6) { verdict = 'SUPPORTED'; probs = { SUPPORTED: 0.86, PARTIALLY_SUPPORTED: 0.1, AMBIGUOUS: 0.02, NOT_IN_SOURCE: 0.01, CONTRADICTED: 0.01 } }
      else if (ratio >= 0.3) { verdict = 'PARTIALLY_SUPPORTED'; probs = { SUPPORTED: 0.3, PARTIALLY_SUPPORTED: 0.55, AMBIGUOUS: 0.1, NOT_IN_SOURCE: 0.04, CONTRADICTED: 0.01 } }
      else { verdict = 'NOT_IN_SOURCE'; probs = { SUPPORTED: 0.05, PARTIALLY_SUPPORTED: 0.1, AMBIGUOUS: 0.1, NOT_IN_SOURCE: 0.74, CONTRADICTED: 0.01 } }
      answers[id] = { type: 'choice', choice: verdict, probabilities: probs, confidence: 0.7 }
    } else if (id.startsWith('on_topic_')) {
      const p = wordsOf(claimTextFor(id)).length >= 2 ? 0.9 : 0.3
      answers[id] = { type: 'boolean', probability: p }
    } else if (id.startsWith('specificity_')) {
      const n = wordsOf(claimTextFor(id)).length
      const idx = n >= 6 ? 3 : n >= 3 ? 2 : 1
      const probabilities = {}
      for (let i = 0; i < SPECIFICITY_LABELS.length; i++) probabilities[String(i)] = i === idx ? 0.7 : 0.1
      answers[id] = { type: 'score', score: idx, scoreLabel: SPECIFICITY_LABELS[idx], probabilities }
    } else if (id === 'coverage' || id === 'independent') {
      answers[id] = { type: 'boolean', probability: 0.9 }
    } else if (id.startsWith('focus_')) {
      const probabilities = {}
      for (let i = 0; i < FOCUS_LABELS.length; i++) probabilities[String(i)] = i === 2 ? 0.75 : 0.0625
      answers[id] = { type: 'score', score: 2, scoreLabel: FOCUS_LABELS[2], probabilities }
    } else if (id === 'relevance') {
      const title = grab('当前页面')
      const tw = [...new Set(tokenize(normalizeTerms(title)))]
      const sw = [...new Set(tokenize(normalizeTerms(subq)))]
      const shared = fuzzyShared(tw, sw)
      const p = Math.min(0.95, 0.25 + (tw.length ? shared / tw.length : 0) * 0.9)
      answers[id] = { type: 'boolean', probability: Number(p.toFixed(3)) }
    } else if (id === 'next') {
      // 候选标题里与原子命题模糊重叠最多的那个。
      // NONE 必须参与同一次归一化 —— 先归一化候选再硬塞 NONE=0.1 会得到总和 1.1
      // 的非法分布，而真 JEV 返回的是合法分布；stub 在这里不老实会掩盖下游 bug。
      const sw = [...new Set(tokenize(normalizeTerms(subq)))]
      const scores = {}
      let total = 0
      for (const key of Object.keys(q.criteria ?? {})) {
        if (key === 'NONE') continue
        const desc = String(q.criteria[key])
        const dw = [...new Set(tokenize(normalizeTerms(desc)))]
        const sc = fuzzyShared(dw, sw)
        scores[key] = sc
        total += sc
      }
      let bestKey = 'NONE'
      let bestScore = 0
      for (const [k, v] of Object.entries(scores)) if (v > bestScore) { bestScore = v; bestKey = k }
      const noneScore = bestScore > 0 ? total * 0.11 : 1
      const grand = total + noneScore
      const out = {}
      for (const [k, v] of Object.entries(scores)) out[k] = Number((v / grand).toFixed(4))
      out.NONE = Number((noneScore / grand).toFixed(4))
      answers[id] = { type: 'choice', choice: bestScore > 0 ? bestKey : 'NONE', probabilities: out, confidence: 0.6 }
    } else {
      answers[id] = { type: 'boolean', probability: 0.5 }
    }
  }
  return answers
}

/**
 * fixture 判官：按断言文本的稳定哈希决定通过与否。
 *
 * 它存在的理由：`stub` 是词袋代理，对「中文断言 + 括号术语 vs 德文正文」这种真实形态
 * 只能给出 ~0.4 的覆盖率，**无论断言好坏都会落在不通过区**。于是真实内容跑下来
 * 永远是"全被拒"，通过路径一次都走不到 —— 那样就没法证明通过路径接得对。
 *
 * fixture 把「裁决质量」和「裁决路由」解耦：
 *   · 裁决质量 → 只有真 JEV 能验（用户手里）
 *   · 裁决路由 → 用 fixture 给出**可控且可复现**的混合裁决，验证
 *                 接受/打回/重试/证据悬置/报告汇总 这一整套流转
 * 同一段断言文本永远得到同一个裁决（哈希决定），所以跑两遍结果一致。
 */
export function makeFixtureAnswers(state, questions, acceptRate = 0.5) {
  const st = typeof state === 'string' ? state : JSON.stringify(state)
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const grab = (tag) => {
    const m = st.match(new RegExp(`【${esc(tag)}】([\\s\\S]*?)(?=【|$)`))
    return m ? m[1].trim() : ''
  }
  const idOf = (qid) => qid.replace(/^(support|on_topic|specificity)_/, '')
  const claimTextFor = (qid) => grab(`断言 ${idOf(qid)}`) || grab('断言')
  const accept = (s) => (parseInt(sha1(s).slice(0, 8), 16) % 1000) < Math.round(acceptRate * 1000)

  const answers = {}
  for (const [id, q] of Object.entries(questions)) {
    // 逐条证据诊断（`ev_<claimId>_<i>`）必须与聚合裁决**自洽**，否则演示是失真的：
    // 聚合说"不支持"而逐条说"每条都支持"，researcher 拿到的诊断就是废的。
    // 这里让被拒断言的**第一条来源**不支持、其余支持 —— 正是"指出该换哪条来源"
    // 那个最有用的真实形态。
    if (id.startsWith('ev_')) {
      const m = /^ev_(.+)_(\d+)$/.exec(id)
      const cid = m ? m[1] : null
      const idx = m ? Number(m[2]) : 0
      const rejected = cid ? !accept(grab(`断言 ${cid}`) || grab('断言')) : false
      answers[id] = { type: 'boolean', probability: rejected && idx === 0 ? 0.12 : 0.88 }
    } else if (id.startsWith('support_')) {
      const ok = accept(claimTextFor(id))
      answers[id] = ok
        ? { type: 'choice', choice: 'SUPPORTED', probabilities: { SUPPORTED: 0.9, PARTIALLY_SUPPORTED: 0.05, AMBIGUOUS: 0.02, NOT_IN_SOURCE: 0.02, CONTRADICTED: 0.01 }, confidence: 0.8 }
        : { type: 'choice', choice: 'NOT_IN_SOURCE', probabilities: { SUPPORTED: 0.05, PARTIALLY_SUPPORTED: 0.1, AMBIGUOUS: 0.1, NOT_IN_SOURCE: 0.74, CONTRADICTED: 0.01 }, confidence: 0.7 }
    } else if (id === 'relevance') {
      // fixture 模式不验跳转：判高相关即可，配合 next=NONE 让每链只收集种子页，跑得快
      answers[id] = { type: 'boolean', probability: 0.9 }
    } else if (id === 'next') {
      const probs = {}
      for (const k of Object.keys(q.criteria ?? {})) probs[k] = 0
      probs.NONE = 1
      answers[id] = { type: 'choice', choice: 'NONE', probabilities: probs, confidence: 0.9 }
    } else if (id.startsWith('specificity_')) {
      const probabilities = {}
      for (let i = 0; i < SPECIFICITY_LABELS.length; i++) probabilities[String(i)] = i === 2 ? 0.8 : 0.0667
      answers[id] = { type: 'score', score: 2, scoreLabel: SPECIFICITY_LABELS[2], probabilities }
    } else if (id.startsWith('focus_')) {
      const probabilities = {}
      for (let i = 0; i < FOCUS_LABELS.length; i++) probabilities[String(i)] = i === 2 ? 0.8 : 0.05
      answers[id] = { type: 'score', score: 2, scoreLabel: FOCUS_LABELS[2], probabilities }
    } else if (id.startsWith('answerable_')) {
      answers[id] = { type: 'choice', choice: 'answerable', probabilities: { answerable: 0.9, unanswerable: 0.1 } }
    } else {
      answers[id] = { type: 'boolean', probability: 0.9 }
    }
  }
  return answers
}

function sha1(s) {
  return createHash('sha1').update(String(s)).digest('hex')
}

/**
 * 建 JEV 客户端。
 *
 * **每一次调用都完整落盘** —— 包括喂进去的 `state` 正文与 `questions` 全文。
 * 这不是可选的日志装饰，是能不能审计裁决的前提：
 * 只说"某条断言被判否"没有用，必须能看到**判官当时看到的是什么**，
 * 否则永远分不清是判官判错了，还是拼装进去的证据本身就是垃圾。
 *
 * @param {object} cfg
 * @param {'stub'|'fixture'|'http'} [cfg.mode]
 * @param {string} [cfg.apiKey]
 * @param {string} [cfg.logPath] 每次调用写到这里（默认全局 jev-log.jsonl）；传 run 目录可做到 per-run 隔离
 * @param {string} [cfg.runId] 写进每条记录，便于跨文件把调用与 run 关联
 * @param {boolean} [cfg.logFullState] 默认 true；设 false 只记长度（state 极大时可关）
 * @param {number} [cfg.acceptRate] fixture 模式的通过率
 */
export function createJev(cfg = {}) {
  const mode = cfg.mode ?? 'stub'
  const acceptRate = cfg.acceptRate ?? 0.5
  const baseUrl = (cfg.baseUrl ?? process.env.AI_GATEWAY_BASE_URL ?? 'https://ai-gateway.vercel.sh/v4/ai').replace(/\/$/, '')
  const model = cfg.model ?? 'typesafe-ai/jev'
  const apiKey = cfg.apiKey ?? process.env.AI_GATEWAY_API_KEY ?? ''
  const timeoutMs = cfg.timeoutMs ?? 120_000
  const logPath = cfg.logPath ?? LOG_PATH
  const runId = cfg.runId ?? null
  const logFullState = cfg.logFullState !== false

  let calls = 0
  let failures = 0
  let stubCalls = 0
  let seq = 0

  /** 统一的记录骨架：trace 里要能一眼看出"这次问的是哪一步、看到什么、答什么" */
  const makeRecord = (state, questions, meta, extra = {}) => ({
    at: new Date().toISOString(),
    seq: ++seq,
    runId,
    mode,
    // phase 标明这一步属于链路的哪个环节，便于按阶段筛日志：
    // decompose / jump / claim-verify / evidence-diagnosis / ...
    phase: meta.phase ?? null,
    label: meta.label ?? null,
    atom: meta.atom ?? null,
    round: meta.round ?? null,
    qids: Object.keys(questions),
    stateChars: String(state).length,
    questions,
    ...(logFullState ? { state: String(state) } : {}),
    ...extra,
  })

  /**
   * @param {string} state 判官看到的全部内容（JEV 没有 context，这就是它的全部视野）
   * @param {object} questions 问题组
   * @param {{phase?:string,label?:string,atom?:string,round?:number,timeoutMs?:number}} [meta] 审计标签；timeoutMs 可**按调用**覆盖超时
   */
  async function ask(state, questions, meta = {}) {
    const ids = Object.keys(questions)
    if (!ids.length) return { ok: true, answers: {}, warnings: ['no questions'] }

    if (mode === 'stub') {
      stubCalls++
      const answers = makeStubAnswers(state, questions)
      logRecord(makeRecord(state, questions, meta, { answers }), logPath)
      return { ok: true, answers, warnings: ['stub judge — 裁决是启发式假数据'] }
    }

    if (mode === 'fixture') {
      stubCalls++
      const answers = makeFixtureAnswers(state, questions, acceptRate)
      logRecord(makeRecord(state, questions, meta, { acceptRate, answers }), logPath)
      return { ok: true, answers, warnings: [`fixture judge — 裁决由哈希决定（acceptRate=${acceptRate}），只验路由不验质量`] }
    }

    if (!apiKey) return { ok: false, error: 'no AI_GATEWAY_API_KEY (set env or cfg.apiKey)' }
    calls++
    // 按调用覆盖超时：路由决策（跳转）应当很快，用不着等两分钟 ——
    // 实测真 JEV 会偶发挂起，长超时只会把整条链拖死。
    const callTimeoutMs = Number.isFinite(meta.timeoutMs) && meta.timeoutMs > 0 ? meta.timeoutMs : timeoutMs
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), callTimeoutMs)
    const startedAt = Date.now()
    try {
      const res = await fetch(`${baseUrl}/evaluation-model`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'ai-gateway-protocol-version': '0.0.1',
          'ai-gateway-auth-method': 'api-key',
          'ai-evaluation-model-specification-version': '4',
          'ai-model-id': model,
          'X-Title': 'DeepSeek Harness',
        },
        body: JSON.stringify({ state, questions }),
        signal: ctrl.signal,
      })
      const text = await res.text()
      const ms = Date.now() - startedAt
      if (!res.ok) {
        failures++
        logRecord(makeRecord(state, questions, meta, { httpStatus: res.status, ms, error: text.slice(0, 800) }), logPath)
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` }
      }
      let body
      try { body = JSON.parse(text) } catch {
        failures++
        logRecord(makeRecord(state, questions, meta, { ms, error: `non-JSON: ${text.slice(0, 800)}` }), logPath)
        return { ok: false, error: `non-JSON body: ${text.slice(0, 200)}` }
      }
      if (!body?.answers || typeof body.answers !== 'object') {
        failures++
        logRecord(makeRecord(state, questions, meta, { ms, error: `no answers object: ${text.slice(0, 800)}`, rawBody: text.slice(0, 2000) }), logPath)
        return { ok: false, error: `no answers object: ${text.slice(0, 200)}` }
      }
      // 原始响应整体保留（不只是 answers）：真 JEV 可能附带 usage / 警告，
      // 仲裁裁决质量时这些都可能有用，丢掉就再也拿不回来。
      logRecord(makeRecord(state, questions, meta, { ms, answers: body.answers, rawResponse: body }), logPath)
      return { ok: true, answers: body.answers }
    } catch (e) {
      failures++
      const msg = ctrl.signal.aborted ? `JEV timeout after ${callTimeoutMs}ms` : String(e.message ?? e)
      logRecord(makeRecord(state, questions, meta, { ms: Date.now() - startedAt, error: msg }), logPath)
      return { ok: false, error: msg }
    } finally { clearTimeout(timer) }
  }

  return {
    mode, model,
    ask,
    stats: () => ({ mode, httpCalls: calls, stubCalls, failures }),
    logPath,
  }
}

export { LOG_PATH }
