/**
 * Stage 4 —— 报告撰写者 + 确定性的「证据悬置」强制
 *
 * 用户定下的规则：researcher 的断言都通过 → 直接让最后一个报告撰写者
 * 根据通过的证据-断言总结研究报告。（没有 Synthesizer，没有全局反证搜索。）
 *
 * 但这里有个必须用**代码**兜住的漏洞：报告撰写者可能
 *   (a) 完全忘掉那些没通过验证的断言，把报告写得像什么都证实了
 *   (b) 把悬置的证据当成已确证的结论写进正文
 *   (c) 干脆漏掉某条已通过的断言
 * 这些不能靠 prompt 里写一句"请记得写证据悬置节"来保证 —— 模型会漏。
 *
 * 所以硬规则是：
 *   1. 先让撰写者写，然后跑确定性后置检查（不依赖模型，绕不过去）
 *   2. 后置检查不过就打回重写，封顶 3 轮
 *   3. 3 轮仍不过 → **由代码自己追加一节机器生成的「证据悬置」**，
 *      保证最终产物里一定有"哪些没被确证"。模型可以不配合，代码必须兜底。
 */

import { tokenize } from './wiki.mjs'
import { normalizeTerms } from './glossary.mjs'

export const REPORT_DEFAULTS = {
  maxRounds: 3,
  minChars: 200,
  /** 断言在报告里被视作"被提到"所需的最小词覆盖比例 */
  mentionThreshold: 0.34,
  // 角色**调用**失败（进程崩溃/超时）的重试次数，不消耗 maxRounds
  roleRetries: 2,
  retryBackoffMs: 800,
}

const sleep = (ms) => new Promise(r => { try { setTimeout(r, ms) } catch { r() } })

/** 悬置节的标题候选（撰写者用哪个都认） */
export const SUSPENSION_HEADING_RE = /(证据悬置|悬置证据|证据不足|未能确证|未确证|存疑未决|未能证成|证据未及)/

/** 机器生成的悬置节标题 */
export const SUSPENSION_HEADING = '证据悬置（未能确证的部分）'

/** 交给撰写者的材料：只有通过的断言 + 必须悬置的清单 */
export function buildReportBrief({ question, decomposition = null, chains = [], accepted = [], insufficient = [] }) {
  return {
    question,
    subQuestions: decomposition?.subQuestions ?? [],
    userEditedDecomposition: Boolean(decomposition?.userEdited),
    accepted: accepted.map(a => ({
      atom: a.atom ?? null, id: a.id, claim: a.claim, sources: a.sources ?? [],
      supportP: a.support?.p ?? null, specificity: a.specificity?.scoreLabel ?? null,
    })),
    insufficient: insufficient.map(i => ({
      atom: i.atom ?? null, id: i.id, claim: i.claim, reason: i.reason ?? null,
      detail: i.detail ?? null,
      lastReasons: i.lastReasons ?? [],
      evidenceTried: i.sources ?? i.locators ?? [],
      locators: i.locators ?? [],
      roundsAttempted: i.roundsAttempted ?? null,
    })),
    stats: {
      acceptedCount: accepted.length,
      insufficientCount: insufficient.length,
      chains: chains.length || null,
    },
  }
}

/** 把材料渲染成撰写者读的 prompt 正文（确定性，便于审计与重放） */
export function renderBrief(brief) {
  const lines = [`【研究题目】${brief.question}`]
  if (brief.subQuestions.length) {
    lines.push('【子题目】')
    for (const s of brief.subQuestions) lines.push(`- ${s.id}: ${s.text}`)
    if (brief.userEditedDecomposition) lines.push('（注：以上子题目由用户亲自编辑确定）')
  }
  lines.push('', `【已通过验证的断言】共 ${brief.accepted.length} 条`)
  if (!brief.accepted.length) lines.push('（无）')
  for (const a of brief.accepted) {
    lines.push(`- [${a.atom ?? '?'} / ${a.id}] ${a.claim}`)
    if (a.sources.length) lines.push(`  证据来源：${a.sources.join('；')}`)
  }
  lines.push('', `【未通过验证的断言】共 ${brief.insufficient.length} 条 —— 这些**必须**写进「${SUSPENSION_HEADING}」一节，不得作为结论陈述`)
  if (!brief.insufficient.length) lines.push('（无）')
  for (const i of brief.insufficient) {
    lines.push(`- [${i.atom ?? '?'} / ${i.id}] ${i.claim}`)
    if (i.lastReasons?.length) lines.push(`  未通过原因：${i.lastReasons.join('；')}`)
  }
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────
// 确定性后置检查
// ─────────────────────────────────────────────────────────────

/**
 * 按标题把 markdown 切成节，**层级感知**。
 *
 * 这一步必须是层级感知的，否则整层检查都会错。实测踩到的坑：
 * 一份报告写的是
 *   ## 二、证据悬置（未能确证的部分）
 *   ### sq1：...
 *   ### sq2：...
 * 而"在任意标题级别切分"的朴素实现会让 `## 二` 的正文**停在第 13 行**
 * （第一个 `###` 处），于是：
 *   · 悬置节文本只剩引言段 → 26 条逐条列出的断言被判"没点到"
 *   · 那 26 条落进 `###` 子节后又被当成**正文** → 里面的来源名触发"泄漏"误报
 * 报告完全合规，却被判两项不合格。所以：
 *   · 一个节的 text **包含其所有后代标题下的内容**（直到下一个同级或更高级标题）
 *   · 同时保留子节本身，供调用方判断某节是否落在悬置节范围内
 */
export function splitSections(md) {
  const lines = String(md ?? '').split(/\r?\n/)
  const H = /^\s{0,3}(#{1,6})\s+(.*)$/
  const heads = []
  for (let i = 0; i < lines.length; i++) {
    const m = H.exec(lines[i])
    if (m) heads.push({ lineIdx: i, level: m[1].length, heading: m[2].trim() })
  }

  if (!heads.length) {
    const text = lines.join('\n')
    return text.trim() ? [{ level: 0, heading: null, start: 0, end: lines.length, text }] : []
  }

  const out = []
  if (heads[0].lineIdx > 0) {
    const text = lines.slice(0, heads[0].lineIdx).join('\n')
    if (text.trim()) out.push({ level: 0, heading: null, start: 0, end: heads[0].lineIdx, text })
  }
  for (let h = 0; h < heads.length; h++) {
    const cur = heads[h]
    let end = lines.length
    for (let k = h + 1; k < heads.length; k++) {
      if (heads[k].level <= cur.level) { end = heads[k].lineIdx; break } // 同级或更高级 = 本节结束
    }
    out.push({
      level: cur.level, heading: cur.heading, start: cur.lineIdx, end,
      text: lines.slice(cur.lineIdx + 1, end).join('\n'),
    })
  }
  return out
}

/**
 * 把文档划分成「悬置节（含后代）」与「正文」。
 *
 * `bodyText` 必须**按行取差集**（整篇去掉悬置节的行区间），不能靠"挑出不与
 * 悬置节重叠的节再拼接"。原因是高层节的 span 会覆盖整篇：只要有 `# 标题`，
 * 它自己的 `[0, N)` 就和悬置节重叠而被整节排除，于是正则正文**变成空字符串**，
 * 泄漏检查就永远不可能触发 —— 一个静默失效的护栏。
 * 按行取差集对任意标题嵌套都成立。
 */
export function partitionBySuspension(md) {
  const text = String(md ?? '')
  const lines = text.split(/\r?\n/)
  const sections = splitSections(text)
  const roots = sections.filter(s => s.heading && SUSPENSION_HEADING_RE.test(s.heading))
  const spans = roots.map(r => [r.start, r.end])
  const inSpan = (i) => spans.some(([a, b]) => i >= a && i < b)
  return {
    sections,
    roots,
    suspensionText: roots.map(r => r.text).join('\n'),
    bodyText: lines.filter((_, i) => !inSpan(i)).join('\n'),
  }
}

/**
 * 取一个条目的证据来源列表。
 * 必须同时认三个字段名：buildReportBrief 产出的是 `evidenceTried`，
 * 而 runChain 产出的是 `sources` / `locators`。
 * 早先只读 `sources` 导致悬置项的来源整个读空 —— 泄漏检测静默失效，
 * 等于护栏形同虚设。这条统一入口就是修那个 bug。
 */
export const sourcesOf = (x) => x?.evidenceTried ?? x?.sources ?? x?.locators ?? []

/** 从来源标记里取页面名：'Page#Anchor @revid' / 'Page (整页) @revid' → 'Page' */
export function pageOf(s) {
  let t = String(s).split('#')[0].split(' @')[0]
  t = t.replace(/\s*\(整页\)\s*$/, '')
  return t.trim()
}

/** 从来源标记里取锚点名（无锚点返回 null） */
export function anchorOf(s) {
  const parts = String(s).split('#')
  if (parts.length < 2) return null
  return parts[1].split(' @')[0].trim() || null
}

/**
 * 锚点的显著词：长度 ≥5 的词。
 * 锚点名很独特（Nachreisen / Joachim_Meÿer's_Treatise），
 * 用词级而不是整串匹配，是为了抓住"正文只说 Meÿer 章节"这种变体写法。
 */
export function anchorTokens(anchor) {
  let a = String(anchor)
  try { a = decodeURIComponent(a) } catch { /* 非法转义就按原样用 */ }
  a = a.replace(/_/g, ' ')
  return [...new Set(a.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 5))]
}

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g
const escapeRe = (s) => String(s).replace(RE_ESCAPE, '\\$&')

/**
 * 正文里是否**以无歧义的引用标记**使用了某个悬置来源。命中返回描述，否则 null。
 *
 * 只认两种形态：
 *   1. 完整定位符 `Page#Anchor`（程序生成的形式，正常叙述不会偶然写出）
 *   2. 带版本号的 `Page @12345`
 *
 * 为什么收得这么紧 —— 两次实测教训：
 *   · 先是"见名字就算"：悬置来源多是整页定位符，页面名就是传本名或大师名
 *     （Jobst von Württemberg / Joachim Meyer）。一份 HEMA 报告正文里这类名字
 *     本来就会反复出现（子题目自己就写着「Ringeck、Peter von Danzig 等注释」），
 *     于是撰写者 3 稿全栽在这一条，护栏退化成"兜底永远触发"。
 *   · 改成"引用句式"后仍误报：锚点 `Joachim_Meÿer's_Treatise` 的显著词里含
 *     **泛用英文词 `treatise`**，而正文里出现「Treatise 章节」是完全正常的。
 *
 * 结论：人名、传本名、泛用词都不能当泄漏信号。只有程序生成的引用标记才无歧义。
 *
 * **诚实说明**：这是词面代理，它抓"把定位符原样抄进正文"，
 * 抓不到"把悬置内容改写成断言融进正文"—— 那种只能靠人判，
 * 不要假装代码能拦。真正兜住诚实性的是悬置节的强制完整性，不是这一条。
 */
export function findCitation(bodyText, { page, anchor = null }) {
  const body = String(bodyText)
  const p = escapeRe(page)
  if (anchor) {
    const full = new RegExp(`${p}\\s*#\\s*${escapeRe(anchor)}`, 'i')
    if (full.test(body)) return `完整定位符 ${page}#${anchor}`
  }
  const withRev = new RegExp(`${p}\\s*(?:#\\s*\\S+)?\\s*@\\s*\\d+`, 'i')
  if (withRev.test(body)) return `带版本号的定位符 ${page} @revid`
  return null
}

/** 断言是否在给定文本里"被提到"：归一化后的词覆盖率 */
export function isMentioned(claimText, haystack, threshold) {
  const words = [...new Set(tokenize(normalizeTerms(claimText)))]
  if (!words.length) return false
  const low = normalizeTerms(String(haystack ?? '')).toLowerCase()
  const hit = words.filter(w => low.includes(w)).length
  return hit / words.length >= threshold
}

/**
 * 后置检查。全部是字符串/词面操作，没有模型参与，所以绕不过去。
 * @returns {{pass:boolean, issues:Array<{code:string, detail:string}>}}
 */
export function postcheck(report, { accepted = [], insufficient = [] }, cfg = REPORT_DEFAULTS) {
  const issues = []
  const text = String(report ?? '')

  if (!text.trim()) {
    issues.push({ code: 'EMPTY_REPORT', detail: '报告为空' })
    return { pass: false, issues }
  }
  if (text.trim().length < cfg.minChars) {
    issues.push({ code: 'TOO_SHORT', detail: `报告长度 ${text.trim().length} < ${cfg.minChars}` })
  }

  const { roots: suspSections, suspensionText: suspText, bodyText } = partitionBySuspension(text)

  // 1) 有悬置项就必须有悬置节
  if (insufficient.length && !suspSections.length) {
    issues.push({
      code: 'MISSING_SUSPENSION_SECTION',
      detail: `有 ${insufficient.length} 条未通过验证的断言，但报告没有「证据悬置」类章节`,
    })
  }

  // 2) 悬置节必须逐条点到，不能写个空标题糊过去
  if (insufficient.length && suspSections.length) {
    const missing = insufficient.filter(i => !isMentioned(i.claim, suspText, cfg.mentionThreshold))
    if (missing.length) {
      issues.push({
        code: 'INSUFFICIENT_CLAIM_NOT_SUSPENDED',
        detail: `悬置节里没有点到这些断言：${missing.map(m => `[${m.id}] ${m.claim.slice(0, 40)}…`).join('；')}`,
      })
    }
  }

  // 3) 悬置项的证据来源不得在正文里被**按引用句式**使用
  //    （=把没确证的东西当结论讲）。粒度到「页 + 节」，且要求引用框架，
  //    否则正文里正常出现的传本名/大师名会把它变成误报机器。
  if (insufficient.length && bodyText.trim()) {
    const acceptedLabels = new Set()
    for (const a of accepted) for (const s of sourcesOf(a)) acceptedLabels.add(String(s).trim())

    const leaked = new Set()
    for (const i of insufficient) {
      for (const s of sourcesOf(i)) {
        const label = String(s).trim()
        if (acceptedLabels.has(label)) continue
        const hit = findCitation(bodyText, { page: pageOf(label), anchor: anchorOf(label) })
        if (hit) leaked.add(`${hit}（悬置项 ${i.id} 的来源）`)
      }
    }
    if (leaked.size) {
      issues.push({
        code: 'SUSPENDED_EVIDENCE_PRESENTED_AS_SETTLED',
        detail: `正文以引用句式使用了只出现在悬置项里的证据来源，等于把未确证内容当结论：${[...leaked].join('；')}`,
      })
    }
  }

  // 4) 已通过的断言必须都体现出来（防止撰写者丢掉已验证的成果）
  if (accepted.length) {
    const missing = accepted.filter(a => !isMentioned(a.claim, text, cfg.mentionThreshold))
    if (missing.length) {
      issues.push({
        code: 'ACCEPTED_CLAIM_MISSING',
        detail: `报告没有体现这些已确证的断言：${missing.map(m => `[${m.id}] ${m.claim.slice(0, 40)}…`).join('；')}`,
      })
    }
  }

  return { pass: issues.length === 0, issues }
}

/**
 * 代码兜底：无论撰写者写没写，都保证最终产物里有完整、可读的悬置节。
 *
 * 若已有悬置节，缺的条目**补进那一节内部**（插到该节末尾、下一个同级或更高级标题之前）。
 * 早先是把整块追加到文档末尾 —— 那样补进去的内容在结构上属于**最后一节**，
 * 于是它带的来源名会被泄漏检查当成"正文里引用了悬置来源"，自己把自己判不合格。
 */
export function enforceSuspension(report, insufficient, cfg = REPORT_DEFAULTS) {
  const text = String(report ?? '').trim()
  if (!insufficient.length) return text

  const { roots, suspensionText } = partitionBySuspension(text)
  const missing = roots.length
    ? insufficient.filter(i => !isMentioned(i.claim, suspensionText, cfg.mentionThreshold))
    : insufficient
  if (!missing.length) return text

  const itemLines = missing.flatMap(i => {
    const lines = [`- **[${i.atom ?? '?'} / ${i.id}]** ${i.claim}`]
    const reasons = i.lastReasons ?? (i.detail ? [i.detail] : [])
    if (reasons.length) lines.push(`  - 未通过原因：${reasons.join('；')}`)
    const tried = sourcesOf(i)
    if (tried.length) lines.push(`  - 已尝试的证据：${tried.join('；')}`)
    if (i.roundsAttempted) lines.push(`  - 尝试轮数：${i.roundsAttempted}`)
    return lines
  })

  const payload = [
    '',
    '（以下条目由校验程序补充，撰写者未在悬置节中点到）',
    '',
    ...itemLines,
    '',
  ]

  if (!text) return [`## ${SUSPENSION_HEADING}`, '', ...itemLines, ''].join('\n')

  if (roots.length) {
    const lines = text.split(/\r?\n/)
    const anchor = roots[roots.length - 1]
    // 插到该节末尾 = 下一个同级/更高级标题所在行之前（含其后代子节都被保留在这一节里）
    lines.splice(anchor.end, 0, ...payload)
    return lines.join('\n')
  }

  return `${text}\n\n${['## ' + SUSPENSION_HEADING, '', ...itemLines, ''].join('\n')}`
}

/**
 * 跑报告撰写 + 后置检查 + 打回重写 + 代码兜底。
 *
 * @param {object} o
 * @param {string} o.question
 * @param {object} o.brief buildReportBrief 的产物
 * @param {(ctx:object)=>Promise<string>} o.askWriter 调撰写者，返回 markdown 报告
 * @param {object} [o.cfg] REPORT_DEFAULTS 覆盖
 * @param {(e:object)=>void} [o.onEvent]
 */
export async function runReport({ question, brief, askWriter, cfg: cfgIn = {}, onEvent = () => {} }) {
  const cfg = { ...REPORT_DEFAULTS, ...cfgIn }
  const emit = (e) => { try { onEvent({ question, ...e }) } catch { /* 忽略 */ } }
  const payload = brief ?? buildReportBrief({ question })

  const history = []
  let report = null
  let check = null
  let round = 0

  while (round < cfg.maxRounds) {
    round++
    emit({ type: 'report_round_start', round })
    let text
    let callErr = null
    for (let attempt = 1; attempt <= cfg.roleRetries + 1; attempt++) {
      try {
        text = await askWriter({
          question, brief: payload, rendered: renderBrief(payload), round, attempt,
          issues: check?.issues ?? null,
          hint: check?.issues?.length
            ? '上一稿未通过校验：' + check.issues.map(i => i.detail).join('；')
              + `。请修正后重写。特别地：所有未通过验证的断言必须逐条写进「${SUSPENSION_HEADING}」一节，正文不得把它们当结论陈述。`
            : '请依据已通过验证的断言撰写研究报告。未通过验证的断言必须逐条列入「证据悬置」一节。',
        })
        callErr = null
        break
      } catch (e) {
        callErr = e
        // 进程崩溃是基础设施故障，不该消耗重写轮数
        emit({ type: 'writer_retry', round, attempt, maxAttempts: cfg.roleRetries + 1, error: String(e.message ?? e) })
        if (attempt <= cfg.roleRetries) await sleep(cfg.retryBackoffMs * attempt)
      }
    }
    if (callErr) {
      history.push({ round, error: `撰写者调用失败（调用重试 ${cfg.roleRetries} 次后仍失败）: ${callErr.message ?? callErr}` })
      emit({ type: 'writer_error', round, error: String(callErr.message ?? callErr) })
      check = { pass: false, issues: [{ code: 'WRITER_ERROR', detail: String(callErr.message ?? callErr) }] }
      continue
    }

    report = String(text ?? '')
    check = postcheck(report, payload, cfg)
    history.push({ round, check, chars: report.length })
    emit({ type: 'report_round_done', round, pass: check.pass, issues: check.issues.map(i => i.code) })

    if (check.pass) break
  }

  // 代码兜底：无论校验是否通过，最终产物一定带完整悬置节
  const enforced = enforceSuspension(report, payload.insufficient, cfg)
  const finalCheck = postcheck(enforced, payload, cfg)
  const appendedByCode = enforced !== String(report ?? '').trim()

  emit({
    type: 'report_done',
    passedOnFirstCheck: check?.pass ?? false,
    finalPass: finalCheck.pass,
    appendedByCode,
    remainingIssues: finalCheck.issues.map(i => i.code),
  })

  return {
    question,
    report: enforced,
    rounds: history.length,
    check: finalCheck,
    writerPassed: check?.pass ?? false,
    appendedByCode,
    history,
    stats: {
      rounds: history.length,
      chars: enforced.length,
      acceptedCount: payload.accepted.length,
      insufficientCount: payload.insufficient.length,
    },
  }
}
