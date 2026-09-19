/**
 * 把一次 run 的全部产物缝成一份**人能读的**时间线。
 *
 * 为什么需要它：JSON 产物（`01-decomposition.json` / `02-chain-*.json` /
 * `jev-calls.jsonl`）各自完整，但"全程发生了什么"这个问题的答案散在四个文件里，
 * 要回答它得先写脚本。而这条链路最需要被检查的恰恰是**因果顺序**：
 * researcher 产了什么包 → 判官看到什么 → 判成什么 → 下一轮改了什么。
 *
 * 所以这份 trace 只做一件事：按时间顺序把上述环节摊平，并把
 * **判官当时看到的 state 摘要**与**它的裁决**并排放在一起 ——
 * 一眼就能看出"是断言错了还是证据没喂对"。
 */

const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 读 per-run 的 JEV 调用日志，按 phase 归拢 */
export function indexJevCalls(jevRecords) {
  const byKey = new Map()
  for (const r of jevRecords) {
    const k = `${r.phase ?? '?'}|${r.label ?? ''}|${r.round ?? ''}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(r)
  }
  return byKey
}

/**
 * @param {object} o
 * @param {string} o.runId
 * @param {string} o.question
 * @param {object} o.decomposition runDecomposition / acceptUserEdit 的产物
 * @param {object[]} o.chains 每条链的 runChain 产物
 * @param {object} o.report runReport 的产物
 * @param {object[]} o.jevRecords per-run 的 JEV 调用日志
 * @param {object} [o.config]
 */
export function renderTrace({ runId, question, decomposition, chains, report, jevRecords = [], config = {} }) {
  const L = []
  const jevByPhase = new Map()
  for (const r of jevRecords) {
    if (!jevByPhase.has(r.phase)) jevByPhase.set(r.phase, [])
    jevByPhase.get(r.phase).push(r)
  }
  const phaseCalls = (p) => jevByPhase.get(p) ?? []

  L.push(`# 全链路 trace — ${runId}`)
  L.push('')
  L.push(`- 研究题目：${question}`)
  L.push(`- 时间：${new Date().toISOString()}`)
  L.push(`- 判官模式：${config.jevMode ?? '?'}${config.acceptRate !== undefined && config.jevMode === 'fixture' ? `（acceptRate=${config.acceptRate}）` : ''}`)
  L.push(`- 轮数上限：分解 ${config.maxDecomposeRounds} / 断言 ${config.maxClaimRounds} / 报告 ${config.maxReportRounds}`)
  L.push(`- JEV 调用总数：${jevRecords.length}（按阶段：${[...jevByPhase.entries()].map(([p, v]) => `${p}×${v.length}`).join('、')}）`)
  L.push('')
  L.push('> 每次 JEV 调用喂进去的 `state` **全文**在 `jev-calls.jsonl`；')
  L.push('> 各角色每次调用的 prompt / stdout / reasoning 全文在 `roles/`。')
  L.push('')

  // ── 阶段一：分解 ──
  L.push('## 一、leader 分解')
  L.push('')
  L.push(`状态：**${decomposition?.status}**（${decomposition?.reason}），用了 ${decomposition?.rounds} 轮`)
  if (decomposition?.userEdited) L.push('> 该分解由用户亲自编辑，按规则**不再重新检查**。')
  L.push('')
  const decCalls = phaseCalls('decompose')
  for (const [i, h] of (decomposition?.history ?? []).entries()) {
    L.push(`### 第 ${h.round ?? i + 1} 轮`)
    if (h.error) { L.push(`- ⚠ ${h.error}`); L.push(''); continue }
    L.push(`- 子题目 ${h.subQuestions?.length ?? 0} 条，A 组检查通过 ${h.passedCount ?? '?'} / 失败 ${h.failedCount ?? '?'}`)
    for (const sq of h.subQuestions ?? []) {
      L.push(`  - \`${sq.id}\` ${cut(sq.text, 120)}${sq.terms?.length ? `　**terms**: ${sq.terms.join(', ')}` : ''}`)
    }
    for (const f of h.judgement?.failed ?? []) L.push(`  - ✘ ${f.label}`)
    const call = decCalls.find(c => c.round === h.round)
    if (call) L.push(`  - 判官看到：${call.stateChars} 字符的 state（state 全文见 jev-calls.jsonl seq=${call.seq}）`)
    L.push('')
  }

  // ── 阶段二：每条链 ──
  L.push('## 二、各子题链路')
  L.push('')
  for (const [ci, ch] of (chains ?? []).entries()) {
    L.push(`### 链 ${ci + 1}：${cut(ch.atom, 140)}`)
    L.push('')
    if (ch.terms?.length) L.push(`- 子题术语：${ch.terms.join('、')}`)
    // 这里原先渲染「跳转」段：起跳页解析、逐步轨迹表（含候选名单与相关度）、收集页列表。
    // 跳转器已按实测删除（详见 lib/chain.mjs 顶部注释），所以这一段一并删掉。
    // 取证现在完全由 researcher 自己用 wiki 工具完成，其调用原文在 roles/ 目录。

    // 每轮 researcher + 裁决
    L.push('')
    for (const h of ch.history ?? []) {
      L.push(`#### 第 ${h.round} 轮`)
      if (h.error) { L.push(`- ⚠ ${h.error}`); L.push(''); continue }
      L.push(`- 提交 ${h.claims?.length ?? 0} 条；送判 ${h.verifiedCount} 条；证据硬拦 ${h.hardBlockedCount} 条；冻结 ${h.frozenCount} 条`)
      for (const c of h.claims ?? []) {
        const mark = c.status === 'passed' ? '✔ 通过' : c.status === 'insufficient' ? '⛔ 证据不成立' : '✘ 判否'
        L.push(`  - [${c.id}] ${mark}　${cut(c.claim, 110)}`)
        if (c.status !== 'passed') {
          for (const r of c.reasons ?? []) L.push(`      · ${r}`)
          if (c.sources?.length) L.push(`      · 证据：${c.sources.join('；')}`)
          if (c.evidenceDiagnosis?.length) {
            L.push(`      · 逐条证据诊断：${c.evidenceDiagnosis.map(d => `${d.supports ? '✔' : '✘'}${cut(d.label, 40)}(p=${d.p})`).join(' ')}`)
          }
        }
      }
      const vc = phaseCalls('claim-verify').find(c => c.round === h.round && c.atom === ch.atom)
      if (vc) L.push(`  - 判官看到：${vc.stateChars} 字符（state 全文 seq=${vc.seq}）`)
      L.push('')
    }
    L.push(`**小结**：通过 ${ch.accepted?.length ?? 0} 条，证据悬置 ${ch.insufficient?.length ?? 0} 条`)
    L.push('')
  }

  // ── 阶段三：报告 ──
  L.push('## 三、报告')
  L.push('')
  L.push(`- 撰写者：${report?.writerPassed ? (report.rounds === 1 ? '一稿即通过校验' : `第 ${report.rounds} 稿通过校验`) : `${report?.rounds} 稿均未通过校验`}`)
  L.push(`- 代码兜底补写悬置条目：${report?.appendedByCode ? '**有**' : '无'}`)
  L.push(`- 终稿长度：${report?.stats?.chars ?? 0} 字符`)
  for (const [i, h] of (report?.history ?? []).entries()) {
    if (h.error) { L.push(`- 第 ${h.round ?? i + 1} 稿：⚠ ${h.error}`); continue }
    const codes = (h.check?.issues ?? []).map(x => x.code)
    L.push(`- 第 ${h.round ?? i + 1} 稿（${h.chars} 字符）：${h.check?.pass ? '✔ 通过' : `✘ ${codes.join('、')}`}`)
    for (const x of h.check?.issues ?? []) L.push(`    · [${x.code}] ${cut(x.detail, 160)}`)
  }
  if (!report?.writerPassed) {
    L.push('')
    L.push('> 撰写者未通过检查，最终产物由 `enforceSuspension` 保证带完整悬置节。')
  }
  L.push('')
  L.push('## 四、产物索引')
  L.push('')
  L.push('| 文件 | 内容 |')
  L.push('|---|---|')
  L.push('| `00-audit.json` | 汇总审计（分解、各链、报告、JEV 统计、事件流） |')
  L.push('| `00-events.jsonl` | 事件流（按时间，可重放） |')
  L.push('| `01-decomposition.json` | 分解每轮的子题目与 A 组判定（含原始 answers） |')
  L.push('| `02-chain-<id>.json` | 每条链完整记录：每轮断言、裁决与逐条证据诊断 |')
  L.push('| `03-brief.json` | 交给报告撰写者的材料（已确证 + 必须悬置） |')
  L.push('| `04-report.md` | 最终报告 |')
  L.push('| `04-report-check.json` | 报告每稿的后置检查结果 |')
  L.push('| `jev-calls.jsonl` | **每次 JEV 调用**：喂进去的 state 全文 + questions + 裁决 |')
  L.push('| `roles/*.prompt.txt` / `.stdout.txt` / `.reasoning.txt` | 每个角色每次调用的原文 |')
  L.push('')

  return L.join('\n')
}
