/**
 * Stage 3 —— leader 分解 + A 组检查 + 悬置
 *
 * 用户定下的规则：
 *   - leader 把研究题目分解为**方向集中的子题目**
 *   - JEV 用 A 组问题检查这次分解（覆盖 / 独立 / 每个子题可取证 / 每个子题范围合适）
 *   - 检查不过就打回 leader 重新分解，**封顶 3 轮**
 *   - 3 轮仍不过 → **悬置，问用户**（不是自己拍板接受，也不是无限重试）
 *   - **用户编辑过的分解不再重新检查** —— 用户拍板即终局，不该被验证器二次否决
 *
 * 最后一条很重要：如果用户手工改完还要被 JEV 打回，那用户就没有最终决定权了。
 * 所以 `acceptUserEdit` 走的是"直接接受"的路径，连 JEV 都不调用（省成本，也避免
 * 用验证结果去覆盖人的决定）。
 */

import { decompositionQuestions, judgeDecomposition } from './jev.mjs'

export const DECOMPOSE_DEFAULTS = {
  maxRounds: 3,       // 分解检查封顶（用户冻结值）
  minSubQuestions: 2,
  maxSubQuestions: 8, // 超过这个数说明 leader 没有做"集中"，记形状错误
  // 角色**调用**失败（进程崩溃/超时）的重试次数，不消耗 maxRounds
  roleRetries: 2,
  retryBackoffMs: 800,
  /**
   * 哪些检查项是**硬闸门**（全部通过才算分解合格）。
   *
   * 默认只留 `focus`（逐子题的范围松紧）；`coverage`/`independent` 是**反馈信号**。
   *
   * 依据是真 JEV 实测：对「Zornhau 是什么，怎么用？」给出三条结构良好的子题目时，
   * `coverage` 只给 **p=0.59–0.63**（阈值 0.7），而明显糟糕的分解给 **p=0.51** ——
   * 既不过阈值、区分度也弱，且 JEV 是随机的（跨次运行会漂）。按"全部项通过"的
   * 合取规则，合理分解也会 3 轮耗尽 → 悬置，leader 阶段退化成悬置生成器。
   *
   * 另一次真实 run 里 `independent` 判 **0.20**（四条子题确有重叠）——
   * 若它是硬闸门，那次 run 会在分解阶段就被否决、根本跑不起来，
   * 而那份分解其实是可用的。这两次数据都指向同一个结论：整体性判断不适合当闸门。
   *
   * `answerable_*` **已删除**（不是降级）：真实 run 里四个子题（含明显的后世社会史问题）
   * 全部拿到 p=0.95–1.00，而同一批子题目的实际证据可得性中位数只有 0.19 ——
   * 它对"能不能取到证"没有预测力，却占着硬闸门的位置。
   *
   * 要改回全闸门：hardKeys: ['coverage', 'independent', 'focus']。
   */
  hardKeys: ['focus'],
}

/** 判断某个检查项 key 是否属于硬闸门（前缀匹配） */
export function isHardGate(key, cfg) {
  return (cfg.hardKeys ?? []).some(k => key === k || key.startsWith(`${k}_`))
}

const sleep = (ms) => new Promise(r => { try { setTimeout(r, ms) } catch { r() } })

/** 子题目的形状校验（纯结构，不涉及语义） */
export function validateSubQuestions(raw, cfg) {
  const list = Array.isArray(raw) ? raw : (raw?.subQuestions ?? [])
  const issues = []
  const seen = new Set()
  const subQuestions = []
  list.forEach((s, i) => {
    const id = String(s?.id ?? `sq${i + 1}`).trim()
    const text = String(s?.text ?? s?.question ?? '').trim()
    if (!text) { issues.push({ code: 'EMPTY_SUBQUESTION', index: i }); return }
    if (seen.has(id)) { issues.push({ code: 'DUPLICATE_ID', id }); return }
    seen.add(id)
    subQuestions.push({ id, text, terms: s?.terms ?? null })
  })
  if (subQuestions.length < cfg.minSubQuestions) {
    issues.push({ code: 'TOO_FEW_SUBQUESTIONS', got: subQuestions.length, min: cfg.minSubQuestions })
  }
  if (subQuestions.length > cfg.maxSubQuestions) {
    issues.push({ code: 'TOO_MANY_SUBQUESTIONS', got: subQuestions.length, max: cfg.maxSubQuestions })
  }
  return { subQuestions, issues }
}

/** A 组检查用的 state：原问题 + 子题目清单（正文明说"子题目"而不是"答案"） */
export function buildDecompositionState(question, subQuestions) {
  return [
    `【原问题】${question}`,
    '【子题目】',
    ...subQuestions.map(s => `- ${s.id}: ${s.text}`),
  ].join('\n')
}

/**
 * 跑一次分解控制环。
 *
 * @param {object} o
 * @param {string} o.question 用户的研究题目
 * @param {object} o.jev JEV 客户端
 * @param {(ctx:object)=>Promise<any>} o.askLeader 调 leader，返回 {subQuestions:[{id,text}]}
 * @param {object} [o.cfg] DECOMPOSE_DEFAULTS 覆盖
 * @param {(e:object)=>void} [o.onEvent]
 * @returns {Promise<{status:'accepted'|'needs_human', subQuestions, judgement, rounds, history}>}
 */
export async function runDecomposition({ question, jev, askLeader, cfg: cfgIn = {}, onEvent = () => {} }) {
  const cfg = { ...DECOMPOSE_DEFAULTS, ...cfgIn }
  const emit = (e) => { try { onEvent({ question, ...e }) } catch { /* 忽略回调错误 */ } }

  const history = []
  let feedback = null
  let last = null
  let round = 0

  while (round < cfg.maxRounds) {
    round++
    emit({ type: 'decompose_round_start', round })

    let raw
    let callErr = null
    for (let attempt = 1; attempt <= cfg.roleRetries + 1; attempt++) {
      try {
        raw = await askLeader({
          question, round, attempt, feedback,
          hint: feedback
            ? '以上子题目未通过结构检查。请重新分解：让子题目合起来覆盖原问题的主要方面、彼此尽量不重叠，'
              + '并且每个子题目都要能用 Wiktenauer 上的历史文献取证回答，范围不要过宽也不要过窄。'
            : '请把研究题目分解为方向集中的子题目。每个子题目应当可以用 Wiktenauer 上的历史文献取证回答。',
        })
        callErr = null
        break
      } catch (e) {
        callErr = e
        // 与 chain.mjs 同理：进程崩溃是基础设施故障，不该消耗分解检查的重试轮数
        emit({ type: 'leader_retry', round, attempt, maxAttempts: cfg.roleRetries + 1, error: String(e.message ?? e) })
        if (attempt <= cfg.roleRetries) await sleep(cfg.retryBackoffMs * attempt)
      }
    }
    if (callErr) {
      history.push({ round, error: `leader 调用失败（调用重试 ${cfg.roleRetries} 次后仍失败）: ${callErr.message ?? callErr}` })
      emit({ type: 'leader_error', round, error: String(callErr.message ?? callErr) })
      feedback = { failed: feedback?.failed ?? [], note: '上一轮 leader 调用失败（基础设施故障），请重试' }
      continue
    }

    const { subQuestions, issues } = validateSubQuestions(raw, cfg)
    // 形状就不过关的话，不必花 JEV 调用去问语义
    if (issues.some(i => ['TOO_FEW_SUBQUESTIONS', 'EMPTY_SUBQUESTION', 'DUPLICATE_ID'].includes(i.code))) {
      history.push({ round, error: 'SHAPE_INVALID', shapeIssues: issues, subQuestions })
      emit({ type: 'decompose_shape_invalid', round, shapeIssues: issues })
      feedback = { failed: [], shapeIssues: issues, note: '子题目结构不合法，请按格式重新提交' }
      last = { subQuestions, judgement: null, shapeIssues: issues }
      continue
    }

    const state = buildDecompositionState(question, subQuestions)
    const res = await jev.ask(state, decompositionQuestions(subQuestions), {
      phase: 'decompose', label: `decompose-r${round}`, atom: question, round,
    })
    if (!res.ok) {
      history.push({ round, error: `JEV 调用失败: ${res.error}`, subQuestions })
      emit({ type: 'jev_error', round, error: res.error })
      feedback = { failed: feedback?.failed ?? [], note: '验证器调用失败，请重试' }
      last = { subQuestions, judgement: null }
      continue
    }

    const judgement = judgeDecomposition(res.answers, subQuestions)
    // 按 hardKeys 把判定分成「硬闸门」与「反馈信号」：
    // 信号项仍会写进给 leader 的打回说明，但不单独否决整次分解。
    const gated = judgement.items.filter(i => isHardGate(i.key, cfg))
    const advisory = judgement.items.filter(i => !isHardGate(i.key, cfg))
    const gatedFailed = gated.filter(i => !i.pass)
    judgement.gatedFailed = gatedFailed
    judgement.advisoryFailed = advisory.filter(i => !i.pass)
    judgement.passAll = judgement.pass
    judgement.pass = gatedFailed.length === 0
    last = { subQuestions, judgement, shapeIssues: issues }
    history.push({
      round, subQuestions, judgement, shapeIssues: issues,
      answers: res.answers,
      passedCount: judgement.items.length - judgement.failedCount,
      failedCount: judgement.failedCount,
      gatedFailedCount: gatedFailed.length,
      advisoryFailedCount: judgement.advisoryFailed.length,
    })
    emit({
      type: 'decompose_round_done', round,
      pass: judgement.pass, passAll: judgement.passAll,
      failedCount: judgement.failedCount,
      gatedFailedKeys: gatedFailed.map(f => f.key),
      advisoryFailedKeys: judgement.advisoryFailed.map(f => f.key),
    })

    if (judgement.pass) {
      emit({ type: 'decompose_accepted', round, count: subQuestions.length })
      return {
        status: 'accepted', reason: 'JEV_CHECK_PASSED',
        subQuestions, judgement, rounds: history.length, history,
      }
    }

    feedback = {
      round,
      // 两类都反馈给 leader（信号项也有改进价值），但只有硬闸门决定去向
      failed: [...gatedFailed, ...judgement.advisoryFailed].map(f => ({
        key: f.key, label: f.label, detail: describeFailure(f),
        gate: isHardGate(f.key, cfg) ? 'hard' : 'advisory',
      })),
      shapeIssues: issues.filter(i => i.code === 'TOO_MANY_SUBQUESTIONS'),
      note: `${gatedFailed.length} 项硬性检查未通过。请针对这些方向重新分解。`,
    }
  }

  // 3 轮用尽：**悬置**，把最后版本连同失败详情交给用户拍板
  emit({ type: 'decompose_needs_human', rounds: history.length })
  return {
    status: 'needs_human',
    reason: 'ROUNDS_EXHAUSTED',
    subQuestions: last?.subQuestions ?? [],
    judgement: last?.judgement ?? null,
    shapeIssues: last?.shapeIssues ?? [],
    rounds: history.length,
    history,
    question,
    hint: last?.judgement?.gatedFailed?.length
      ? `卡住的硬性检查：${last.judgement.gatedFailed.map(f => f.label).join('；')}`
      : null,
  }
}

/** 把一项失败的判定翻译成人能读的话（给 leader 打回用，也给用户看） */
export function describeFailure(item) {
  switch (item.key) {
    case 'coverage': return `子题目合起来没有覆盖原问题的主要方面（p=${item.p}）`
    case 'independent': return `子题目之间存在明显重叠（p=${item.p}）`
    default:
      if (item.key.startsWith('focus_')) return `该子题目范围不合适（可接受范围质量=${item.mass}）`
      return '未通过'
  }
}

/**
 * 用户拍板：**不再重新检查**。
 * 用户编辑过的分解直接进入执行阶段 —— 人改完了还要被验证器否决，人就没有决定权了。
 */
export function acceptUserEdit(question, subQuestions, { note = null } = {}) {
  const cfg = DECOMPOSE_DEFAULTS
  const { subQuestions: clean, issues } = validateSubQuestions(subQuestions, cfg)
  return {
    status: 'accepted',
    reason: 'USER_EDITED',
    subQuestions: clean,
    judgement: null,          // 故意为 null：表示这次没有经过验证器
    userEdited: true,
    userNote: note,
    shapeIssues: issues,      // 形状问题仍然如实记录，但不阻断
    rounds: 0,
    history: [{ userEdited: true, subQuestions: clean, judgement: null, shapeIssues: issues }],
  }
}

/** 把接受的分解转成链的定义（每子题一条链） */
export function toChains(question, subQuestions) {
  return subQuestions.map(s => ({
    id: s.id,
    atom: s.text,
    question,
    // leader 给出的历史术语：起跳页解析优先用它，比从命题里正则抠拉丁词可靠得多
    terms: Array.isArray(s.terms) ? s.terms.filter(Boolean) : [],
  }))
}
