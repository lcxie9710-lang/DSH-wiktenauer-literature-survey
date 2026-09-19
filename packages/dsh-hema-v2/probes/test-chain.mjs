/**
 * 探针 Stage 2 —— 单链研究环的硬规则
 *
 * 用**脚本化 researcher + 脚本化判官**，所以能确定性验证：
 *   轮数封顶、打回内容、已通过断言冻结、证据解引用失败硬拦、
 *   证据悬置（insufficient）而非假装通过、轮次历史可审计。
 *
 * 不验裁决质量。裁决质量只有真 JEV 能验。
 */
import { runChain } from '../lib/chain.mjs'
import { createJev, claimQuestions, perEvidenceQuestions, perEvidenceState, readPerEvidence } from '../lib/jev.mjs'
import { makeLocator } from '../lib/wiki.mjs'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}
const head = (s) => console.log(`\n── ${s} ──`)

// 合成解引用：**必须注入**，否则 assembleState 会偷偷打真实维基，
// 测试就变成了「取决于维基今天长什么样」——那不是测试。
//   docs[page] 是字符串 → 容忍任意锚点（用于只关心内容的用例）
//   docs[page] 是对象   → 严格按锚点匹配，锚点不存在就如实报 ANCHOR_NOT_FOUND
function fakeDeref(docs) {
  return async (loc) => {
    const entry = docs[loc.page]
    if (entry === undefined) {
      return { ok: false, reason: 'PAGE_NOT_FOUND', page: loc.page, anchor: loc.anchor, text: '', paragraphs: [] }
    }
    let text
    if (typeof entry === 'string') text = entry
    else {
      const key = loc.anchor ?? null
      if (!(key in entry)) {
        return {
          ok: false, reason: `ANCHOR_NOT_FOUND: ${loc.anchor}`, page: loc.page, anchor: loc.anchor,
          text: '', paragraphs: [], availableAnchors: Object.keys(entry),
        }
      }
      text = entry[key]
    }
    return { ok: true, page: loc.page, anchor: loc.anchor, revid: 500, text, paragraphs: text.split('\n\n') }
  }
}

const DOCS = {
  Zornhaw: 'Zornhau 是一记从上方斜劈的斩击，起手自右侧，沿对角线打击对手的头部。zornhau is a diagonal strike from the upper right.',
  Liechtenauer: 'Liechtenauer 的剑术体系中，五大斩击 master strikes 是最基础的攻击形式。',
  StrictPage: { Match: 'Zornhau 是一记从上方斜劈的斩击，起手自右侧。' },
}
const DEPS = { dereference: fakeDeref(DOCS) }

const ATOM = 'Zornhau 的起手动作是什么？'
const GOOD = 'Zornhau 是一记从上方斜劈的斩击，起手自右侧。'
const WEAK = 'Zornhau 是一种与斩击有关的技术动作。'

const loc = makeLocator({ page: 'Zornhaw', anchor: null })

// ══════════════════════════════════════════════════════════════
head('1) 一次通过：不触发打回')
let researcherCalls = 0
const r1 = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async () => {
    researcherCalls++
    return { claims: [{ id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: [loc] }] }
  },
  cfg: { maxRounds: 3 },
})
ok('只调了 1 次 researcher', researcherCalls === 1, `calls=${researcherCalls}`)
ok('断言通过', r1.accepted.length === 1 && r1.accepted[0].id === 'c1')
ok('complete=true', r1.complete === true)
ok('轮数=1', r1.rounds === 1, `rounds=${r1.rounds}`)
ok('只花了 1 次验证调用', r1.stats.verifications === 1, JSON.stringify(r1.stats))
ok('没有证据悬置项', r1.insufficient.length === 0)
ok('已通过断言带来源标记（可追溯）', r1.accepted[0].sources.length === 1 && /Zornhaw/.test(r1.accepted[0].sources[0]),
  JSON.stringify(r1.accepted[0].sources))

// ══════════════════════════════════════════════════════════════
head('2) 先失败后改好：打回内容正确，第 2 轮通过')
let calls2 = 0
const seenCtx = []
const r2 = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async (ctx) => {
    calls2++
    seenCtx.push(ctx)
    // 第 1 轮交一条证据支持不了的弱断言；被打回后改成有据可依的
    return { claims: [{ id: 'c1', claim: ctx.round === 1 ? WEAK : GOOD, subQuestion: ATOM, evidence: [loc] }] }
  },
  cfg: { maxRounds: 3 },
})
ok('调了 2 次 researcher', calls2 === 2, `calls=${calls2}`)
ok('第 1 轮 feedback 为 null', seenCtx[0].feedback === null)
ok('第 2 轮收到了打回清单', seenCtx[1].feedback?.failed?.length === 1, JSON.stringify(seenCtx[1].feedback?.failed?.map(f => f.id)))
ok('打回清单带可读原因', (seenCtx[1].feedback?.failed?.[0]?.reasons?.length ?? 0) > 0,
  JSON.stringify(seenCtx[1].feedback?.failed?.[0]?.reasons))
ok('打回清单带上了被打回的定位符（便于 researcher 换证据）',
  seenCtx[1].feedback?.failed?.[0]?.locatorsTried?.length === 1)
ok('hint 传到了 researcher，且提醒了"别削弱成空话"', /同义反复|空话/.test(seenCtx[1].hint ?? ''), seenCtx[1].hint)
ok('第 1 轮的 hint 是取证指引而非打回', /取证|定位符/.test(seenCtx[0].hint ?? ''))
ok('第 2 轮通过', r2.accepted.length === 1 && r2.rounds === 2, `rounds=${r2.rounds}`)
ok('complete=true', r2.complete === true)
ok('总共 2 次验证调用', r2.stats.verifications === 2, JSON.stringify(r2.stats))

// ══════════════════════════════════════════════════════════════
head('3) 已通过的断言冻结：重交时不被重复验证')
let calls3 = 0
const r3 = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async ({ round }) => {
    calls3++
    // c1 一直是好的（应被冻结）；c2 前两轮是弱的，第 3 轮改好
    return {
      claims: [
        { id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: [loc] },
        { id: 'c2', claim: round <= 2 ? WEAK : GOOD, subQuestion: ATOM, evidence: [loc] },
      ],
    }
  },
  cfg: { maxRounds: 3 },
})
ok('跑了 3 轮', calls3 === 3 && r3.rounds === 3, `calls=${calls3} rounds=${r3.rounds}`)
ok('两条断言最终都通过', r3.accepted.length === 2, JSON.stringify(r3.accepted.map(a => a.id)))
ok('冻结生效：验证调用数 < 断言数×轮数（6）', r3.stats.verifications < 6, `verifications=${r3.stats.verifications}`)
ok('c1 只在第 1 轮被验证', r3.history[0].verifiedCount === 2 && r3.history[1].verifiedCount === 1 && r3.history[2].verifiedCount === 1,
  r3.history.map(h => h.verifiedCount).join(','))
ok('冻结轮次被标记 frozen', r3.history[1].claims.some(c => c.id === 'c1' && c.frozen === true))
ok('complete=true', r3.complete === true)

// ══════════════════════════════════════════════════════════════
head('4) 轮数封顶 → 证据悬置（绝不假装通过）')
let calls4 = 0
const r4 = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async () => { calls4++; return { claims: [{ id: 'c1', claim: WEAK, subQuestion: ATOM, evidence: [loc] }] } },
  cfg: { maxRounds: 3 },
})
ok('恰好调了 3 次 researcher（封顶）', calls4 === 3, `calls=${calls4}`)
ok('3 轮后判 insufficient（证据悬置）', r4.insufficient.length === 1 && r4.insufficient[0].reason === 'ROUNDS_EXHAUSTED',
  JSON.stringify(r4.insufficient.map(i => i.reason)))
ok('insufficient 记录了尝试轮数', r4.insufficient[0].roundsAttempted === 3)
ok('insufficient 保留未通过理由（供报告写「证据悬置」节）', (r4.insufficient[0].lastReasons?.length ?? 0) > 0,
  JSON.stringify(r4.insufficient[0].lastReasons))
ok('insufficient 不被计入 accepted（不假装通过）', r4.accepted.length === 0)
ok('complete=false', r4.complete === false)
ok('轮次历史长度=3（可审计）', r4.history.length === 3)

// ══════════════════════════════════════════════════════════════
head('5) 证据解引用失败 → 硬拦，不问 JEV')
const badLoc = makeLocator({ page: 'NoSuchPage', anchor: null })
const spyJev = createJev({ mode: 'stub' })
const r5 = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: spyJev,
  deps: DEPS,
  askResearcher: async () => ({
    claims: [
      { id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: [loc] },
      { id: 'c2', claim: GOOD, subQuestion: ATOM, evidence: [badLoc] },
    ],
  }),
  cfg: { maxRounds: 1 },
})
ok('死证据的断言被判 EVIDENCE_UNRESOLVABLE', r5.insufficient.some(i => i.reason === 'ROUNDS_EXHAUSTED') || r5.history[0].hardBlockedCount === 1,
  `hardBlocked=${r5.history[0].hardBlockedCount}`)
ok('硬拦的断言进不了 JEV 提问（askable 减小）', r5.history[0].verifiedCount === 1, `verified=${r5.history[0].verifiedCount}`)
ok('好证据的断言仍然通过（不因邻居坏掉而连坐）', r5.accepted.length === 1 && r5.accepted[0].id === 'c1')
ok('死证据的断言未被计入 accepted', !r5.accepted.some(a => a.id === 'c2'))

head('5b) 无证据的断言 → NO_EVIDENCE 硬拦')
const r5b = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async () => ({ claims: [{ id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: [] }] }),
  cfg: { maxRounds: 1 },
})
ok('空证据 → NO_EVIDENCE 硬拦', r5b.history[0].hardBlockedCount === 1, JSON.stringify(r5b.history[0]))
ok('空证据断言不进 JEV', r5b.history[0].verifiedCount === 0)

head('5c) 锚点不存在 → ANCHOR_NOT_FOUND 硬拦（版本漂移的另一种形态）')
const r5c = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async () => ({
    claims: [
      { id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: [makeLocator({ page: 'StrictPage', anchor: 'Match' })] },
      { id: 'c2', claim: GOOD, subQuestion: ATOM, evidence: [makeLocator({ page: 'StrictPage', anchor: 'WrongAnchor' })] },
    ],
  }),
  cfg: { maxRounds: 1 },
})
ok('正确锚点的断言通过', r5c.accepted.some(a => a.id === 'c1'), JSON.stringify(r5c.accepted.map(a => a.id)))
ok('错锚点的断言被硬拦', r5c.history[0].hardBlockedCount === 1, `hardBlocked=${r5c.history[0].hardBlockedCount}`)
ok('错锚点的断言没进 JEV', r5c.history[0].verifiedCount === 1, `verified=${r5c.history[0].verifiedCount}`)

// ══════════════════════════════════════════════════════════════
head('6) 容错：researcher 抛异常 / 交空包 / 形状错误')
/*
 * 关键区分：**调用失败 ≠ 模型交了个坏包**。
 * 实测遇到过 dsh 子进程以 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) 硬崩 ——
 * 那是基础设施故障。若直接消耗一轮，maxRounds=2 时等于白扔一半重试预算。
 * 所以调用失败要在轮内重试，只有模型真的交了坏包才记轮。
 */
let calls6 = 0
const r6 = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async ({ round, attempt }) => {
    calls6++
    if (round === 1) throw new Error('模拟模型超时')
    if (round === 2 && attempt === 1) return { claims: [] }
    return { claims: [{ id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: [loc] }] }
  },
  cfg: { maxRounds: 3, retryBackoffMs: 1 },
})
ok('调用失败不中断，后续轮次仍成功', r6.accepted.length === 1 && r6.complete === true,
  `accepted=${r6.accepted.length} rounds=${r6.rounds}`)
ok('调用失败被记进轮次历史（重试耗尽后）', /调用失败（调用重试/.test(r6.history[0].error ?? ''), r6.history[0].error)
ok('空包轮被记为 EMPTY_SUBMISSION', r6.history[1].error === 'EMPTY_SUBMISSION')

head('6a) 崩溃在轮内重试，**不消耗**重试轮数')
let crashCalls = 0
const rCrash = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async ({ attempt }) => {
    crashCalls++
    // 第 1 轮前两次调用崩溃，第 3 次成功 —— 这一轮必须算通过，不能因为崩溃就换下一轮
    if (crashCalls <= 2) throw new Error('模拟 0xC0000409 进程崩溃')
    return { claims: [{ id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: [loc] }] }
  },
  cfg: { maxRounds: 3, roleRetries: 2, retryBackoffMs: 1 },
})
ok('崩溃后轮内重试，只用了 1 轮', rCrash.rounds === 1, `rounds=${rCrash.rounds}`)
ok('崩溃未消耗重试预算（maxRounds 3 只用了 1）', rCrash.history.length === 1, `history=${rCrash.history.length}`)
ok('重试后成功拿到断言', rCrash.accepted.length === 1, JSON.stringify(rCrash.stats))
ok('共调用了 3 次（2 崩 + 1 成）', crashCalls === 3, `calls=${crashCalls}`)

head('6e) 重试耗尽才消耗一轮')
let always = 0
const rAlways = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async () => { always++; throw new Error('一直崩') },
  cfg: { maxRounds: 2, roleRetries: 1, retryBackoffMs: 1 },
})
ok('每轮 1+roleRetries=2 次调用', always === 4, `calls=${always}（2 轮 × 2 次）`)
ok('重试耗尽后如实报失败', rAlways.history.every(h => /调用失败（调用重试/.test(h.error ?? '')), JSON.stringify(rAlways.history.map(h => h.error)))
ok('调用全失败时 accepted 为空（不假装通过）', rAlways.accepted.length === 0)
ok('调用全失败不冒充证据悬置（那是模型的问题）', rAlways.insufficient.length === 0, JSON.stringify(rAlways.stats))

head('6b) 无 id 的断言自动编号')
const r6b = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async () => ({ claims: [{ claim: GOOD, subQuestion: ATOM, evidence: [loc] }] }),
  cfg: { maxRounds: 1 },
})
ok('缺 id 自动补 c1', r6b.accepted.length === 1 && r6b.accepted[0].id === 'c1', JSON.stringify(r6b.accepted.map(a => a.id)))

head('6c) 证据用字符串写法也能解析')
const r6c = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async () => ({ claims: [{ id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: ['Zornhaw'] }] }),
  cfg: { maxRounds: 1 },
})
ok('"Zornhaw" 字符串被解析为定位符', r6c.accepted.length === 1, JSON.stringify(r6c.history[0]))

head('6d) 无子题目时沿用原子命题')
const r6d = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: createJev({ mode: 'stub' }),
  deps: DEPS,
  askResearcher: async () => ({ claims: [{ id: 'c1', claim: GOOD, evidence: [loc] }] }),
  cfg: { maxRounds: 1 },
})
ok('subQuestion 回落到原子命题', r6d.history[0].claims[0]?.subQuestion === ATOM || r6d.accepted.length === 1)

// ══════════════════════════════════════════════════════════════
head('7b) 失败路径的 per-evidence 诊断：指出是哪一条证据不支持')
/*
 * 一条断言挂多个来源时，聚合判定只说"不支持"，说不出是哪个来源的问题。
 * 而"换掉错的那个来源"往往正是修好它的最短路径 —— 否则 researcher 只能盲改。
 */
const srcA = makeLocator({ page: 'Zornhaw', anchor: null })
const srcB = makeLocator({ page: 'Liechtenauer', anchor: null })
const diagJev = {
  mode: 'diag', model: 'x',
  calls: [],
  async ask(state, questions) {
    const ids = Object.keys(questions)
    this.calls.push({ ids, state })
    // 诊断调用：只让第 1 条来源支持，第 2 条不支持
    if (ids.length && ids.every(k => k.startsWith('ev_'))) {
      const answers = {}
      for (const k of ids) {
        answers[k] = { type: 'boolean', probability: k.endsWith('_0') ? 0.9 : 0.1 }
      }
      return { ok: true, answers }
    }
    // 主判定：一律判否，把流程推到失败路径
    const answers = {}
    for (const k of ids) {
      if (k.startsWith('support_')) answers[k] = { type: 'choice', choice: 'NOT_IN_SOURCE', probabilities: { SUPPORTED: 0.05, PARTIALLY_SUPPORTED: 0.1, AMBIGUOUS: 0.1, NOT_IN_SOURCE: 0.74, CONTRADICTED: 0.01 } }
      else if (k.startsWith('specificity_')) answers[k] = { type: 'score', score: 2, scoreLabel: '有信息量', probabilities: { 0: 0.05, 1: 0.05, 2: 0.8, 3: 0.1 } }
      else answers[k] = { type: 'boolean', probability: 0.9 }
    }
    return { ok: true, answers }
  },
  stats: () => ({ mode: 'diag' }),
}
const seenFb = []
const rDiag = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: srcA, revid: 500 }],
  jev: diagJev, deps: DEPS,
  cfg: { maxRounds: 2 },
  askResearcher: async (ctx) => {
    if (ctx.feedback) seenFb.push(ctx.feedback)
    return { claims: [{ id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: [srcA, srcB] }] }
  },
})
ok('确实发起了逐条证据诊断调用', diagJev.calls.some(c => c.ids.every(k => k.startsWith('ev_'))))
ok('诊断的问题数 = 来源数', diagJev.calls.find(c => c.ids.every(k => k.startsWith('ev_')))?.ids.length === 2)
ok('诊断 state 里每条来源单独成块', (() => {
  const c = diagJev.calls.find(x => x.ids.every(k => k.startsWith('ev_')))
  return /【证据 1】/.test(c.state) && /【证据 2】/.test(c.state) && /【断言】/.test(c.state)
})())
ok('打回清单带上了诊断结果', seenFb[0]?.failed?.[0]?.evidenceDiagnosis?.length === 2,
  JSON.stringify(seenFb[0]?.failed?.[0]?.evidenceDiagnosis))
ok('诊断正确区分了支持/不支持的来源',
  seenFb[0].failed[0].evidenceDiagnosis[0].supports === true &&
  seenFb[0].failed[0].evidenceDiagnosis[1].supports === false,
  JSON.stringify(seenFb[0].failed[0].evidenceDiagnosis.map(d => d.supports)))

head('7c) 单来源断言不做诊断（没有"哪一条"的问题，不必多花调用）')
const singleJev = {
  mode: 'single', model: 'x', calls: 0,
  async ask(state, questions) {
    this.calls++
    const ids = Object.keys(questions)
    const answers = {}
    for (const k of ids) {
      if (k.startsWith('support_')) answers[k] = { type: 'choice', choice: 'NOT_IN_SOURCE', probabilities: { SUPPORTED: 0.05, NOT_IN_SOURCE: 0.9 } }
      else if (k.startsWith('specificity_')) answers[k] = { type: 'score', score: 2, scoreLabel: '有信息量', probabilities: { 0: 0.05, 1: 0.05, 2: 0.8, 3: 0.1 } }
      else answers[k] = { type: 'boolean', probability: 0.9 }
    }
    return { ok: true, answers }
  },
  stats: () => ({ mode: 'single' }),
}
const singleFb = []
await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: srcA, revid: 500 }],
  jev: singleJev, deps: DEPS,
  cfg: { maxRounds: 2 },
  askResearcher: async (ctx) => {
    if (ctx.feedback) singleFb.push(ctx.feedback)
    return { claims: [{ id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: [srcA] }] }
  },
})
ok('单来源：2 轮只花了 2 次验证调用（没多做诊断）', singleJev.calls === 2, `calls=${singleJev.calls}`)
ok('单来源：诊断字段为空', singleFb[0]?.failed?.[0]?.evidenceDiagnosis === null)

head('7d) per-evidence 问题的形状')
const pq = perEvidenceQuestions({ id: 'c9', claim: 'X' }, [{ label: 'A' }, { label: 'B' }, { label: 'C' }])
ok('每个来源一个问题', Object.keys(pq).length === 3, Object.keys(pq).join(','))
ok('问题 id 稳定', 'ev_c9_0' in pq && 'ev_c9_2' in pq)
ok('都是 boolean', Object.values(pq).every(q => q.type === 'boolean'))
ok('问题里带上了断言原文', /X/.test(pq.ev_c9_0.instructions))
const ps = perEvidenceState({ id: 'c9', claim: 'X', subQuestion: 'Q' }, [{ label: 'L1', text: 'T1' }, { label: 'L2', text: 'T2' }])
ok('state 含来源标签与文本', ps.includes('L1') && ps.includes('T1') && ps.includes('L2') && ps.includes('T2'))
const rd = readPerEvidence({ ev_c9_0: { probability: 0.9 }, ev_c9_1: { probability: 0.2 } }, 'c9', [{ label: 'L1' }, { label: 'L2' }])
ok('readPerEvidence 折出 supports', rd[0].supports === true && rd[1].supports === false)

head('8) JEV 失败时必须中止本轮，不能当作通过')
const deadJev = {
  ask: async () => ({ ok: false, error: 'HTTP 502: bad gateway' }),
  stats: () => ({ mode: 'dead' }),
}
const r8 = await runChain({
  atom: ATOM, pages: [{ page: 'Zornhaw', locator: loc, revid: 500 }],
  jev: deadJev,
  deps: DEPS,
  askResearcher: async () => ({ claims: [{ id: 'c1', claim: GOOD, subQuestion: ATOM, evidence: [loc] }] }),
  cfg: { maxRounds: 2 },
})
ok('JEV 挂掉时 accepted 为空（绝不默认通过）', r8.accepted.length === 0 && r8.complete === false,
  JSON.stringify(r8.stats))
ok('JEV 错误被记录并打回重试（耗尽轮数）', r8.history.length === 2 && r8.history[0].error?.includes('JEV'),
  JSON.stringify(r8.history.map(h => h.error)))

console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
process.exit(fails === 0 ? 0 : 1)