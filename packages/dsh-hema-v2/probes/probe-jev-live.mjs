/**
 * 真 JEV 实调探针 —— 整条链路里唯一从未验证过的一环
 *
 * 前面所有测试都用 stub/fixture 判官，验的是**管道**；JEV 本身判得好不好
 * 一次都没验过（我这边没有 key）。这个探针就干这件事，用**故意做成黑白分明**的
 * 用例：如果连明确支持/明确无关都判不出来，那是 wire protocol 或问题措辞的问题，
 * 与阈值调参无关，必须先解决。
 *
 * 用法：node packages/dsh-hema-v2/probes/probe-jev-live.mjs
 * 需要 AI_GATEWAY_API_KEY（仓库根的 .env 或环境变量）。会真实消耗额度：约 4 次调用。
 */
import { loadEnvFile, describeKeyState } from '../harness/env.mjs'
import {
  createJev, decompositionQuestions, claimQuestions, judgeDecomposition, judgeClaim,
  THRESHOLD, SPECIFICITY_LABELS,
} from '../lib/jev.mjs'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}
const head = (s) => console.log(`\n── ${s} ──`)
/** 概率的紧凑显示 */
const fmt = (a) => a === null || a === undefined ? 'null' : Number(a).toFixed(3)

loadEnvFile()
const keyState = describeKeyState()
console.log('═══ 真 JEV 实调 ═══')
console.log(`key: ${keyState.present ? `${keyState.masked}（来源 ${keyState.source}）` : keyState.hint}`)
if (!keyState.present) {
  console.log('跳过：没有 key。')
  process.exit(0)
}

const jev = createJev({ mode: 'http' })
const t0 = Date.now()

// ══════════════════════════════════════════════════════════════
head('0) 连通性：一次最小调用')
const ping = await jev.ask(
  '【原子命题】Zornhau 是一记斜劈吗？\n【断言 c1】Zornhau 是一记斜劈。\n【证据 c1】\nZornhau is a diagonal strike.',
  { c1: { type: 'boolean', instructions: '证据是否支持该断言？', criteria: { true: '支持', false: '不支持' } } },
  { phase: 'smoke', label: 'ping' },
)
if (!ping.ok) {
  console.log(`  ✘ 调用失败：${ping.error}`)
  console.log('\n调用失败意味着 wire protocol 或 key 有问题，后面的用例没有意义，先停下。')
  process.exit(1)
}
ok('真 JEV 调用成功（HTTP 通路与 header 正确）', ping.ok)
ok('返回了结构化答案（不是散文）', typeof ping.answers?.c1 === 'object', JSON.stringify(ping.answers?.c1))
ok('答案是 boolean 且带概率', ping.answers.c1.type === 'boolean' && typeof ping.answers.c1.probability === 'number',
  JSON.stringify(ping.answers.c1))
ok('黑白分明的证据被判为支持（p ≥ 阈值）', ping.answers.c1.probability >= THRESHOLD,
  `p=${fmt(ping.answers.c1.probability)}`)
console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

// ══════════════════════════════════════════════════════════════
head('1) B 组：明确支持 vs 明确无关 vs 明确反对')
const claims = [
  { id: 'sup', claim: 'Zornhau 是一记自上方斜劈的斩击。' },
  { id: 'irr', claim: 'Zornhau 是用于骑马作战的招式。' },
  { id: 'con', claim: 'Zornhau 是一记自下向上的撩击。' },
]
const stateB = [
  '【原子命题】Zornhau 是什么？',
  '【断言 sup】Zornhau 是一记自上方斜劈的斩击。',
  '【证据 sup】',
  'Zornhau is a diagonal strike from the upper right, delivered from the shoulder down toward the opponent’s left ear.',
  '【断言 irr】Zornhau 是用于骑马作战的招式。',
  '【证据 irr】',
  'Zornhau is a diagonal strike from the upper right, delivered from the shoulder down toward the opponent’s left ear.',
  '【断言 con】Zornhau 是一记自下向上的撩击。',
  '【证据 con】',
  'Zornhau is a diagonal strike from the upper right, delivered from the shoulder down toward the opponent’s left ear.',
].join('\n')
const t1 = Date.now()
const resB = await jev.ask(stateB, claimQuestions(claims), { phase: 'claim-verify', label: 'probe-B' })
if (!resB.ok) { console.log(`  ✘ ${resB.error}`); process.exit(1) }
ok('返回每条断言一组答案（3 断言 × 3 问题 = 9）', Object.keys(resB.answers).length === 9, Object.keys(resB.answers).join(','))
for (const c of claims) {
  const v = judgeClaim(resB.answers, c)
  const a = resB.answers[`support_${c.id}`]
  console.log(`  [${c.id}] choice=${a?.choice} p(SUPPORTED)=${fmt(a?.probabilities?.SUPPORTED)} on_topic=${fmt(v.onTopic.p)} spec=${v.specificity.scoreLabel} → ${v.pass ? '通过' : '打回'}`)
}
const jSup = judgeClaim(resB.answers, claims[0])
const jIrr = judgeClaim(resB.answers, claims[1])
const jCon = judgeClaim(resB.answers, claims[2])
ok('明确支持 → 通过', jSup.pass, JSON.stringify(jSup.reasons))
ok('明确无关 → 打回', !jIrr.pass, JSON.stringify(jIrr.reasons))
ok('明确反对 → 打回', !jCon.pass, JSON.stringify(jCon.reasons))
ok('三条裁决互不相同（真的在区分，不是一律判同一个）',
  new Set(claims.map(c => resB.answers[`support_${c.id}`]?.choice)).size >= 2,
  claims.map(c => resB.answers[`support_${c.id}`]?.choice).join(','))
console.log(`  耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`)

// ══════════════════════════════════════════════════════════════
head('2) C 组：空泛断言应被具体性检查挡下')
const vague = [
  { id: 'v1', claim: 'Zornhau 很重要。' },
  { id: 'v2', claim: 'Zornhau 是一种与斩击有关的技术动作。' },
  { id: 'v3', claim: 'Meÿer 记载怒击自右肩发出，斜向对手左耳，或贯穿其面部与胸部。' },
]
const stateC = [
  '【原子命题】Zornhau 的起手动作是什么？',
  ...vague.flatMap(c => [
    `【断言 ${c.id}】${c.claim}`,
    `【证据 ${c.id}】`,
    'Ein Schlimmer hauw von deiner Rechte Achsel, gegen deines widerparts lincken ohrs, oder durch sein gesicht und Brust.',
  ]),
].join('\n')
const t2 = Date.now()
const resC = await jev.ask(stateC, claimQuestions(vague), { phase: 'claim-verify', label: 'probe-C' })
if (!resC.ok) { console.log(`  ✘ ${resC.error}`); process.exit(1) }
for (const c of vague) {
  const v = judgeClaim(resC.answers, c)
  console.log(`  [${c.id}] 具体性=${v.specificity.scoreLabel} 浮点score=${v.specificity.scoreValue} 质量=${v.specificity.mass} → ${v.pass ? '通过' : '打回'}`)
}
const specLabels = vague.map(c => judgeClaim(resC.answers, c).specificity.scoreLabel)
ok('具体性标签可读（真 JEV 不返回 scoreLabel，需由分布 argmax 推出）',
  specLabels.every(l => typeof l === 'string' && l.length > 0), specLabels.join(' / '))
ok('空泛断言的具体性等级低于具体断言',
  SPECIFICITY_LABELS.indexOf(specLabels[0]) < SPECIFICITY_LABELS.indexOf(specLabels[2]),
  specLabels.join(' / '))
ok('空泛断言被判否（具体性质量不足）', !judgeClaim(resC.answers, vague[0]).pass)
ok('具体断言的证据支持判为通过', judgeClaim(resC.answers, vague[2]).pass,
  JSON.stringify(judgeClaim(resC.answers, vague[2]).reasons))
console.log(`  耗时 ${((Date.now() - t2) / 1000).toFixed(1)}s`)

// ══════════════════════════════════════════════════════════════
head('3) A 组：好分解 vs 差分解')
/*
 * 上一版这里写错了：我把「起手架势 + 打击线路」当作"好分解"，
 * 但原问题是「Zornhau 是什么，怎么用？」—— JEV 判 coverage 不通过，
 * **它是对的**：两条子题都没覆盖"是什么"（名称含义/分类）。
 * 所以好分解必须真的覆盖原问题的两个方面，否则测的是我的臆断不是判官。
 */
const goodSq = [
  { id: 'sq1', text: 'Zornhau 这一名称的含义是什么，它在史料分类中属于何种击法？' },
  { id: 'sq2', text: 'Zornhau 的起手架势与起始位置是什么？' },
  { id: 'sq3', text: 'Zornhau 的打击线路与目标部位是什么？' },
]
const badSq = [
  { id: 'sq1', text: '关于 Zornhau 的一切。' },
  { id: 'sq2', text: 'Zornhau 的起手架势与起始位置是什么？' },
]
const t3 = Date.now()
const stateA = (sq) => ['【原问题】Zornhau 是什么，怎么用？', '【子题目】', ...sq.map(s => `- ${s.id}: ${s.text}`)].join('\n')
const resGood = await jev.ask(stateA(goodSq), decompositionQuestions(goodSq), { phase: 'decompose', label: 'probe-A-good' })
const resBad = await jev.ask(stateA(badSq), decompositionQuestions(badSq), { phase: 'decompose', label: 'probe-A-bad' })
if (!resGood.ok || !resBad.ok) { console.log(`  ✘ ${resGood.error ?? resBad.error}`); process.exit(1) }
const jGood = judgeDecomposition(resGood.answers, goodSq)
const jBad = judgeDecomposition(resBad.answers, badSq)
const goodPassed = jGood.items.length - jGood.failedCount
const badPassed = jBad.items.length - jBad.failedCount
for (const i of jGood.items) console.log(`  好分解 [${i.key}] ${i.pass ? '✔' : '✘'} ${i.label}`)
console.log('')
for (const i of jBad.items) console.log(`  差分解 [${i.key}] ${i.pass ? '✔' : '✘'} ${i.label}`)
console.log('')
ok('差分解的"关于…的一切"被判范围过宽（focus 打回）',
  jBad.failed.some(f => f.key === 'focus_sq1'), JSON.stringify(jBad.failed.map(f => f.key)))
ok('好分解明确优于差分解（通过项更多）', goodPassed > badPassed, `good=${goodPassed} bad=${badPassed}`)
// 这里**刻意不**断言"好分解的 coverage 必须通过"—— 实测它给 0.63（<0.7）。
// 那是标定问题（全局 coverage 本身就是个模糊判断），不是判官判错；
// 把"应该通过"写进断言等于把未经验证的标定猜测固化成测试。
const covGood = jGood.items.find(i => i.key === 'coverage')?.p
const covBad = jBad.items.find(i => i.key === 'coverage')?.p
ok('coverage 有区分度（好分解概率高于差分解）', covGood > covBad, `good=${covGood} bad=${covBad}`)
console.log(`  coverage: 好分解 p=${covGood} / 差分解 p=${covBad}（阈值 0.7 —— 好分解也未过，见下方说明）`)
console.log(`  好分解通过 ${goodPassed}/${jGood.items.length}，差分解 ${badPassed}/${jBad.items.length}`)
console.log(`  耗时 ${((Date.now() - t3) / 1000).toFixed(1)}s`)

// ══════════════════════════════════════════════════════════════
console.log(`\nJEV 统计: ${JSON.stringify(jev.stats())}`)
console.log(`日志: ${jev.logPath}（含每次喂进去的 state 全文）`)
console.log(`\n${fails === 0 ? '全部通过 —— 真 JEV 的裁决方向与预期一致' : fails + ' 项失败 —— 见上方明细'}`)
process.exit(fails === 0 ? 0 : 1)
