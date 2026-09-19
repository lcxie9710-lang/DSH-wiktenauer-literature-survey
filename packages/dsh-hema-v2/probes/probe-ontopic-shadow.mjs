/**
 * 影子测试：把 `on_topic` 拆成三个独立二元判断，拿**真实日志**重问一遍。
 *
 * ## 为什么要做影子测试，而不是直接改代码
 *
 * 实测数据说 `on_topic` 的 0.7 阈值没有参考性：中位数 0.78、56% 落在 0.55–0.85、
 * 阈值从 0.6 挪到 0.8 通过率就从 84% 掉到 49%。但"该换个问法"是**推断**，
 * 不是证据 —— 换个问法也可能一样糊。
 *
 * 所以：**state 一字不改**，只换问题，用真 JEV 重问，和日志里的结果逐条对比。
 * 这样"新问法是否更有分辨力"就是可测的，而不是我说了算。
 *
 * 关键对照指标（都是越低越好）：
 *   · 落在 0.55–0.85（"阈值一挪就翻"）的比例 —— 核心指标
 *   · 与旧 on_topic 的判定一致率 —— 太低说明换的不是问法而是判的对象
 *   · 重复性：同一 state 问两遍，同一断言拿到不同判定的比例（JEV 本身是随机的，
 *     不测这个就无法区分"问法改进"和"采样噪声"）
 *
 * 用法：node packages/dsh-hema-v2/probes/probe-ontopic-shadow.mjs <run 目录> [--repeats 2]
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnvFile, describeKeyState } from '../harness/env.mjs'
import { createJev, THRESHOLD } from '../lib/jev.mjs'

const argv = process.argv.slice(2)
const dir = argv[0]
const ri = argv.indexOf('--repeats')
const REPEATS = ri >= 0 ? Number(argv[ri + 1]) : 2

if (!dir || !existsSync(join(dir, 'jev-calls.jsonl'))) {
  console.error('用法：node probe-ontopic-shadow.mjs <run 目录> [--repeats N]')
  process.exit(2)
}

loadEnvFile()
const key = describeKeyState()
console.log('═══ on_topic 影子测试 ═══')
console.log(`run: ${dir}`)
console.log(`key: ${key.present ? `${key.masked}（${key.source}）` : key.hint}`)
if (!key.present) { console.log('没有 key，跳过。'); process.exit(0) }

const rows = readFileSync(join(dir, 'jev-calls.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const verifies = rows.filter(r => r.phase === 'claim-verify')

// 从日志的 state 里还原断言 id 与文本（state 是判官当时看到的东西，一字不改地复用）
const claimRe = /【断言 ([^】]+)】([\s\S]*?)(?=【|$)/g
const atomRe = /【原子命题】([\s\S]*?)(?=【|$)/
const parseClaims = (state) => {
  const out = []
  for (const m of String(state).matchAll(claimRe)) out.push({ id: m[1].trim(), claim: m[2].trim() })
  return out
}

/**
 * 候选新问法。
 *
 * 第一轮只测了三个正向二元判断，结果暴露一个问题：它们的通过率走向极端
 * （4% / 98% / 0%），而且 `same_scope` 的 criteria 里我把失败形态列举了出来
 * （"是否把个案说成通例，或推广过头"）—— 那是**引导性措辞**，判官自然倾向判否。
 * 所以这一轮加入两组对照，把"内容判断"与"措辞偏置"分开：
 *
 *   · `drifts_*`：把 answers_atom **反转极性**问同一件事。
 *     若 p(drifts) ≈ 1 − p(answers_atom)，说明问题是对称的、低通过率是真实内容判断；
 *     若两边都"同意自己"（都很高），那通过率就是措辞造出来的。
 *   · `relation_*`：不用 boolean，改用**三选项 choice**。
 *     原问题的根本毛病是把一个三分类（直接回答／只提供相关证据／无关）
 *     硬压成一个概率 —— 而 choice 型在本系统里恰恰是校准最好的那个（support）。
 */
function splitQuestions(atom, claims) {
  const q = {}
  for (const c of claims) {
    q[`answers_atom_${c.id}`] = {
      type: 'boolean',
      instructions: `断言「${c.claim}」是否**直接回答**了原子命题「${atom}」？`
        + `注意：只是描述与命题相关的背景、或谈论命题涉及的某个侧面，都算"没有直接回答"。`,
      criteria: { true: '直接回答了该原子命题', false: '只是相关背景，没有回答该命题' },
    }
    // 极性对照：同一件事，反过来问
    q[`drifts_${c.id}`] = {
      type: 'boolean',
      instructions: `断言「${c.claim}」是否**没有**直接回答原子命题「${atom}」，`
        + `而只是提供了与该命题相关的背景材料？`,
      criteria: { true: '只是提供了相关背景，没有直接回答', false: '直接回答了该原子命题' },
    }
    q[`self_contained_${c.id}`] = {
      type: 'boolean',
      instructions: `断言「${c.claim}」本身能否独立读懂？`
        + `判断依据：它是否依赖"如上所述""前述""该文献"这类需要额外上下文的指代，`
        + `或者只是把原子命题换个说法重述一遍。`,
      criteria: { true: '本身独立可读，是一个完整论断', false: '依赖外部指代，或只是重述命题' },
    }
    q[`same_scope_${c.id}`] = {
      type: 'boolean',
      instructions: `断言「${c.claim}」所说的范围，与原子命题「${atom}」所问的范围是否一致？`,
      criteria: {
        true: '范围一致：问什么答什么',
        false: '范围不一致：答的比问的窄（只讲了个案）或宽（推广到了命题未涉及的领域）',
      },
    }
    // 三选项 choice：不逼着判官把一个三分类压成一个概率
    q[`relation_${c.id}`] = {
      type: 'choice',
      instructions: `断言「${c.claim}」与原子命题「${atom}」是什么关系？`,
      criteria: {
        answers: '断言直接回答了命题所问的问题',
        evidence: '断言没有直接回答，但提供了回答该命题所需的证据材料',
        unrelated: '断言与命题无关，或已经跑题',
      },
    }
  }
  return q
}

console.log(`日志里的 verify 调用：${verifies.length} 次；重问 ${REPEATS} 遍`)
console.log(`（state 一字不改，只换问题；预计 ${verifies.length * REPEATS} 次 JEV 调用）\n`)

const jev = createJev({ mode: 'http', logPath: join(dir, 'jev-ontopic-shadow.jsonl'), runId: 'shadow-ontopic' })

const collected = []   // 每行 = 一个断言在一遍里的全部判定
for (let rep = 1; rep <= REPEATS; rep++) {
  for (const rec of verifies) {
    const claims = parseClaims(rec.state)
    if (!claims.length) continue
    const atom = (atomRe.exec(rec.state) ?? [, ''])[1].trim()
    const questions = splitQuestions(atom, claims)
    const res = await jev.ask(rec.state, questions, {
      phase: 'shadow-ontopic', label: `shadow-r${rep}-${rec.label ?? ''}`, atom, round: rec.round,
    })
    if (!res.ok) { console.log(`  ✘ 调用失败：${res.error}`); continue }
    for (const c of claims) {
      const rel = res.answers[`relation_${c.id}`]
      collected.push({
        rep, atom, id: c.id, claim: c.claim,
        old: rec.answers?.[`on_topic_${c.id}`]?.probability ?? null,
        answers_atom: res.answers[`answers_atom_${c.id}`]?.probability ?? null,
        drifts: res.answers[`drifts_${c.id}`]?.probability ?? null,
        self_contained: res.answers[`self_contained_${c.id}`]?.probability ?? null,
        same_scope: res.answers[`same_scope_${c.id}`]?.probability ?? null,
        relation: rel?.choice ?? null,
        rel_answers: rel?.probabilities?.answers ?? null,
        rel_evidence: rel?.probabilities?.evidence ?? null,
        rel_unrelated: rel?.probabilities?.unrelated ?? null,
        rel_answ_evid: (rel?.probabilities?.answers ?? 0) + (rel?.probabilities?.evidence ?? 0),
      })
    }
    process.stdout.write('.')
  }
}
console.log('\n')

// ── 统计 ────────────────────────────────────────────────────
const f = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(3))
const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  if (!s.length) return null
  const i = (s.length - 1) / 2
  return s.length % 2 ? s[i] : (s[Math.floor(i)] + s[Math.ceil(i)]) / 2
}
const stats = (vals) => {
  const v = vals.filter(x => typeof x === 'number')
  if (!v.length) return null
  return {
    n: v.length,
    med: median(v),
    pass: v.filter(x => x >= THRESHOLD).length,
    flip: v.filter(x => x >= 0.55 && x <= 0.85).length,
    sens: [0.6, 0.7, 0.8].map(t => Math.round((v.filter(x => x >= t).length / v.length) * 100)),
  }
}

const KEYS = [
  ['旧 on_topic（一题混三义，含否定）', 'old'],
  ['新 answers_atom（方向·正向）', 'answers_atom'],
  ['对照 drifts（方向·反向）', 'drifts'],
  ['新 self_contained（形式）', 'self_contained'],
  ['新 same_scope（范围·中性措辞）', 'same_scope'],
  ['对照 relation=p(answers)（choice）', 'rel_answers'],
  ['对照 relation=p(answers+evidence)', 'rel_answ_evid'],
]

console.log('════════ 一、各问法的分布对比 ════════')
console.log('  问法'.padEnd(34) + 'n    中位数  ≥0.7   0.55–0.85  阈值0.6/0.7/0.8 通过率%')
for (const [label, k] of KEYS) {
  const s = stats(collected.map(r => r[k]))
  if (!s) { console.log(`  ${label.padEnd(32)} 无数据`); continue }
  console.log(`  ${label.padEnd(32)} ${String(s.n).padEnd(5)} ${f(s.med).padEnd(6)} `
    + `${String(Math.round((s.pass / s.n) * 100) + '%').padEnd(6)} `
    + `${String(Math.round((s.flip / s.n) * 100) + '%').padEnd(10)} ${s.sens.join('/').padEnd(16)}`)
}

// ── 与旧判定的一致率 ────────────────────────────────────────
console.log('════════ 二、与旧 on_topic 的判定一致率（换个问法有没有换掉判的对象）════════')
const use = collected.filter(r => typeof r.old === 'number')
for (const [label, k] of KEYS.slice(1)) {
  const both = use.filter(r => typeof r[k] === 'number')
  const agree = both.filter(r => (r.old >= THRESHOLD) === (r[k] >= THRESHOLD)).length
  const corr = (() => {
    const xs = both.map(r => r.old), ys = both.map(r => r[k])
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length
    const my = ys.reduce((a, b) => a + b, 0) / ys.length
    let num = 0, dx = 0, dy = 0
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2 }
    return dx && dy ? num / Math.sqrt(dx * dy) : null
  })()
  console.log(`  ${label.padEnd(32)} 判定一致 ${Math.round((agree / both.length) * 100)}%　相关系数 ${f(corr)}`)
}

// ── 极性对照：正问与反问是否互相矛盾 ──────────────────────
console.log('\n════════ 二·b、极性对照（正问 vs 反问是否互相印证）════════')
const pol = collected.filter(r => typeof r.answers_atom === 'number' && typeof r.drifts === 'number')
if (pol.length) {
  const bothLow = pol.filter(r => r.answers_atom < 0.5 && r.drifts < 0.5).length
  const bothHigh = pol.filter(r => r.answers_atom > 0.5 && r.drifts > 0.5).length
  const consistent = pol.filter(r => Math.abs(r.answers_atom + r.drifts - 1) <= 0.34).length
  const avgSum = pol.reduce((a, r) => a + r.answers_atom + r.drifts, 0) / pol.length
  console.log(`  n=${pol.length}　p(直接回答) + p(只是背景) 的平均和 = ${f(avgSum)}（理想为 1.000）`)
  console.log(`  两边都低（<0.5，自相矛盾）: ${bothLow}　两边都高（<0.5 矛盾）: ${bothHigh}　互补（|和−1|≤0.34）: ${consistent}`)
  console.log(`  → 和明显小于 1 说明两个方向都倾向"是"（措辞把判官推向各自的 true）；`)
  console.log(`    和明显大于 1 说明两个方向都倾向"否"。越接近 1 越说明问题是**对称**的。`)
}

// choice 版的两选项分布
console.log('\n════════ 二·c、relation 三选项的分布 ════════')
const relCount = {}
for (const r of collected) if (r.relation) relCount[r.relation] = (relCount[r.relation] ?? 0) + 1
for (const [k, v] of Object.entries(relCount)) console.log(`    ${String(k).padEnd(12)} ${v}`)

// ── 重复性：JEV 自身的随机性有多大 ─────────────────────────
console.log('\n════════ 三、重复性（同 state 问两遍，判定翻转率）════════')
if (REPEATS >= 2) {
  const byKey = new Map()
  for (const r of collected) {
    const k = `${r.atom}|${r.id}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(r)
  }
  for (const [label, key] of KEYS) {
    let flips = 0, pairs = 0
    for (const [, list] of byKey) {
      const v = list.map(x => x[key]).filter(x => typeof x === 'number')
      if (v.length < 2) continue
      pairs++
      const pass0 = v[0] >= THRESHOLD
      if (v.some(x => (x >= THRESHOLD) !== pass0)) flips++
    }
    console.log(`  ${label.padEnd(32)} 翻转 ${flips}/${pairs}　${pairs ? Math.round((flips / pairs) * 100) : 0}%`)
  }
  console.log('  （这个数是**噪声底**：问法再好也不可能低于它。新问法的翻转区占比若接近它，说明改进有限。）')
} else {
  console.log('  （--repeats 1，未测）')
}

// ── 逐条明细 ────────────────────────────────────────────────
console.log('\n════════ 四、逐条明细（第一遍）════════')
console.log('  旧    新:方向  新:形式  新:范围   断言')
for (const r of collected.filter(x => x.rep === 1)) {
  const mark = (p, o) => {
    const s = f(p)
    return (typeof p === 'number' && typeof o === 'number' && (p >= THRESHOLD) !== (o >= THRESHOLD)) ? `${s}*` : ` ${s}`
  }
  console.log(`  ${f(r.old)}  ${mark(r.answers_atom, r.old)}   ${mark(r.self_contained, r.old)}    ${mark(r.same_scope, r.old)}   ${r.claim.slice(0, 44)}`)
}
console.log('  （带 * = 该新问法与旧 on_topic 的判定不同）')

mkdirSync(join(dir), { recursive: true })
writeFileSync(join(dir, 'ontopic-shadow.json'), JSON.stringify({ repeats: REPEATS, rows: collected }, null, 2), 'utf8')
console.log(`\n明细已存：${join(dir, 'ontopic-shadow.json')}`)
console.log(`JEV 调用：${JSON.stringify(jev.stats())}`)
