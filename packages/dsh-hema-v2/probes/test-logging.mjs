/**
 * 探针 —— 全链路留痕（审计能力本身也要被验证）
 *
 * 为什么单独一个探针：日志是最容易**静默退化**的东西。
 * 少记一个字段不会有任何报错，只会在几周后你想复盘某次判否时才发现
 * "当时喂给判官的是什么"永远拿不回来了。
 *
 * 这里锁死四件事：
 *   1. 每次 JEV 调用都记下**喂进去的 state 全文**与 questions 全文
 *   2. 每条记录带 runId 与 phase（能把裁决关联回某次 run、某个环节）
 *   3. 跳转逐步轨迹（含**候选名单与概率**）进产物，而不只活在进程内存里
 *   4. 人能读的 trace 确实把各阶段缝在了一起
 */
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJev, claimQuestions, decompositionQuestions, perEvidenceQuestions } from '../lib/jev.mjs'
import { runChain } from '../lib/chain.mjs'
import { renderTrace } from '../harness/trace.mjs'
import { makeLocator } from '../lib/wiki.mjs'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}
const head = (s) => console.log(`\n── ${s} ──`)

const tmp = mkdtempSync(join(tmpdir(), 'hema-log-'))
const readLog = (p) => {
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

// ══════════════════════════════════════════════════════════════
head('1) 每次 JEV 调用都记 state 全文 + questions 全文')
const logPath = join(tmp, 'jev-calls.jsonl')
const jev = createJev({ mode: 'stub', logPath, runId: 'run-TEST' })
const state = [
  '【原子命题】Zornhau 的起手动作是什么？',
  '【断言 c1】Zornhau 是一记从上方斜劈的斩击。',
  '【证据 c1】',
  '<来源 1: Zornhaw#Meÿer @110509>',
  'Zornhau is a strike from the upper right. 这一段是**判官当时看到的原文**。',
].join('\n')
await jev.ask(state, claimQuestions([{ id: 'c1', claim: 'x', subQuestion: 'q' }]), {
  phase: 'claim-verify', label: 'verify-r1', atom: 'Zornhau 的起手动作是什么？', round: 1,
})
const recs = readLog(logPath)
ok('写入了调用记录', recs.length === 1, `${recs.length} 条`)
const r0 = recs[0]
ok('记下了 state 全文（不只是长度）', typeof r0.state === 'string' && r0.state.includes('判官当时看到的原文'),
  `stateChars=${r0.stateChars}`)
ok('state 与传入完全一致', r0.state === state)
ok('记下了 questions 全文', r0.questions?.support_c1?.type === 'choice' && Object.keys(r0.questions.support_c1.criteria).length === 5,
  Object.keys(r0.questions ?? {}).join(','))
ok('记下了裁决 answers', r0.answers?.support_c1?.choice !== undefined)
ok('带 runId', r0.runId === 'run-TEST', String(r0.runId))
ok('带 phase', r0.phase === 'claim-verify', String(r0.phase))
ok('带 label / atom / round', r0.label === 'verify-r1' && r0.round === 1 && Boolean(r0.atom))
ok('带序号 seq（可按序阅读）', r0.seq === 1, String(r0.seq))
ok('带 stateChars（便于快速筛大 state）', r0.stateChars === state.length, String(r0.stateChars))

head('1b) seq 递增，多个 phase 都能区分')
await jev.ask(state, decompositionQuestions([{ id: 'sq1', text: 't' }]), { phase: 'decompose', round: 1 })
await jev.ask(state, perEvidenceQuestions({ id: 'c1', claim: 'x' }, [{ label: 'A' }, { label: 'B' }]), { phase: 'evidence-diagnosis', round: 2 })
const recs2 = readLog(logPath)
ok('3 次调用 3 条记录', recs2.length === 3, `${recs2.length}`)
ok('seq 递增', recs2.map(r => r.seq).join(',') === '1,2,3', recs2.map(r => r.seq).join(','))
ok('phase 可区分', recs2.map(r => r.phase).join(',') === 'claim-verify,decompose,evidence-diagnosis',
  recs2.map(r => r.phase).join(','))

head('1c) logFullState=false 时可只记长度（state 极大时的退路）')
const leanPath = join(tmp, 'lean.jsonl')
const leanJev = createJev({ mode: 'stub', logPath: leanPath, logFullState: false })
await leanJev.ask(state, claimQuestions([{ id: 'c1', claim: 'x' }]), { phase: 'claim-verify' })
const lean = readLog(leanPath)[0]
ok('不记 state 正文', lean.state === undefined)
ok('仍然记长度', lean.stateChars === state.length)

head('1d) JEV 失败时也要留痕（失败日志最不能丢）')
const deadJev = createJev({ mode: 'http', apiKey: '', logPath: join(tmp, 'dead.jsonl'), runId: 'run-DEAD' })
const dres = await deadJev.ask(state, claimQuestions([{ id: 'c1', claim: 'x' }]), { phase: 'claim-verify' })
ok('无 key 时返回 ok:false（不静默降级）', dres.ok === false)
// 无 key 是**调用前**拦截，没有发出请求，所以不写日志 —— 这是有意的：不谎报发生过调用
ok('调用前的拦截不写假日志（不谎报发生过调用）', readLog(join(tmp, 'dead.jsonl')).length === 0)

// ══════════════════════════════════════════════════════════════
head('3) 链产物里也要能看到跳转轨迹（不能只活在内存里）')
const DOCS = { Zornhaw: 'Zornhau 是一记从上方斜劈的斩击，起手自右侧。zornhau is a diagonal strike.' }
const chainRes = await runChain({
  atom: '怒击（Zornhau）的起手动作是什么？',
  terms: ['Zornhau'],
  jev: createJev({ mode: 'fixture', acceptRate: 1, logPath: join(tmp, 'chain.jsonl'), runId: 'run-CHAIN' }),
  deps: {
    dereference: async (loc) => {
      const t = DOCS[loc.page]
      if (t === undefined) return { ok: false, reason: 'PAGE_NOT_FOUND', page: loc.page, text: '', paragraphs: [] }
      return { ok: true, page: loc.page, anchor: loc.anchor, revid: 500, text: t, paragraphs: [t] }
    },
  },
  cfg: { maxRounds: 1 },
  askResearcher: async () => ({ claims: [{ id: 'c1', claim: 'Zornhau 是一记从上方斜劈的斩击，起手自右侧。', evidence: [makeLocator({ page: 'Zornhaw', anchor: null })] }] }),
})
const chainLog = readLog(join(tmp, 'chain.jsonl'))
ok('链里的 JEV 调用带 phase=claim-verify', chainLog.some(r => r.phase === 'claim-verify'))
ok('链里的 JEV 调用都带 runId', chainLog.every(r => r.runId === 'run-CHAIN'))

// ══════════════════════════════════════════════════════════════
head('4) trace 把各阶段缝成人能读的时间线')
const traceMd = renderTrace({
  runId: 'run-TEST', question: 'Q?',
  decomposition: {
    status: 'accepted', reason: 'JEV_CHECK_PASSED', rounds: 1,
    subQuestions: [{ id: 'sq1', text: '子题一', terms: ['Zornhau'] }],
    history: [{ round: 1, subQuestions: [{ id: 'sq1', text: '子题一', terms: ['Zornhau'] }], passedCount: 4, failedCount: 0 }],
  },
  chains: [{
    atom: '子题一', accepted: [{ id: 'c1' }], insufficient: [{ id: 'c2' }],
    terms: ['Zornhau'],
    history: [{
      round: 1, verifiedCount: 2, hardBlockedCount: 0, frozenCount: 0,
      claims: [
        { id: 'c1', claim: '断言一', status: 'passed' },
        { id: 'c2', claim: '断言二', status: 'rejected', reasons: ['证据不支持'], sources: ['Zornhaw (整页) @110509'], evidenceDiagnosis: [{ label: 'Zornhaw (整页) @110509', supports: false, p: 0.12 }] },
      ],
    }],
  }],
  report: { writerPassed: true, rounds: 1, appendedByCode: false, stats: { chars: 1000 }, history: [{ round: 1, chars: 1000, check: { pass: true, issues: [] } }] },
  jevRecords: [
    { seq: 1, phase: 'decompose', round: 1, stateChars: 100 },
    { seq: 3, phase: 'claim-verify', round: 1, stateChars: 300, atom: '子题一' },
  ],
  config: { jevMode: 'fixture', acceptRate: 0.55, maxDecomposeRounds: 3, maxClaimRounds: 2, maxReportRounds: 3 },
})
ok('trace 有标题与题目', traceMd.includes('全链路 trace — run-TEST') && traceMd.includes('Q?'))
ok('trace 含分解阶段与 terms', traceMd.includes('leader 分解') && traceMd.includes('terms'))
// 跳转段已随跳转器一并删除：trace 现在只渲染 分解 → 每轮断言与裁决 → 报告 → 产物索引。
ok('trace 含链的子题术语', traceMd.includes('子题术语'))
ok('trace 含逐条断言与裁决', traceMd.includes('断言一') && traceMd.includes('断言二'))
ok('trace 标出逐条证据诊断', traceMd.includes('逐条证据诊断'))
ok('trace 含证据来源', traceMd.includes('@110509'))
ok('trace 含报告阶段', traceMd.includes('一稿即通过校验'))
ok('trace 含产物索引（告诉读者去哪找全文）', traceMd.includes('jev-calls.jsonl') && traceMd.includes('roles/'))
ok('trace 汇总了 JEV 调用数与按阶段分布', /JEV 调用总数：2/.test(traceMd) && traceMd.includes('decompose×1'))

console.log('\n产物:' + tmp)
rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
process.exit(fails === 0 ? 0 : 1)
