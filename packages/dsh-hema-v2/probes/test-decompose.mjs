/**
 * 探针 Stage 3 —— 分解控制环的硬规则
 *
 * 验：A 组检查真的挡住了不合格分解、3 轮封顶后**悬置问用户**而不是自己拍板、
 * 用户编辑过的分解**不被重新检查**、形状校验先于 JEV 调用（省成本）、
 * leader 失败/乱交不中断循环。
 */
import { runDecomposition, acceptUserEdit, validateSubQuestions, toChains, DECOMPOSE_DEFAULTS } from '../lib/decompose.mjs'
import { createJev } from '../lib/jev.mjs'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}
const head = (s) => console.log(`\n── ${s} ──`)

const Q = 'Zornhau 是什么，在 Liechtenauer 体系中怎么用？'
const GOOD_SQ = [
  { id: 'sq1', text: 'Zornhau 的起手动作与打击线路是什么？' },
  { id: 'sq2', text: 'Zornhau 在 Liechtenauer 体系中的战术地位是什么？' },
]

/** 判官：按脚本对每个 qid 给答案，可指定哪些 key 失败 */
function scriptedJev(failKeys = [], { ok: isOk = true } = {}) {
  let calls = 0
  return {
    calls: () => calls,
    async ask(state, questions) {
      calls++
      if (!isOk) return { ok: false, error: 'HTTP 500' }
      const answers = {}
      for (const id of Object.keys(questions)) {
        const shouldFail = failKeys.some(k => id === k || id.startsWith(k))
        if (id === 'coverage' || id === 'independent') {
          answers[id] = { type: 'boolean', probability: shouldFail ? 0.1 : 0.95 }
        } else if (id.startsWith('focus_')) {
          const idx = shouldFail ? 0 : 2
          const probabilities = {}
          for (let i = 0; i < 5; i++) probabilities[String(i)] = i === idx ? 0.85 : 0.0375
          answers[id] = { type: 'score', score: idx, probabilities }
        }
      }
      return { ok: true, answers }
    },
    stats: () => ({ mode: 'scripted' }),
  }
}

// ══════════════════════════════════════════════════════════════
head('1) 一次通过')
let c1 = 0
const r1 = await runDecomposition({
  question: Q, jev: scriptedJev([]),
  askLeader: async () => { c1++; return { subQuestions: GOOD_SQ } },
})
ok('status=accepted', r1.status === 'accepted' && r1.reason === 'JEV_CHECK_PASSED', r1.status)
ok('只调了 1 次 leader', c1 === 1, `calls=${c1}`)
ok('只跑了 1 轮', r1.rounds === 1)
ok('带回子题目', r1.subQuestions.length === 2, JSON.stringify(r1.subQuestions.map(s => s.id)))
// A 组现在是 coverage + independent + 每子题一个 focus（answerable 已删）
ok('judgement 记录了检查项', r1.judgement.items.length === 2 + 2, `items=${r1.judgement.items.length}`)
ok('非用户编辑路径不标 userEdited', !r1.userEdited)

// ══════════════════════════════════════════════════════════════
head('2) 检查不过 → 打回 leader，第 2 轮改好')
let c2 = 0
const seenCtx = []
const r2 = await runDecomposition({
  question: Q,
  jev: scriptedJev(['focus']),   // 只让硬闸门 focus 失败（coverage 现在是提示项，逼不出打回）
  askLeader: async (ctx) => {
    c2++
    seenCtx.push(ctx)
    return { subQuestions: GOOD_SQ }
  },
})
ok('第 1 轮没有 feedback', seenCtx[0].feedback === null)
ok('r2 因硬闸门 focus 一直失败而悬置（脚本判官恒定）', r2.status === 'needs_human', r2.status)
ok('来了 3 次 leader 调用（封顶）', c2 === 3, `calls=${c2}`)
ok('第 2 轮收到打回清单（两个 focus 硬闸门都失败）',
  seenCtx[1].feedback?.failed?.length === 2, JSON.stringify(seenCtx[1].feedback?.failed?.map(f => f.key)))
ok('打回项都标为硬闸门', seenCtx[1].feedback?.failed?.every(f => f.gate === 'hard'),
  JSON.stringify(seenCtx[1].feedback?.failed?.map(f => f.gate)))
ok('打回项是可读的', /范围/.test(seenCtx[1].feedback?.failed?.[0]?.detail ?? ''), seenCtx[1].feedback?.failed?.[0]?.detail)
ok('hint 提醒了取证可行性', /取证/.test(seenCtx[1].hint ?? ''))

// ══════════════════════════════════════════════════════════════
head('3) 3 轮封顶 → 悬置问用户（不自作主张接受）')
const r3 = await runDecomposition({
  question: Q, jev: scriptedJev(['focus']),
  askLeader: async () => ({ subQuestions: GOOD_SQ }),
})
ok('status=needs_human', r3.status === 'needs_human')
ok('原因是 ROUNDS_EXHAUSTED', r3.reason === 'ROUNDS_EXHAUSTED', r3.reason)
ok('恰好 3 轮', r3.rounds === DECOMPOSE_DEFAULTS.maxRounds, `rounds=${r3.rounds}`)
ok('悬置时带回最后版本供用户编辑', r3.subQuestions.length === 2)
ok('悬置时带回失败详情供用户判断', (r3.judgement?.failed?.length ?? 0) > 0, JSON.stringify(r3.judgement?.failed?.map(f => f.key)))
ok('悬置时不冒充 accepted', r3.status !== 'accepted')

// ══════════════════════════════════════════════════════════════
head('4) 用户编辑的分解不被重新检查')
const userSq = [
  { id: 'u1', text: '用户手写的子题目一：Zornhau 的力学原理。' },
  { id: 'u2', text: '用户手写的子题目二：Zornhau 与其他斩击的关系。' },
]
const edited = acceptUserEdit(Q, userSq, { note: '用户认为方向应该这样切' })
ok('status=accepted', edited.status === 'accepted')
ok('原因是 USER_EDITED', edited.reason === 'USER_EDITED', edited.reason)
ok('userEdited=true', edited.userEdited === true)
ok('judgement=null（没走验证器）', edited.judgement === null)
ok('轮数=0（没有重试）', edited.rounds === 0)
ok('保留用户的子题目原文', edited.subQuestions.map(s => s.text).join('|') === userSq.map(s => s.text).join('|'))
ok('记录用户备注', edited.userNote === '用户认为方向应该这样切')

// 证明它真的没走验证器：acceptUserEdit 是同步纯函数
const edited2 = acceptUserEdit(Q, userSq)
ok('acceptUserEdit 完全不碰 JEV（同步纯函数，不返回 Promise）',
  edited2.status === 'accepted' && typeof edited2.then !== 'function')

// 用户编辑即使形状不完美也接受（但如实记录问题）
const messy = acceptUserEdit(Q, [{ id: 'x', text: '只有一条' }])
ok('用户编辑不被形状校验阻断', messy.status === 'accepted')
ok('但形状问题被如实记录', messy.shapeIssues.some(i => i.code === 'TOO_FEW_SUBQUESTIONS'), JSON.stringify(messy.shapeIssues.map(i => i.code)))

// ══════════════════════════════════════════════════════════════
head('5) 形状校验先于 JEV 调用（省成本）')
let jevCalls5 = 0
const countingJev = scriptedJev([])
const wrapped5 = { ask: async (s, q) => { jevCalls5++; return countingJev.ask(s, q) }, stats: () => ({}) }
const r5 = await runDecomposition({
  question: Q, jev: wrapped5,
  askLeader: async () => ({ subQuestions: [{ id: 'a', text: '只有一个' }] }),  // 数量不足
})
ok('形状不合法时一次 JEV 都不调', jevCalls5 === 0, `jevCalls=${jevCalls5}`)
ok('形状不合法 → 悬置', r5.status === 'needs_human', r5.status)
ok('形状错误被记录', r5.history[0].error === 'SHAPE_INVALID', r5.history[0].error)
ok('形状错误码正确', r5.history[0].shapeIssues.some(i => i.code === 'TOO_FEW_SUBQUESTIONS'))

head('5b) 重复 id / 空文本被挡')
const v = validateSubQuestions([{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }, { id: 'b', text: '  ' }], DECOMPOSE_DEFAULTS)
ok('重复 id 被挡', v.issues.some(i => i.code === 'DUPLICATE_ID'))
ok('空文本被挡', v.issues.some(i => i.code === 'EMPTY_SUBQUESTION'))
ok('只留下合法的一条', v.subQuestions.length === 1, `got=${v.subQuestions.length}`)
const v2 = validateSubQuestions(Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, text: `t${i}` })), DECOMPOSE_DEFAULTS)
ok('子题目过多被记录（leader 没做集中）', v2.issues.some(i => i.code === 'TOO_MANY_SUBQUESTIONS'))

// ══════════════════════════════════════════════════════════════
head('6) 容错：leader 抛异常 / 交空')
// roleRetries:0 —— 这里要测的是"抛出异常会消耗一轮"这条旧语义；
// 崩溃在轮内重试的新语义由 6a 单独测，两者不要混在一个用例里。
let c6 = 0
const r6 = await runDecomposition({
  question: Q, jev: scriptedJev([]),
  cfg: { roleRetries: 0 },
  askLeader: async (ctx) => {
    c6++
    if (ctx.round === 1) throw new Error('模拟 leader 超时')
    if (ctx.round === 2) return { subQuestions: [] }
    return { subQuestions: GOOD_SQ }
  },
})
ok('异常与空提交不中断，第 3 轮成功', c6 === 3 && r6.status === 'accepted', `calls=${c6} status=${r6.status}`)
ok('异常轮被记录', r6.history[0].error?.includes('模拟 leader 超时'), r6.history[0].error)
ok('空提交轮被记为 SHAPE_INVALID', r6.history[1].error === 'SHAPE_INVALID', r6.history[1].error)

head('6a) leader 崩溃在轮内重试，**不消耗**重试轮数')
// 进程崩溃（如 0xC0000409）是基础设施故障，不是模型交了个坏分解
let c6a = 0
const r6a = await runDecomposition({
  question: Q, jev: scriptedJev([]),
  cfg: { roleRetries: 2, retryBackoffMs: 1 },
  askLeader: async () => {
    c6a++
    if (c6a <= 2) throw new Error('模拟 0xC0000409 进程崩溃')
    return { subQuestions: GOOD_SQ }
  },
})
ok('崩溃后轮内重试并成功', r6a.status === 'accepted', r6a.status)
ok('只用了 1 轮（崩溃没消耗预算）', r6a.rounds === 1, `rounds=${r6a.rounds}`)
ok('共调用 3 次（2 崩 + 1 成）', c6a === 3, `calls=${c6a}`)

head('6a2) leader 重试耗尽才消耗一轮')
let c6a2 = 0
const r6a2 = await runDecomposition({
  question: Q, jev: scriptedJev([]),
  cfg: { roleRetries: 1, retryBackoffMs: 1, maxRounds: 2 },
  askLeader: async () => { c6a2++; throw new Error('一直崩') },
})
ok('每轮 1+roleRetries=2 次调用', c6a2 === 4, `calls=${c6a2}`)
ok('重试耗尽后如实报失败', r6a2.history.every(h => /调用失败（调用重试/.test(h.error ?? '')), JSON.stringify(r6a2.history.map(h => h.error)))
ok('全失败时悬置，不冒充通过', r6a2.status === 'needs_human' && r6a2.judgement === null, r6a2.status)

head('6b) JEV 挂掉时不当作通过')
const r6b = await runDecomposition({
  question: Q, jev: scriptedJev([], { ok: false }),
  askLeader: async () => ({ subQuestions: GOOD_SQ }),
})
ok('JEV 全挂 → 悬置（绝不默认通过）', r6b.status === 'needs_human' && r6b.judgement === null, r6b.status)
ok('JEV 错误被记录', r6b.history.every(h => /JEV 调用失败/.test(h.error ?? '')), JSON.stringify(r6b.history.map(h => h.error)))

// ══════════════════════════════════════════════════════════════
head('7) 分解结果能转成链定义')
const chains = toChains(Q, r1.subQuestions)
ok('每个子题目一条链', chains.length === r1.subQuestions.length)
ok('链带 atom 与原问题', chains.every(c => c.atom && c.question === Q))
ok('链 id 沿用子题目 id', chains.map(c => c.id).join(',') === 'sq1,sq2')

// ══════════════════════════════════════════════════════════════
head('8) stub 判官下也能走通（真实集成冒烟）')
const r8 = await runDecomposition({
  question: Q, jev: createJev({ mode: 'stub' }),
  askLeader: async () => ({ subQuestions: GOOD_SQ }),
})
ok('stub 判官下分解被接受', r8.status === 'accepted', `${r8.status} failed=${JSON.stringify(r8.judgement?.failed?.map(f => f.key))}`)
ok('stub 判官下 1 轮通过', r8.rounds === 1)

console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
process.exit(fails === 0 ? 0 : 1)
