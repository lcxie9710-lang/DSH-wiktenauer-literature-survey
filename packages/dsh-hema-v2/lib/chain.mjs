/**
 * Stage 2 —— 单链研究环
 *
 * 用户定下的核心链路，只有四个动作：
 *   1. leader 把研究题目分解成方向集中的子题目（Stage 3 负责）
 *   2. researcher 搜集并产出结构化的**证据-断言包**
 *   3. JEV 作为 verifier 判断「基于目前证据，这个断言是否正确」
 *   4. 判为否 → 打回 researcher 重新整理/搜集证据并修改断言 → 再给 verifier 看
 *
 * 没有 Skeptic，没有全局反证搜索。researcher 的断言都通过 → 直接交给报告撰写者。
 *
 * 本模块刻意**不依赖 DSH**：`askResearcher` 由外部注入，可以是真 subagent
 * （用 continuable subagent + send_message 实现打回），也可以是测试里的脚本函数。
 * 这样轮数封顶、打回、证据悬置这些硬规则可以确定性验证，不用每次真跑模型。
 *
 * 硬规则都在这里（代码里），不在 prompt 里：
 *   - 断言重试上限 3 轮，超过即判 insufficient（证据悬置），绝不假装通过
 *   - 证据解引用失败 = 证据不成立，硬拦，不问 JEV
 *   - 已通过的断言冻结：重交时文本未变就不重复问 JEV（省成本 + 避免非确定性翻盘）
 */

import { normalizeClaims, assembleState, precheck, locatorLabel } from './evidence.mjs'
import { claimQuestions, judgeClaim, perEvidenceQuestions, perEvidenceState, readPerEvidence } from './jev.mjs'
import { dereference } from './wiki.mjs'

export const CHAIN_DEFAULTS = {
  maxRounds: 3,   // 断言重试上限（用户冻结值）
  maxChars: 4000,
  maxParas: 6,
  // 失败路径的 per-evidence 诊断：只在断言被判否、且挂了多个来源时才问。
  // 单来源没有"哪一条"的问题，所以没必要多花一次调用。
  perEvidenceDiagnosis: true,
  maxDiagnosisSources: 4,
  // 角色**调用**失败（进程崩溃/超时）的重试次数。这类失败不消耗 maxRounds：
  // 那是基础设施故障，不是模型交了个坏包。
  roleRetries: 2,
  retryBackoffMs: 800,
}

/** 重试之间短暂退避；纯本地等待，失败也不致命 */
const sleep = (ms) => new Promise(r => { try { setTimeout(r, ms) } catch { r() } })

/** 硬拦的 precheck 码：这些断言根本不问 JEV */
const HARD_BLOCK = new Set(['NO_EVIDENCE', 'EVIDENCE_UNRESOLVABLE'])

/**
 * 跑一条链（一个原子命题）。
 *
 * @param {object} o
 * @param {string} o.atom 原子命题
 * @param {object} o.jev JEV 客户端
 * @param {(ctx:object)=>Promise<any>} o.askResearcher 调 researcher，返回原始证据-断言包
 * @param {string[]} [o.terms] 该子题目涉及的历史术语（透传给 researcher prompt）
 * @param {object} [o.cfg] CHAIN_DEFAULTS 覆盖
 * @param {object} [o.deps] 注入 {dereference}（测试用），避免测试偷偷打真实维基
 * @param {(e:object)=>void} [o.onEvent] 审计回调
 */
export async function runChain({
  atom, jev,
  askResearcher,
  terms = [],
  cfg: cfgIn = {},
  deps = {},
  onEvent = () => {},
}) {
  const cfg = { ...CHAIN_DEFAULTS, ...cfgIn }
  const deref = deps.dereference ?? dereference
  const emit = (e) => { try { onEvent({ atom, ...e }) } catch { /* 回调失败不影响主流程 */ } }

  // ── 阶段 1：researcher 取证的轮次循环 ──
  //
  // 这里原先有一个「JEV 快速跳转收集」阶段（jumpCollect：JEV 反复判
  // "当前页是否高相关 / 该往哪个关联页跳"，直到收满 N 页或预算耗尽）。
  // **已按实测删除**，依据是一次真实 run 的 186 次跳转调用：
  //   · relevance 中位数只有 0.19，仅 4% 的页面被判高相关
  //   · next 里最高候选的概率中位数 0.385，**52% 的步数 <0.4** —— 一半以上
  //     的"往哪跳"近似随机
  //   · 186 次调用只收到 7 个页面（26.6 次调用/页），全 run 199 次调用里 93% 花在这
  // 结论：这条路在真实语料上产出太低，成本太高。取证改为完全由 researcher
  // 自己用 wiki_search / wiki_get_page 完成（实测它本来也在这么做）。
  const passed = new Map()   // id -> { claimText, verdict, sources, round }
  const history = []         // 每轮记录（审计 + 报告撰写者用）
  let feedback = null
  let verificationCalls = 0
  let round = 0

  while (round < cfg.maxRounds) {
    round++
    emit({ type: 'round_start', round, feedbackIds: feedback?.failed?.map(f => f.id) ?? [] })

    // 1) 调 researcher（第一轮给题目，之后给打回清单）
    let raw
    let callErr = null
    for (let attempt = 1; attempt <= cfg.roleRetries + 1; attempt++) {
      try {
        raw = await askResearcher({
          atom, round, attempt,
          feedback,
          hint: feedback
            ? '以下断言未通过验证。请重新整理/补充证据，并修改断言本身，使证据足以支持它。'
              + '注意：不要把断言削弱成同义反复或空话——那会被具体性检查打回。'
            : '请在 Wiktenauer 上检索取证，产出证据-断言包。证据只给定位符，不要摘录原文。',
        })
        callErr = null
        break
      } catch (e) {
        callErr = e
        // **进程崩溃不是模型失败。** 实测遇到过 dsh 子进程以 0xC0000409
        // (STATUS_STACK_BUFFER_OVERRUN) 硬崩 —— 那是基础设施故障，
        // 若直接消耗一轮，maxRounds=2 时等于白扔一半重试预算。
        // 所以调用失败重试不记轮数，只有模型真的交了坏包才记轮。
        emit({
          type: 'researcher_retry', round, attempt, maxAttempts: cfg.roleRetries + 1,
          error: String(e.message ?? e),
        })
        if (attempt <= cfg.roleRetries) await sleep(cfg.retryBackoffMs * attempt)
      }
    }
    if (callErr) {
      history.push({ round, error: `researcher 调用失败（调用重试 ${cfg.roleRetries} 次后仍失败）: ${callErr.message ?? callErr}` })
      emit({ type: 'researcher_error', round, error: String(callErr.message ?? callErr) })
      feedback = { failed: feedback?.failed ?? [], note: '上一轮 researcher 调用失败（基础设施故障，非你的问题），请重试' }
      continue
    }

    // 2) 规范化 + 形状校验

    // 2) 规范化 + 形状校验
    const { claims, errors } = normalizeClaims(raw, { atom })
    if (!claims.length) {
      history.push({ round, error: 'EMPTY_SUBMISSION', shapeErrors: errors, claims: [] })
      emit({ type: 'empty_submission', round, shapeErrors: errors })
      feedback = { failed: feedback?.failed ?? [], note: '上一轮没有收到任何有效断言，请重新提交' }
      continue
    }

    // 3) 冻结已通过的断言：文本未变就不重复问 JEV
    const toVerify = []
    const frozen = []
    for (const c of claims) {
      const p = passed.get(c.id)
      if (p && p.claimText === c.claim) frozen.push(c)
      else toVerify.push(c)
    }

    // 4) 确定性 precheck（证据定位不到就不该问 JEV）
    const { state, perClaim } = await assembleState({
      atom, claims: toVerify, maxChars: cfg.maxChars, maxParas: cfg.maxParas, deref,
    })
    const pc = precheck(toVerify, perClaim)
    const hardBlocked = new Set(pc.issues.filter(i => HARD_BLOCK.has(i.code)).map(i => i.id))
    const warnings = pc.issues.filter(i => !HARD_BLOCK.has(i.code))
    const askable = toVerify.filter(c => !hardBlocked.has(c.id))

    // 5) JEV 验证（B 组判支持 + C 组判跑题/空泛，同一次调用）
    let verdicts = new Map()
    if (askable.length) {
      verificationCalls++
      const res = await jev.ask(state, claimQuestions(askable), {
        phase: 'claim-verify', label: `verify-r${round}`, atom, round,
      })
      if (!res.ok) {
        history.push({ round, error: `JEV 调用失败: ${res.error}`, claims: [] })
        emit({ type: 'jev_error', round, error: res.error })
        feedback = { failed: feedback?.failed ?? [], note: '验证器调用失败，请重试' }
        continue
      }
      for (const c of askable) verdicts.set(c.id, judgeClaim(res.answers, c))
    }

    // 6) 汇总本轮结果
    const roundClaims = []
    const failedThisRound = []
    for (const c of toVerify) {
      const pcm = perClaim.find(p => p.id === c.id)
      const sources = pcm?.sources ?? []
      const srcLabels = sources.map(s => s.label)

      if (hardBlocked.has(c.id)) {
        const issue = pc.issues.find(i => i.id === c.id && HARD_BLOCK.has(i.code))
        const rec = {
          id: c.id, claim: c.claim, subQuestion: c.subQuestion,
          status: 'insufficient', reason: issue.code, detail: issue.detail,
          locators: c.locators.map(locatorLabel), sources: srcLabels, reasons: [issue.detail],
        }
        roundClaims.push(rec)
        failedThisRound.push(rec)
        continue
      }

      const v = verdicts.get(c.id)
      if (!v) {
        const rec = {
          id: c.id, claim: c.claim, subQuestion: c.subQuestion, status: 'insufficient',
          reason: 'NOT_VERIFIED', detail: '未被本轮的验证覆盖', locators: c.locators.map(locatorLabel),
          sources: srcLabels, reasons: ['未验证'],
        }
        roundClaims.push(rec)
        failedThisRound.push(rec)
        continue
      }

      if (v.pass) {
        passed.set(c.id, { claimText: c.claim, verdict: v, sources: srcLabels, round })
        roundClaims.push({
          id: c.id, claim: c.claim, subQuestion: c.subQuestion,
          status: 'passed',
          locators: c.locators.map(locatorLabel), sources: srcLabels,
          support: v.support, onTopic: v.onTopic, specificity: v.specificity, round,
        })
        emit({ type: 'claim_passed', round, id: c.id, claim: c.claim, supportP: v.support.p })
      } else {
        // 失败路径专用诊断：挂多个来源时，指出到底哪一条不支持
        // （只在判否时问，且只在有多个来源时问 —— 单来源没有"哪一条"的问题）
        let evidenceDiagnosis = null
        if (cfg.perEvidenceDiagnosis && sources.length >= 2) {
          try {
            const ask = sources.slice(0, cfg.maxDiagnosisSources)
            verificationCalls++
            const dres = await jev.ask(
              perEvidenceState(c, ask, atom),
              perEvidenceQuestions(c, ask),
              { phase: 'evidence-diagnosis', label: `diag-${c.id}-r${round}`, atom, round },
            )
            if (dres.ok) {
              evidenceDiagnosis = readPerEvidence(dres.answers, c.id, ask)
              emit({ type: 'evidence_diagnosis', round, id: c.id, verdicts: evidenceDiagnosis.map(d => d.supports) })
            }
          } catch { /* 诊断失败不影响打回本身 */ }
        }
        const rec = {
          id: c.id, claim: c.claim, subQuestion: c.subQuestion, status: 'rejected',
          locators: c.locators.map(locatorLabel), sources: srcLabels,
          reasons: v.reasons, support: v.support, onTopic: v.onTopic, specificity: v.specificity,
          evidenceDiagnosis, round,
        }
        roundClaims.push(rec)
        failedThisRound.push(rec)
        emit({ type: 'claim_rejected', round, id: c.id, reasons: v.reasons })
      }
    }

    for (const c of frozen) {
      const p = passed.get(c.id)
      roundClaims.push({
        id: c.id, claim: c.claim, subQuestion: c.subQuestion, status: 'passed',
        locators: c.locators.map(locatorLabel), sources: p.sources,
        support: p.verdict.support, onTopic: p.verdict.onTopic, specificity: p.verdict.specificity,
        round: p.round, frozen: true,
      })
    }

    history.push({
      round, claims: roundClaims,
      failed: failedThisRound.map(f => ({
        id: f.id, claim: f.claim, subQuestion: f.subQuestion,
        reasons: f.reasons ?? [f.detail],
        reason: f.reason ?? null,          // 硬拦码（NO_EVIDENCE 等）必须保留，不能被 ROUNDS_EXHAUSTED 覆盖
        locators: f.locators ?? [], sources: f.sources ?? [],
      })),
      shapeErrors: errors, warnings,
      verifiedCount: askable.length, hardBlockedCount: hardBlocked.size, frozenCount: frozen.length,
    })
    emit({
      type: 'round_done', round,
      passed: roundClaims.filter(c => c.status === 'passed').length,
      rejected: failedThisRound.length,
    })

    if (!failedThisRound.length) break
    feedback = {
      round,
      failed: failedThisRound.map(f => ({
        id: f.id, claim: f.claim, reasons: f.reasons ?? [f.detail],
        support: f.support ?? null, onTopic: f.onTopic ?? null, specificity: f.specificity ?? null,
        locatorsTried: f.locators ?? [],
        // 逐条证据诊断：告诉 researcher 是哪一条来源不支持，而不是让它盲改
        evidenceDiagnosis: f.evidenceDiagnosis ?? null,
      })),
      warnings,
      note: `${failedThisRound.length} 条断言未通过。请修改后重新提交**全部**断言（已通过的可以原样带回，不会被重复验证）。`,
    }
  }

  // ── 阶段 3：结算。轮数用尽仍未通过 → insufficient（证据悬置），不假装通过 ──
  const last = history[history.length - 1]
  const accepted = [...passed.entries()].map(([id, v]) => ({
    id, claim: v.claimText, status: 'passed', round: v.round,
    sources: v.sources,
    support: v.verdict.support, onTopic: v.verdict.onTopic, specificity: v.verdict.specificity,
  }))

  const stuck = new Map()
  for (const h of history) {
    for (const f of h.failed ?? []) stuck.set(f.id, { ...f, lastRound: h.round })
  }
  for (const id of passed.keys()) stuck.delete(id)

  const insufficient = [...stuck.values()].map(s => ({
    id: s.id, claim: s.claim, subQuestion: s.subQuestion ?? null,
    status: 'insufficient',
    // 硬拦的具体原因优先于笼统的"轮数用尽"，否则用户看不出到底是证据定位失败还是判官不认
    reason: s.reason ?? 'ROUNDS_EXHAUSTED',
    detail: s.reason
      ? s.reasons?.[0] ?? '证据不成立'
      : `${cfg.maxRounds} 轮内未通过验证，按「证据悬置」处理`,
    roundsAttempted: s.lastRound ?? cfg.maxRounds,
    lastReasons: s.reasons,
    locators: s.locators ?? [],
    sources: s.sources ?? [],
  }))

  const result = {
    atom,
    accepted,
    insufficient,
    complete: insufficient.length === 0 && accepted.length > 0,
    rounds: history.length,
    maxRounds: cfg.maxRounds,
    history,
    stats: {
      verifications: verificationCalls,
      rounds: history.length,
      accepted: accepted.length,
      insufficient: insufficient.length,
    },
  }
  emit({ type: 'chain_done', complete: result.complete, stats: result.stats })
  return result
}

/**
 * 多链汇总：leader 分解出的每个子题目各跑一条链，最后合并给报告撰写者。
 * Stage 3 的轮数控制（分解检查 3 轮 + 用户介入）由 leader 侧负责，
 * 这里只负责"所有链都跑完并如实汇报"。
 */
export async function runChains(chains, { jev, askResearcher, cfg = {}, onEvent = () => {} }) {
  const results = []
  for (const ch of chains) {
    results.push(await runChain({
      atom: ch.atom, terms: ch.terms ?? [],
      jev, askResearcher, cfg, onEvent,
    }))
  }
  const accepted = results.flatMap(r => r.accepted.map(a => ({ ...a, atom: r.atom })))
  const insufficient = results.flatMap(r => r.insufficient.map(a => ({ ...a, atom: r.atom })))
  return {
    chains: results,
    accepted,
    insufficient,
    complete: results.every(r => r.complete),
    stats: {
      chains: results.length, accepted: accepted.length, insufficient: insufficient.length,
      verifications: results.reduce((a, r) => a + (r.stats.verifications ?? 0), 0),
    },
  }
}
