/**
 * Stage 5 · 端到端编排 CLI
 *
 * 把五个阶段串成一条可运行的链路，并把每一步的原始产物落盘（可审计、可重放）：
 *
 *   provision      生成隔离 DSH_HOME 与三个角色 profile（幂等）
 *        ↓
 *   runDecomposition   leader 分解 + JEV A 组检查，3 轮封顶 → 悬置问用户
 *        ↓
 *   runChains          每条子题一条链：
 *                        → researcher 取证产包
 *                        → JEV B+C 组判定
 *                        → 打回 researcher（≤3 轮）→ 仍不过 = 证据悬置
 *        ↓
 *   runReport          报告撰写者 + 确定性后置检查 + 代码兜底强制「证据悬置」节
 *
 * 用法：
 *   node packages/dsh-hema-v2/harness/run.mjs --question "Zornhau 是什么，在 Liechtenauer 体系中怎么用？"
 *   node packages/dsh-hema-v2/harness/run.mjs --question-file q.txt --jev stub --dry-run
 *   node packages/dsh-hema-v2/harness/run.mjs --question "..." --jev http      # 需要 AI_GATEWAY_API_KEY
 *   node packages/dsh-hema-v2/harness/run.mjs --self-test                      # 不调模型，只验接线
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { V2_ROOT } from '../lib/wiki.mjs'
import { createJev } from '../lib/jev.mjs'
import { runDecomposition, acceptUserEdit, toChains, DECOMPOSE_DEFAULTS } from '../lib/decompose.mjs'
import { runChains, CHAIN_DEFAULTS } from '../lib/chain.mjs'
import { buildReportBrief, runReport, REPORT_DEFAULTS, SUSPENSION_HEADING } from '../lib/report.mjs'
import { provision, verify as verifyProfiles, DSH_HOME, ROLES } from './provision.mjs'
import { runRole, resolveDshEntry } from './dsh.mjs'
import { leaderPrompt, researcherPrompt, writerPrompt, parseSubQuestions, parseClaims } from './roles.mjs'
import { renderTrace } from './trace.mjs'

// ── 参数 ────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const flag = (name) => argv.includes(`--${name}`)

const SELF_TEST = flag('self-test')
const DRY = flag('dry-run')
const JEV_MODE = opt('jev', 'stub')
const ACCEPT_RATE = Number(opt('accept-rate', 0.5))
const TIMEOUT_MS = Number(opt('timeout', 600_000))
const RUN_ID = opt('run-id', `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)
const OUT_DIR = join(V2_ROOT, 'out', RUN_ID)

let QUESTION = opt('question', null)
const qFile = opt('question-file', null)
if (!QUESTION && qFile && existsSync(qFile)) QUESTION = readFileSync(qFile, 'utf8').trim()
if (!QUESTION && !SELF_TEST) QUESTION = 'Zornhau（怒击）是什么，在 Liechtenauer 体系中怎么用？'

const CFG = {
  maxDecomposeRounds: Number(opt('max-decompose-rounds', DECOMPOSE_DEFAULTS.maxRounds)),
  maxClaimRounds: Number(opt('max-claim-rounds', CHAIN_DEFAULTS.maxRounds)),
  maxReportRounds: Number(opt('max-report-rounds', REPORT_DEFAULTS.maxRounds)),
  subQuestions: opt('sub-questions', null), // 用户手改的分解，见下
}

const events = []
const onEvent = (e) => {
  events.push({ at: new Date().toISOString(), ...e })
  const tag = e.type ?? '?'
  const bits = []
  for (const k of ['role', 'round', 'phase', 'step', 'id', 'page', 'relevance', 'next', 'stats', 'pass', 'failedCount', 'detail', 'error']) {
    if (e[k] !== undefined && e[k] !== null) bits.push(`${k}=${typeof e[k] === 'object' ? JSON.stringify(e[k]) : e[k]}`)
  }
  console.log(`  [${tag}] ${bits.join(' ')}`.slice(0, 220))
}

function save(name, obj) {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8')
}

// ── 接线自检：不调模型、不调网络，只验各层拼得起来 ──────────
if (SELF_TEST) {
  let fails = 0
  const ok = (name, cond, extra = '') => {
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
    if (!cond) fails++
  }
  console.log('── Stage 5 接线自检 ──')
  const prov = provision()
  ok('隔离 DSH_HOME 生成', prov.written.length === 14, `${prov.written.length} 文件`)
  ok('生成物自检', verifyProfiles().ok, JSON.stringify(verifyProfiles().issues))
  ok('三个角色齐备', Object.keys(ROLES).length === 3, Object.keys(ROLES).join(','))
  ok('dsh 入口可解析', Boolean(resolveDshEntry()), resolveDshEntry() ?? '')
  ok('DSH_HOME 存在', existsSync(DSH_HOME), DSH_HOME)

  // 提示词渲染 + 结构化提取闭环
  const lp = leaderPrompt({ question: QUESTION, round: 1, feedback: null, hint: 'x' })
  ok('leader 提示词含研究题目', lp.includes(QUESTION))
  ok('leader 提示词含 JSON 格式说明', /"subQuestions"/.test(lp))
  const sq = parseSubQuestions('前置废话\n```json\n{"subQuestions":[{"id":"sq1","text":"t"}]}\n```\n后置')
  ok('leader 输出能被解析', sq.parsed && sq.subQuestions.length === 1)

  const rp = researcherPrompt({ atom: 'a', round: 1, pages: [{ page: 'P', heading: 'H', locator: { page: 'P', anchor: 'H', revid: 7 }, preview: 'p' }], feedback: null })
  ok('researcher 提示词含定位符', /"anchor": "H"/.test(rp) || /anchor/.test(rp))
  ok('researcher 提示词含"证据是定位符而非原文摘抄"', /证据不是原文摘抄/.test(rp) && /不要在证据字段里贴引文/.test(rp))
  const cl = parseClaims('```json\n{"claims":[{"id":"c1","claim":"x","evidence":[{"page":"P"}]}]}\n```')
  ok('researcher 输出能被解析', cl.parsed && cl.claims.length === 1)

  // 各种脏输出都要能捞出来
  ok('无语言标签的围栏可解析', parseClaims('```\n{"claims":[]}\n```').parsed)
  ok('裸 JSON 可解析（平衡括号兜底）', parseClaims('说明文字 {"claims":[{"id":"c1"}]} 结尾').parsed)
  ok('纯文本 → parsed=false 而不抛异常', parseClaims('完全没有 JSON').parsed === false)
  ok('空输入 → 不抛异常', parseClaims('').parsed === false)
  ok('数组形式也可接受', parseClaims('[{"id":"c1"}]').parsed)

  const wp = writerPrompt({ question: QUESTION, rendered: 'R', round: 1, issues: null })
  ok('writer 提示词含悬置硬规则', /证据悬置/.test(wp))
  ok('writer 提示词含"不得当结论"', /不得.*结论/.test(wp))

  // dry-run 一次角色调用，确认命令能生成
  const dr = runRole({ role: 'hema-leader', prompt: 'x', outDir: OUT_DIR, dryRun: true, onEvent })
  ok('dry-run 不执行也不报错', dr.ok && dr.dryRun)
  ok('dry-run 未产出 stdout', dr.stdout === '')

  console.log(`\n${fails === 0 ? '接线自检全部通过' : fails + ' 项失败'}`)
  process.exit(fails === 0 ? 0 : 1)
}

// ── 主流程 ──────────────────────────────────────────────────
console.log(`\n═══ HEMA v2 harness ═══`)
console.log(`run-id      : ${RUN_ID}`)
console.log(`问题        : ${QUESTION}`)
console.log(`JEV 模式    : ${JEV_MODE}${JEV_MODE === 'stub' ? '  ⚠ 裁决是启发式词袋假数据，只验管道' : JEV_MODE === 'fixture' ? `  ⚠ 裁决由哈希决定（acceptRate=${ACCEPT_RATE}），只验路由不验质量` : ''}`)
console.log(`输出        : ${OUT_DIR}`)
console.log(`轮数上限    : 分解 ${CFG.maxDecomposeRounds} / 断言 ${CFG.maxClaimRounds} / 报告 ${CFG.maxReportRounds}`)
console.log(`dry-run     : ${DRY}\n`)

mkdirSync(OUT_DIR, { recursive: true })
provision()

const jev = createJev({
  mode: JEV_MODE,
  acceptRate: ACCEPT_RATE,
  // per-run 隔离：全局那个 jev-log.jsonl 混着所有 run 的调用，无法把裁决与某次运行对上。
  // 这里同时带 runId，跨文件也能关联。
  logPath: join(OUT_DIR, 'jev-calls.jsonl'),
  runId: RUN_ID,
})
const apiKey = process.env.AI_GATEWAY_API_KEY
if (JEV_MODE === 'http' && !apiKey) {
  console.error('❌ --jev http 需要 AI_GATEWAY_API_KEY（或 cfg.apiKey）。中止，避免静默降级成 stub。')
  process.exit(2)
}

// 每个角色调用都写进同一个 outDir，文件名带阶段前缀，便于按序阅读
const roleOut = join(OUT_DIR, 'roles')
let roleCallSeq = 0
const callRole = ({ role, prompt, phase }) => {
  const label = `${String(++roleCallSeq).padStart(3, '0')}-${phase}`
  return runRole({ role, prompt, label, outDir: roleOut, timeoutMs: TIMEOUT_MS, dryRun: DRY, onEvent })
}

// ── 阶段 1：分解 ────────────────────────────────────────────
console.log('── 阶段 1／3：leader 分解 + A 组检查 ──')
let decomposition
if (CFG.subQuestions) {
  // 用户手改的分解：直接接受，不重新检查
  const parsed = parseSubQuestions(CFG.subQuestions)
  decomposition = acceptUserEdit(QUESTION, parsed.subQuestions, { note: '--sub-questions 由用户提供' })
  console.log(`  用户提供的分解：${decomposition.subQuestions.length} 条（不重新检查）`)
} else {
  decomposition = await runDecomposition({
    question: QUESTION,
    jev,
    cfg: { maxRounds: CFG.maxDecomposeRounds },
    onEvent,
    askLeader: async (ctx) => {
      const r = await callRole({ role: 'hema-leader', prompt: leaderPrompt(ctx), phase: `leader-r${ctx.round}` })
      if (!r.ok) throw new Error(`leader 调用失败: ${r.error ?? `exit ${r.exitCode}`} ${r.spawnError ?? ''}`)
      return parseSubQuestions(r.stdout)
    },
  })
}
save('01-decomposition.json', decomposition)

if (decomposition.status !== 'accepted') {
  console.log(`\n⚠ 分解在第 ${decomposition.rounds} 轮仍未通过检查 —— **悬置，需要你介入**。`)
  console.log(`  最后版本 ${decomposition.subQuestions.length} 条子题目，未通过项：`)
  for (const f of decomposition.judgement?.failed ?? []) console.log(`    · ${f.label}`)
  console.log(`\n  请编辑后重跑，用 --sub-questions '<JSON>' 传入你的分解（用户编辑不再重新检查）：`)
  console.log(`    --sub-questions '${JSON.stringify({ subQuestions: decomposition.subQuestions })}'`)
  save('01-decomposition.NEEDS_HUMAN.json', decomposition)
  console.log(`\n产物：${OUT_DIR}`)
  process.exit(3)
}
console.log(`  接受 ${decomposition.subQuestions.length} 条子题目（${decomposition.reason}），用 ${decomposition.rounds} 轮`)

const chains = toChains(QUESTION, decomposition.subQuestions)

// ── 阶段 2：每条子题一条链 ──────────────────────────────────
console.log(`\n── 阶段 2／3：${chains.length} 条链（取证 → JEV 判定 → 打回）──`)
const chainResults = []
for (const [i, ch] of chains.entries()) {
  console.log(`\n  ▸ 链 ${i + 1}/${chains.length}：${ch.atom}`)
  const res = await runChains([ch], {
    jev,
    cfg: {
      maxRounds: CFG.maxClaimRounds,
    },
    onEvent,
    askResearcher: async (ctx) => {
      const r = await callRole({
        role: 'hema-researcher',
        prompt: researcherPrompt({ atom: ctx.atom, ...ctx }),
        phase: `researcher-${ch.id}-r${ctx.round}`,
      })
      if (!r.ok) throw new Error(`researcher 调用失败: ${r.error ?? `exit ${r.exitCode}`} ${r.spawnError ?? ''}`)
      return parseClaims(r.stdout)
    },
  })
  // runChains 内部按 ch.terms 解析起跳页；这里补一次日志便于审计
  if (ch.terms?.length) console.log(`    子题术语: ${ch.terms.join(', ')}`)
  const one = res.chains[0]
  chainResults.push(one)
  save(`02-chain-${ch.id}.json`, one)
  console.log(`    通过 ${one.accepted.length} 条，证据悬置 ${one.insufficient.length} 条（验证 ${one.stats.verifications} 次）`)
}

const accepted = chainResults.flatMap(r => r.accepted.map(a => ({ ...a, atom: r.atom })))
const insufficient = chainResults.flatMap(r => r.insufficient.map(a => ({ ...a, atom: r.atom })))
console.log(`\n  合计：通过 ${accepted.length} 条，证据悬置 ${insufficient.length} 条`)

// ── 阶段 3：报告 ────────────────────────────────────────────
console.log('\n── 阶段 3／3：报告撰写 + 确定性后置检查 ──')
const brief = buildReportBrief({ question: QUESTION, decomposition, chains, accepted, insufficient })
save('03-brief.json', brief)

const reportRes = await runReport({
  question: QUESTION,
  brief,
  cfg: { maxRounds: CFG.maxReportRounds },
  onEvent,
  askWriter: async (ctx) => {
    const r = await callRole({ role: 'hema-writer', prompt: writerPrompt(ctx), phase: `writer-r${ctx.round}` })
    if (!r.ok) throw new Error(`writer 调用失败: ${r.error ?? `exit ${r.exitCode}`} ${r.spawnError ?? ''}`)
    return r.stdout
  },
})
save('04-report.md', reportRes.report)
save('04-report-check.json', {
  writerPassed: reportRes.writerPassed, appendedByCode: reportRes.appendedByCode,
  check: reportRes.check, rounds: reportRes.rounds, stats: reportRes.stats,
  // 每轮的校验结果都留下：只看终稿看不出"被打回过几次、每次卡在哪一条"
  history: reportRes.history,
})

// ── 审计汇总 ────────────────────────────────────────────────
// 把 per-run 的 JEV 调用日志读回来，用于 trace 与汇总统计
const jevLogPath = join(OUT_DIR, 'jev-calls.jsonl')
let jevRecords = []
try {
  jevRecords = readFileSync(jevLogPath, 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
} catch { /* 没有就是没有（例如 dry-run） */ }

save('00-audit.json', {
  runId: RUN_ID, question: QUESTION, at: new Date().toISOString(),
  config: { ...CFG, jevMode: JEV_MODE, dryRun: DRY },
  decomposition: {
    status: decomposition.status, reason: decomposition.reason,
    userEdited: Boolean(decomposition.userEdited),
    subQuestions: decomposition.subQuestions, rounds: decomposition.rounds,
  },
  chains: chainResults.map(r => ({
    atom: r.atom, complete: r.complete, stats: r.stats, rounds: r.rounds,
    accepted: r.accepted.map(a => ({ id: a.id, claim: a.claim, sources: a.sources })),
    insufficient: r.insufficient.map(a => ({ id: a.id, claim: a.claim, reason: a.reason, lastReasons: a.lastReasons })),
  })),
  report: { writerPassed: reportRes.writerPassed, appendedByCode: reportRes.appendedByCode, issues: reportRes.check.issues },
  jev: jev.stats(),
  jevCalls: { total: jevRecords.length, byPhase: jevRecords.reduce((a, r) => { const k = r.phase ?? '?'; a[k] = (a[k] ?? 0) + 1; return a }, {}) },
  events,
})
save('00-events.jsonl', events.map(e => JSON.stringify(e)).join('\n') + '\n')

// 人能读的全链路时间线：把上面各产物按因果顺序摊平
save('00-trace.md', renderTrace({
  runId: RUN_ID, question: QUESTION,
  decomposition, chains: chainResults, report: reportRes,
  jevRecords,
  config: { jevMode: JEV_MODE, acceptRate: ACCEPT_RATE, ...CFG },
}))

console.log(`\n═══ 完成 ═══`)
console.log(`通过断言    : ${accepted.length}`)
console.log(`证据悬置    : ${insufficient.length}${insufficient.length ? '  （已强制写入报告的「证据悬置」节）' : ''}`)
// 如实区分"一稿就过"和"打回重写后才过"—— 两者说明的撰写者表现不同，不能都写成"通过"
// 如实区分"一稿就过"和"打回重写后才过"—— 两者说明的撰写者表现不同，不能都写成"通过"。
// 另外「撰写者没过检查」与「代码补写了悬置条目」是两件事：撰写者可能列全了悬置条目
// 却栽在别的检查项上，那时代码无事可补。混成一句话会误报。
console.log(`报告撰写者  : ${reportRes.writerPassed
  ? (reportRes.rounds === 1 ? '一稿即通过校验' : `第 ${reportRes.rounds} 稿通过校验（前 ${reportRes.rounds - 1} 稿被打回）`)
  : `${reportRes.rounds} 稿均未通过校验`}`)
console.log(`兜底补写    : ${reportRes.appendedByCode
  ? '有（撰写者漏列悬置条目，已由代码补进悬置节）'
  : reportRes.writerPassed
    ? '无需'
    : '无（撰写者的悬置节本身是完整的；未通过的是别的检查项，见 04-report-check.json）'}`)
if (!reportRes.writerPassed) {
  for (const i of reportRes.check.issues) console.log(`  未过项    : [${i.code}] ${String(i.detail).slice(0, 200)}`)
}
console.log(`JEV 调用    : ${JSON.stringify(jev.stats())}`)
console.log(`产物目录    : ${OUT_DIR}`)
console.log(`  ├ 00-trace.md         全链路时间线（人可读，含每轮裁决与逐条证据诊断）`)
console.log(`  ├ 04-report.md        最终报告`)
console.log(`  ├ 00-audit.json       汇总审计（分解、各链、报告、JEV 统计）`)
console.log(`  ├ 00-events.jsonl     事件流（可重放）`)
console.log(`  ├ 01/02/03/04-*.json  分阶段结构化记录`)
console.log(`  ├ jev-calls.jsonl     ${jevRecords.length} 次 JEV 调用（含喂进去的 state 全文）`)
console.log(`  └ roles/              每个角色每次调用的 prompt / stdout / reasoning 原文`)
if (JEV_MODE === 'stub') console.log(`\n⚠ 本次用 stub 判官：管道是真的，裁决是假的。裁决质量需用 --jev http 验。`)
if (JEV_MODE === 'fixture') console.log(`\n⚠ 本次用 fixture 判官：路由是真的，裁决是哈希编的。裁决质量需用 --jev http 验。`)
process.exit(0)
