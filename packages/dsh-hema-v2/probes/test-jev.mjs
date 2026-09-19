/**
 * 探针 0.2 —— JEV 模块自检（不需要网络，走 stub 判官）
 *
 * 验证的是**管道**：问题契约形状、state 拼装、阈值判定、三组问题的判定折叠。
 * **不验证裁决质量**——stub 是启发式假数据，真 JEV 的裁决质量只有用户能验。
 */
import {
  createJev, decompositionQuestions, claimQuestions,
  judgeDecomposition, judgeClaim, passChoice, passChoiceMass, passBoolean, passScore,
  readPerEvidence, SPECIFICITY_LABELS, FOCUS_LABELS, THRESHOLD,
  ON_TOPIC_OPTIONS, ON_TOPIC_ACCEPT,
} from '../lib/jev.mjs'

/** 对一组断言逐个跑 judgeClaim；自动解包 ask() 的返回对象 */
const judgeAll = (res, claims) => claims.map(c => judgeClaim(res?.answers ?? res, c))

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}

// ── 1. A 组：分解检查 ────────────────────────────────────────
const subQuestions = [
  { id: 'sq1', text: 'Zornhau 的起手动作与力学原理是什么？' },
  { id: 'sq2', text: 'Zornhau 在 Liechtenauer 体系中的战术地位是什么？' },
]
const aQ = decompositionQuestions(subQuestions)
ok('A组问题数 = 2 + 1*子题数（coverage/independent + 每子题一个 focus）',
  Object.keys(aQ).length === 2 + subQuestions.length, `got ${Object.keys(aQ).length}`)
ok('A组 coverage 是 boolean', aQ.coverage.type === 'boolean')
ok('A组 focus 是 score 且等级有序', aQ.focus_sq1.type === 'score' && aQ.focus_sq1.criteria.length === FOCUS_LABELS.length)
// answerable_* 已按实测删除：真实 run 里四个子题全 p=0.95~1.00，而实际证据可得性中位数
// 只有 0.19 —— 它对"能不能取到证"没有预测力，却占着硬闸门的位置。
ok('A组 已不再包含 answerable_*（无预测力，已删除）',
  !Object.keys(aQ).some(k => k.startsWith('answerable_')), Object.keys(aQ).join(','))

const aState = [
  '【原问题】Zornhau 是什么，怎么用？',
  '【子题目】',
  ...subQuestions.map(s => `- ${s.id}: ${s.text}`),
].join('\n')
const jev = createJev({ mode: 'stub' })
const aRes = await jev.ask(aState, aQ)
ok('stub 返回 ok', aRes.ok === true)
ok('stub 覆盖全部 qid', Object.keys(aQ).every(k => k in aRes.answers), `missing=${Object.keys(aQ).filter(k => !(k in aRes.answers))}`)
const aJudge = judgeDecomposition(aRes.answers, subQuestions)
ok('A组全部通过（stub 恒正）', aJudge.pass === true, `failed=${aJudge.failed.map(f => f.key)}`)
ok('A组判定项数 = 2 + 1*子题数', aJudge.items.length === 2 + subQuestions.length, `${aJudge.items.length}`)

// ── 2. B+C 组：断言验证 ──────────────────────────────────────
const claims = [
  { id: 'c1', claim: 'Zornhau 是一记从上方斜劈的斩击。', subQuestion: 'Zornhau 的起手动作是什么？' },
]
const cQ = claimQuestions(claims)
ok('C组问题数 = 3*断言数', Object.keys(cQ).length === 3 * claims.length, `got ${Object.keys(cQ).length}`)
ok('B组 support 是 choice 且有 5 档', cQ.support_c1.type === 'choice' && Object.keys(cQ.support_c1.criteria).length === 5)
ok('C组 on_topic 是三选项 choice（不是 boolean）', cQ.on_topic_c1.type === 'choice')
ok('C组 on_topic 的选项就是影子测试量过的那三个（换措辞那些数字就不适用了）',
  JSON.stringify(Object.keys(cQ.on_topic_c1.criteria)) === JSON.stringify(Object.keys(ON_TOPIC_OPTIONS)),
  Object.keys(cQ.on_topic_c1.criteria).join(','))
ok('C组 on_topic 的可接受侧是 answers+evidence（只有 unrelated 不通过）',
  JSON.stringify(ON_TOPIC_ACCEPT) === JSON.stringify(['answers', 'evidence']), ON_TOPIC_ACCEPT.join(','))
ok('C组 specificity 是 score', cQ.specificity_c1.type === 'score')

const strongState = [
  '【原子命题】Zornhau 的起手动作是什么？',
  '【断言】Zornhau 是一记从上方斜劈的斩击。',
  '【证据文本】Zornhau 是一记从上方斜劈的斩击 der Zornhau ist ein Oberhau von der rechten Seite.',
].join('\n')
const cRes = await jev.ask(strongState, cQ)
const cJudge = judgeClaim(cRes.answers, claims[0])
ok('B组：证据命中断言 → 通过', cJudge.pass === true, `reasons=${JSON.stringify(cJudge.reasons)}`)
ok('B组 judgedBy=probability（非 argmax 兜底）', cJudge.support.judgedBy === 'probability')

const weakState = [
  '【原子命题】Zornhau 的起手动作是什么？',
  '【断言】Zornhau 是一记从上方斜劈的斩击。',
  '【证据文本】本篇讨论 Ringeck 大师的剑术体系概览，与前述内容关系不大。',
].join('\n')
const wJudge = judgeClaim((await jev.ask(weakState, cQ)).answers, claims[0])
ok('B组：证据不含断言 → 不通过', wJudge.pass === false)
ok('B组：不通过时给出可读原因', wJudge.reasons.length > 0, wJudge.reasons[0])

// C 组必须能独立否决：证据支持、但断言退化成没有内容词
const degenClaim = { id: 'd1', claim: '是。', subQuestion: 'Zornhau 的起手动作是什么？' }
const dQ = claimQuestions([degenClaim])
const dState = [
  '【原子命题】Zornhau 的起手动作是什么？',
  '【断言】是。',
  '【证据文本】是。',
].join('\n')
const dJudge = judgeClaim((await jev.ask(dState, dQ)).answers, degenClaim)
ok('C组：退化断言被独立否决（即使 B 组放过）', dJudge.pass === false && dJudge.onTopic.pass === false,
  `support.pass=${dJudge.support.pass} onTopic.chosen=${dJudge.onTopic.chosen} mass=${dJudge.onTopic.mass}`)

// ── 4. 阈值判定单元 ─────────────────────────────────────────
ok('boolean p=0.8 通过', passBoolean({ probability: 0.8 }).pass === true)
ok('boolean p=0.69 不通过', passBoolean({ probability: 0.69 }).pass === false)
ok('boolean p=0.7 恰好通过（含端点）', passBoolean({ probability: THRESHOLD }).pass === true)
ok('choice p(SUPPORTED)=0.8 通过', passChoice({ choice: 'SUPPORTED', probabilities: { SUPPORTED: 0.8 } }, 'SUPPORTED').pass === true)
ok('choice 犹豫裁决 p=0.55 被打回（不是 argmax 蒙混）',
  passChoice({ choice: 'SUPPORTED', probabilities: { SUPPORTED: 0.55, PARTIALLY_SUPPORTED: 0.4 } }, 'SUPPORTED').pass === false)
ok('choice 无 probabilities 时退回 argmax', passChoice({ choice: 'SUPPORTED' }, 'SUPPORTED').pass === true)

// ── 4a. on_topic 的三选项闸门（"非 unrelated"）──────────────
// 旧的 boolean 问法在这批断言上中位数 0.78、31% 判定翻转 → 阈值 0.7 没有参考性。
// 现在闸门是 answers+evidence 的概率质量和，只有 unrelated 才不通过。
const ot = (probs, choice) => passChoiceMass({ choice, probabilities: probs }, ON_TOPIC_ACCEPT)
ok('on_topic：answers+evidence 质量和 0.9 → 通过',
  ot({ answers: 0.2, evidence: 0.7, unrelated: 0.1 }, 'evidence').pass === true)
ok('on_topic：主判 unrelated(0.8) → 不通过（argmax 蒙混不了）',
  ot({ answers: 0.1, evidence: 0.1, unrelated: 0.8 }, 'unrelated').pass === false)
ok('on_topic：质量和恰好 0.7 → 通过（含端点）',
  ot({ answers: 0.35, evidence: 0.35, unrelated: 0.3 }, 'answers').pass === true)
ok('on_topic：质量和 0.69 → 不通过',
  ot({ answers: 0.3, evidence: 0.39, unrelated: 0.31 }, 'evidence').pass === false)
ok('on_topic：p(answers) 只有 0.3 也算通过（这正是旧问法误杀的一类：它其实是"提供证据"）',
  ot({ answers: 0.3, evidence: 0.4, unrelated: 0.3 }, 'answers').pass === true)
ok('on_topic：选 evidence 与选 answers 同样通过（两个可接受侧等价）',
  ot({ answers: 0.5, evidence: 0.4, unrelated: 0.1 }, 'answers').pass
  && ot({ answers: 0.4, evidence: 0.5, unrelated: 0.1 }, 'evidence').pass)
ok('on_topic：无 probabilities 时退回 argmax 归属',
  ot(undefined, 'evidence').pass === true
  && passChoiceMass({ choice: 'unrelated' }, ON_TOPIC_ACCEPT).pass === false
  && passChoiceMass({ choice: 'evidence' }, ON_TOPIC_ACCEPT).judgedBy === 'argmax')
ok('on_topic：judgedBy 标明用的是质量还是 argmax',
  ot({ answers: 0.5, evidence: 0.4, unrelated: 0.1 }, 'evidence').judgedBy === 'probability-mass')
ok('on_topic：判否时原因里带上 p(无关) 与质量（researcher 要能看出是犹豫还是真跑题）', (() => {
  const j = judgeClaim(
    { on_topic_d1: { type: 'choice', choice: 'unrelated', probabilities: { answers: 0.05, evidence: 0.15, unrelated: 0.8 } } },
    { id: 'd1', claim: 'x', subQuestion: 'y' })
  return j.onTopic.pass === false
    && j.reasons.some(r => r.includes('与原子命题无关或已跑题') && r.includes('0.8') && r.includes('0.2'))
})())
// 两种失败不能说成同一回事：真 JEV 实测抓到过 argmax 站在可接受侧、质量只差 0.03 的情形。
// 把它写成"无关"会冤枉一条明明很贴题的断言，并让 researcher 去改一个没问题的表述。
ok('on_topic：argmax 在可接受侧但质量不足 → 说"判定不确定"，不说"无关"', (() => {
  const j = judgeClaim(
    { on_topic_d2: { type: 'choice', choice: 'answers', probabilities: { answers: 0.4, evidence: 0.27, unrelated: 0.33 } } },
    { id: 'd2', claim: 'x', subQuestion: 'y' })
  const r = j.reasons.find(x => x.includes('与命题的关系判定不确定'))
  return j.onTopic.pass === false && typeof r === 'string' && !r.includes('无关') && r.includes('0.67')
})())

const sp = passScore({ probabilities: { 0: 0.02, 1: 0.08, 2: 0.4, 3: 0.5 }, scoreLabel: SPECIFICITY_LABELS[3] },
  ['有信息量', '具体可查证'], SPECIFICITY_LABELS)
ok('score 概率摊在可接受两级 → 按质量和通过', sp.pass === true, `mass=${sp.mass}`)
const sp2 = passScore({ probabilities: { 0: 0.4, 1: 0.4, 2: 0.15, 3: 0.05 }, scoreLabel: SPECIFICITY_LABELS[1] },
  ['有信息量', '具体可查证'], SPECIFICITY_LABELS)
ok('score 概率主在空泛档 → 不通过', sp2.pass === false, `mass=${sp2.mass}`)

// ── 4b. fixture 判官：可控且可复现的裁决，用来验路由 ────────
console.log('\n── fixture 判官（只验路由，不验质量）──')
const fState = [
  '【原子命题】Zornhau 的起手动作是什么？',
  '【断言 c1】Zornhau 是一记从上方斜劈的斩击。',
  '【断言 c2】Zornhau 在 Liechtenauer 体系中属于五大斩击之一。',
  '【断言 c3】Zornhau 可以用于对治下段起手的攻击。',
  '【断言 c4】Zornhau 的起手线路同时兼具拨挡功能。',
].join('\n')
const fClaims = [1, 2, 3, 4].map(n => ({ id: `c${n}`, claim: `断言 ${n}`, subQuestion: 'q' }))
const fAll = createJev({ mode: 'fixture', acceptRate: 1 })
const fNone = createJev({ mode: 'fixture', acceptRate: 0 })
const fMid = createJev({ mode: 'fixture', acceptRate: 0.5 })

const allPass = judgeAll(await fAll.ask(fState, claimQuestions(fClaims)), fClaims)
const nonePass = judgeAll(await fNone.ask(fState, claimQuestions(fClaims)), fClaims)
const midPass = judgeAll(await fMid.ask(fState, claimQuestions(fClaims)), fClaims)
const midPass2 = judgeAll(await fMid.ask(fState, claimQuestions(fClaims)), fClaims)

ok('acceptRate=1 → 全部通过', allPass.every(v => v.pass), JSON.stringify(allPass.map(v => v.pass)))
ok('acceptRate=0 → 全部不通过', nonePass.every(v => !v.pass))
ok('acceptRate=0.5 → 混合结果（既有通过也有不通过）',
  midPass.some(v => v.pass) && midPass.some(v => !v.pass), JSON.stringify(midPass.map(v => v.pass)))
ok('fixture 可复现：同一 state 两次裁决完全一致',
  JSON.stringify(midPass) === JSON.stringify(midPass2))
ok('fixture 的 next 恒为 NONE',
  (await fMid.ask(fState, { next: { type: 'choice', criteria: { p0: 'A', p1: 'B', NONE: '都不' } } })).answers.next.choice === 'NONE')
ok('fixture 的 relevance 判高相关', passBoolean((await fMid.ask(fState, { relevance: { type: 'boolean' } })).answers.relevance).p === 0.9)

console.log('\n── 4c) fixture 的逐条证据诊断必须与聚合裁决自洽 ──')
// 聚合说"不支持"、逐条却说"每条都支持" → researcher 拿到的诊断是废的
const evQs = {
  ev_c1_0: { type: 'boolean', criteria: { true: 'x', false: 'y' } },
  ev_c1_1: { type: 'boolean', criteria: { true: 'x', false: 'y' } },
  ev_c1_2: { type: 'boolean', criteria: { true: 'x', false: 'y' } },
}
const fAll2 = createJev({ mode: 'fixture', acceptRate: 1 })
const fNone2 = createJev({ mode: 'fixture', acceptRate: 0 })
const evAll = (await fAll2.ask(fState, evQs)).answers
const evNone = (await fNone2.ask(fState, evQs)).answers
ok('acceptRate=1（断言通过）→ 逐条诊断全为支持',
  Object.values(evAll).every(a => a.probability >= 0.7), JSON.stringify(Object.values(evAll).map(a => a.probability)))
ok('acceptRate=0（断言被拒）→ 第一条来源判不支持（给出可操作的"该换哪条"）',
  evNone.ev_c1_0.probability < 0.7 && evNone.ev_c1_1.probability >= 0.7,
  JSON.stringify(Object.values(evNone).map(a => a.probability)))
const readEv = readPerEvidence(evNone, 'c1', [{ label: 'L1' }, { label: 'L2' }, { label: 'L3' }])
ok('折叠后指明第 1 条不支持、其余支持',
  readEv[0].supports === false && readEv[1].supports === true && readEv[2].supports === true,
  JSON.stringify(readEv.map(d => d.supports)))

// ── 5. 审计与不抛异常 ───────────────────────────────────────
const beforeEmpty = jev.stats().stubCalls
const empty = await jev.ask('x', {})
ok('JEV 从不抛异常：空问题组', empty.ok === true && Object.keys(empty.answers).length === 0)
ok('空问题组不消耗调用', jev.stats().stubCalls === beforeEmpty)
const st = jev.stats()
ok('stub 调用被计数（A/B/弱证据/退化 = 4 次）', st.stubCalls === 4, JSON.stringify(st))

console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}  (${st.stubCalls} stub 调用)`)
process.exit(fails === 0 ? 0 : 1)
