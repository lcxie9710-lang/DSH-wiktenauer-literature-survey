/**
 * 从一次 run 的 `jev-calls.jsonl` 里统计**各环节判官给的概率分布**。
 *
 * 目的：回答「阈值 0.7 在某些环节是不是设高了、或者那个概率根本不具参考性」。
 * 靠读几条日志是答不出来的 —— 要看分布、看落在阈值附近（"犹豫区"）的比例、
 * 以及**把阈值挪一挪会有多少判定翻转**。后者才是"这个阈值有没有实际约束力"的证据。
 *
 * 用法：node packages/dsh-hema-v2/probes/analyze-run.mjs <run 目录>
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir || !existsSync(join(dir, 'jev-calls.jsonl'))) {
  console.error('用法：node analyze-run.mjs <run 目录>（里面要有 jev-calls.jsonl）')
  process.exit(2)
}

const rows = readFileSync(join(dir, 'jev-calls.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean)
  .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const num = (x) => (typeof x === 'number' ? x : null)
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : '—')
const f = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(3))
const q = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  if (!s.length) return null
  const i = (s.length - 1) * p
  const lo = Math.floor(i), hi = Math.ceil(i)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo)
}

/** 直方图：落在阈值附近（"犹豫区"）的有多少 */
const BANDS = [
  ['0.00–0.20 几乎否定', (p) => p < 0.2],
  ['0.20–0.40 倾向否定', (p) => p >= 0.2 && p < 0.4],
  ['0.40–0.60 真正拿不准', (p) => p >= 0.4 && p < 0.6],
  ['0.60–0.70 接近但不过', (p) => p >= 0.6 && p < 0.7],
  ['0.70–0.80 勉强过', (p) => p >= 0.7 && p < 0.8],
  ['0.80–1.00 明确肯定', (p) => p >= 0.8],
]

function report(name, values, { threshold = 0.7, higherPasses = true } = {}) {
  const v = values.filter(x => typeof x === 'number')
  if (!v.length) { console.log(`\n【${name}】无数据`); return null }
  const pass = higherPasses ? v.filter(x => x >= threshold).length : v.filter(x => x < threshold).length
  console.log(`\n【${name}】n=${v.length}　中位数 ${f(q(v, 0.5))}　均值 ${f(v.reduce((a, b) => a + b, 0) / v.length)}　范围 ${f(Math.min(...v))}–${f(Math.max(...v))}`)
  console.log(`  ≥${threshold} 的比例：${pct(pass, v.length)}`)
  for (const [label, test] of BANDS) {
    const n = v.filter(test).length
    console.log(`    ${label.padEnd(20)} ${String(n).padStart(4)}  ${'█'.repeat(Math.round((n / v.length) * 40))}`)
  }
  // 阈值敏感度：把阈值挪一挪，会有多少条判定翻转 —— 翻转越少，说明这个阈值越像"随便挑的"
  const sens = [0.5, 0.6, 0.7, 0.8, 0.9].map(t => {
    const p = v.filter(x => x >= t).length
    return `${t}:${pct(p, v.length)}`
  })
  console.log(`  阈值敏感度（各阈值下的通过率）：${sens.join('  ')}`)
  const nearThreshold = v.filter(x => x >= 0.55 && x <= 0.85).length
  console.log(`  落在 0.55–0.85（"阈值一挪就翻"）的比例：${pct(nearThreshold, v.length)}`)
  return { n: v.length, pass, nearThreshold }
}

console.log(`═══ 分析 ${dir} ═══`)
console.log(`JEV 调用总数：${rows.length}`)

const byPhase = new Map()
for (const r of rows) {
  const k = r.phase ?? '(未标注)'
  if (!byPhase.has(k)) byPhase.set(k, [])
  byPhase.get(k).push(r)
}
console.log(`按环节：${[...byPhase.entries()].map(([k, v]) => `${k}×${v.length}`).join('、')}`)

// ── 1. 分解检查 ────────────────────────────────────────────
const dec = byPhase.get('decompose') ?? []
if (dec.length) {
  console.log('\n════════ 一、分解检查（A 组）════════')
  const bools = { coverage: [], independent: [] }
  const answerable = [], focusMass = []
  for (const r of dec) {
    for (const [qid, a] of Object.entries(r.answers ?? {})) {
      const p = num(a?.probability)
      if (qid === 'coverage' && p !== null) bools.coverage.push(p)
      if (qid === 'independent' && p !== null) bools.independent.push(p)
      if (qid.startsWith('answerable_')) {
        answerable.push({ p: num(a?.probabilities?.answerable), choice: a?.choice })
      }
      if (qid.startsWith('focus_')) {
        // score：可接受等级（HemaDecompose 里是 index 2±1）的概率质量和
        const probs = a?.probabilities ?? {}
        const mass = (probs['1'] ?? 0) + (probs['2'] ?? 0) + (probs['3'] ?? 0)
        focusMass.push({ mass, score: num(a?.score) })
      }
    }
    console.log(`  [${r.label}] atom=${String(r.atom ?? '').slice(0, 30)} stateChars=${r.stateChars} ms=${r.ms}`)
  }
  report('coverage（整体是否覆盖原问题）', bools.coverage)
  report('independent（子题是否互相独立）', bools.independent)
  report('answerable_* 的 p(answerable)', answerable.map(a => a.p))
  console.log(`  answerable 被判"不可取证"的条数：${answerable.filter(a => a.choice === 'unanswerable').length}/${answerable.length}`)
  report('focus_* 的可接受范围质量和', focusMass.map(x => x.mass))
  const scores = focusMass.map(x => x.score).filter(x => x !== null)
  if (scores.length) {
    console.log(`  focus 的浮点 score（0=过宽…4=过窄）：${scores.map(s => f(s)).join(', ')}`)
  }
}

// ── 2. 跳转（相关度）────────────────────────────────────────
const jump = byPhase.get('jump') ?? []
if (jump.length) {
  console.log('\n════════ 二、跳转（路由决策）════════')
  const rel = [], nextChoiceP = [], noneCount = []
  let nonePicked = 0
  for (const r of jump) {
    const p = num(r.answers?.relevance?.probability)
    if (p !== null) rel.push(p)
    const nx = r.answers?.next
    if (nx) {
      if (nx.choice === 'NONE') nonePicked++
      const probs = nx.probabilities ?? {}
      const vals = Object.entries(probs).filter(([k]) => k !== 'NONE').map(([, v]) => v)
      const maxCand = vals.length ? Math.max(...vals) : 0
      nextChoiceP.push(maxCand)
      noneCount.push(num(probs.NONE) ?? 0)
    }
  }
  report('relevance（当前页是否与原子命题高度相关）', rel)
  console.log(`  判"高相关"（≥0.7）的步数：${rel.filter(x => x >= 0.7).length}/${rel.length}`)
  console.log(`  next 选 NONE 的次数：${nonePicked}/${jump.length}`)
  report('next 里**最高候选**的概率（判断这步选择有多确定）', nextChoiceP)
  const lowConfidence = nextChoiceP.filter(x => x < 0.4).length
  console.log(`  最高候选概率 <0.4（≈在候选间瞎猜）的步数：${lowConfidence}/${nextChoiceP.length}　${pct(lowConfidence, nextChoiceP.length)}`)

  // 按子题目分组：预算有没有被突破、各子题目分别烧了多少
  console.log('\n  ── 按子题目分组的跳转花费 ──')
  const perAtom = new Map()
  for (const r of jump) {
    const a = String(r.atom ?? '(无)')
    if (!perAtom.has(a)) perAtom.set(a, { calls: 0, rel: [] })
    const e = perAtom.get(a)
    e.calls++
    const p = num(r.answers?.relevance?.probability)
    if (p !== null) e.rel.push(p)
  }
  for (const [a, e] of perAtom) {
    const hi = e.rel.filter(x => x >= 0.7).length
    console.log(`    ${String(e.calls).padStart(3)} 次  (≥0.7 相关 ${hi} 次)  ${a.slice(0, 46)}`)
  }
}

// ── 3. 断言验证（B+C 组）──────────────────────────────────
const ver = byPhase.get('claim-verify') ?? []
if (ver.length) {
  console.log('\n════════ 三、断言验证（B+C 组）════════')
  const sup = { SUPPORTED: [], PARTIALLY_SUPPORTED: [], CONTRADICTED: [], NOT_IN_SOURCE: [], AMBIGUOUS: [] }
  const onTopic = [], specMass = []
  const choiceCount = {}
  for (const r of ver) {
    for (const [qid, a] of Object.entries(r.answers ?? {})) {
      if (qid.startsWith('support_')) {
        const probs = a?.probabilities ?? {}
        for (const k of Object.keys(sup)) if (typeof probs[k] === 'number') sup[k].push(probs[k])
        choiceCount[a?.choice] = (choiceCount[a?.choice] ?? 0) + 1
      }
      if (qid.startsWith('on_topic_')) onTopic.push(num(a?.probability))
      if (qid.startsWith('specificity_')) {
        const probs = a?.probabilities ?? {}
        specMass.push((probs['2'] ?? 0) + (probs['3'] ?? 0))
      }
    }
    console.log(`  [${r.label}] atom=${String(r.atom ?? '').slice(0, 26)} 断言数=${Object.keys(r.answers ?? {}).filter(k => k.startsWith('support_')).length} stateChars=${r.stateChars}`)
  }
  console.log(`\n【support_* 的裁决分布】`)
  for (const [k, v] of Object.entries(choiceCount)) console.log(`    ${String(k).padEnd(20)} ${v}`)
  report('support_* 的 p(SUPPORTED)', sup.SUPPORTED)
  report('support_* 的 p(NOT_IN_SOURCE)', sup.NOT_IN_SOURCE)
  report('support_* 的 p(PARTIALLY_SUPPORTED)', sup.PARTIALLY_SUPPORTED)
  report('on_topic_* 的 p(true)', onTopic)
  report('specificity_* 的可接受等级质量和', specMass)
}

// ── 4. 逐条证据诊断 ───────────────────────────────────────
const diag = byPhase.get('evidence-diagnosis') ?? []
if (diag.length) {
  console.log('\n════════ 四、逐条证据诊断 ════════')
  const vals = []
  for (const r of diag) for (const [, a] of Object.entries(r.answers ?? {})) vals.push(num(a?.probability))
  report('诊断：单条来源是否支持断言', vals)
}

// ── 5. 总览：一次 run 的成本与结论 ─────────────────────────
console.log('\n════════ 五、成本与结论总览 ════════')
const ms = rows.map(r => num(r.ms)).filter(x => x !== null)
console.log(`  JEV 调用 ${rows.length} 次，累计 ${(ms.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s，单次中位数 ${f(q(ms, 0.5))}ms`)
console.log(`  state 总量 ${(rows.reduce((a, r) => a + (r.stateChars ?? 0), 0) / 1000).toFixed(0)}k 字符`)
for (const [k, v] of byPhase) console.log(`    ${k.padEnd(20)} ${String(v.length).padStart(4)} 次`)
