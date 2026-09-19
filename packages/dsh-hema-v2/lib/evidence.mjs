/**
 * 证据-断言包：本架构的核心数据结构
 *
 * 用户定下的简化形态：
 *   - 只有两样东西：**断言（文本）** 与 **证据（定位符）**
 *   - 证据**不摘录任何原文**，只是「wiki 某页某段」的指针 {page, anchor, revid}
 *   - 证据永远以定位符形式在系统里传递；**只有需要 JEV/LLM 处理时**，
 *     才由程序去定位符指向的位置提取并拼装上下文发给模型
 *
 * 这个设计不是洁癖，是被 JEV 的属性逼出来的：JEV 没有 context、没有 memory，
 * 要判的东西必须整个塞进 `state`。所以"何时把指针变成文本"必须是个显式动作，
 * 而不是让证据以自由文本形式在全系统里漂流（那样既无法审计、也无法钉版本）。
 */

import { dereference, makeLocator, selectParagraphs } from './wiki.mjs'
import { normalizeTerms } from './glossary.mjs'

/** 断言包最大长度：超了就按段选优裁剪 */
export const DEFAULT_MAX_CHARS = 4000

/**
 * 把 researcher 交上来的原始包规范化 + 形状校验。
 * 容忍两种证据写法：定位符对象 {page,anchor,revid} 或字符串 "Page#Anchor" / "Page"。
 */
export function normalizeClaims(raw, { atom = null } = {}) {
  const list = Array.isArray(raw) ? raw : (raw?.claims ?? [])
  const claims = []
  const errors = []
  list.forEach((c, i) => {
    const id = String(c?.id ?? `c${i + 1}`)
    const text = String(c?.claim ?? c?.assertion ?? '').trim()
    if (!text) { errors.push({ id, error: 'EMPTY_CLAIM' }); return }
    const ev = Array.isArray(c?.evidence) ? c.evidence : (c?.evidence ? [c.evidence] : [])
    const locators = []
    for (const e of ev) {
      const loc = toLocator(e)
      if (loc) locators.push(loc)
      else errors.push({ id, error: `BAD_LOCATOR: ${JSON.stringify(e).slice(0, 120)}` })
    }
    claims.push({
      id,
      claim: text,
      subQuestion: String(c?.subQuestion ?? c?.atom ?? atom ?? '').trim(),
      locators,
    })
  })
  return { claims, errors }
}

/** 把各种写法折成规范定位符 */
export function toLocator(e) {
  if (!e) return null
  if (typeof e === 'string') {
    const s = e.trim()
    if (!s) return null
    const [page, anchor] = s.split('#')
    if (!page) return null
    return makeLocator({ page: page.trim(), anchor: anchor ? anchor.trim() : null, revid: null })
  }
  if (typeof e === 'object' && e.page) {
    return makeLocator({
      page: String(e.page).trim(),
      anchor: e.anchor ? String(e.anchor).trim() : null,
      revid: e.revid ?? e.oldid ?? null,
    })
  }
  return null
}

/** locator -> 可读来源标记（审计与 state 里都用它，保证来源可追溯） */
export function locatorLabel(loc) {
  const rev = loc.revid ? ` @${loc.revid}` : ''
  return `${loc.page}${loc.anchor ? '#' + loc.anchor : ' (整页)'}${rev}`
}

/**
 * 解引用一条断言的**全部**证据，按段选优拼成一段文本。
 * 返回的 `failures` 是硬失败（页不存在 / revid 漂移 / anchor 找不到）——
 * 调用方必须把它们当作**证据不成立**处理，绝不能静默丢弃。
 *
 * `deref` 可注入：确定性测试必须能换掉真实网络解引用，否则测试会偷偷打维基。
 */
export async function dereferenceEvidence(claim, { maxChars = DEFAULT_MAX_CHARS, maxParas = 6, deref = dereference } = {}) {
  const sources = []
  const failures = []
  const parts = []
  let chars = 0

  for (const loc of claim.locators) {
    const d = await deref(loc)
    if (!d.ok) {
      failures.push({ locator: loc, label: locatorLabel(loc), reason: d.reason })
      continue
    }
    // 节粒度太粗（实测中位数 8.8k 字符），必须再按断言选段
    const sel = selectParagraphs(d.paragraphs, claim.claim, {
      pageTitle: d.page, heading: d.heading ?? '', maxChars: maxChars - chars, maxParas,
    })
    let text = sel.selected.join('\n\n')
    if (!text.trim()) text = d.text.slice(0, Math.max(0, maxChars - chars))
    if (!text.trim()) { failures.push({ locator: loc, label: locatorLabel(loc), reason: 'EMPTY_SELECTION' }); continue }

    const label = locatorLabel({ ...loc, page: d.page, revid: d.revid })
    parts.push(`<来源 ${sources.length + 1}: ${label}>\n${text}`)
    sources.push({
      locator: { ...loc, page: d.page, revid: d.revid },
      label, chars: text.length,
      // 保留每条来源的**单独文本**：失败路径的 per-evidence 诊断需要把
      // 各来源分别呈现给 JEV，才能指出到底是哪一条不支持断言。
      text,
      strategy: sel.strategy, bestScore: sel.bestScore ?? null,
      termNormalized: sel.termNormalized ?? [],
    })
    chars += text.length
  }

  return { text: parts.join('\n\n'), sources, failures, chars }
}

/**
 * 拼装交给 JEV 的 state。
 *
 * 格式与 `jev.mjs` 的 stub 判官约定一致：每条断言一段
 * `【断言 <id>】` + `【证据 <id>】`，全局一个 `【原子命题】`。
 * 这样一条 state 可以同时判多条断言（共享 state = 共享成本）。
 */
export async function assembleState({ atom, claims, maxChars = DEFAULT_MAX_CHARS, maxParas = 6, deref = dereference }) {
  const blocks = [`【原子命题】${atom}`]
  const perClaim = []

  for (const c of claims) {
    const ev = await dereferenceEvidence(c, { maxChars, maxParas, deref })
    perClaim.push({ id: c.id, claim: c.claim, sources: ev.sources, failures: ev.failures, chars: ev.chars })
    blocks.push(`【断言 ${c.id}】${c.claim}`)
    if (c.subQuestion) blocks.push(`【子题 ${c.id}】${c.subQuestion}`)
    blocks.push(`【证据 ${c.id}】`)
    blocks.push(ev.text || '(无可用证据)')
  }

  return { state: blocks.join('\n'), perClaim }
}

/**
 * 确定性后置检查（不依赖模型，所以不可被绕过）。
 * 在把包交给 JEV 之前先跑：证据都定位不到，就根本不该问 JEV。
 */
export function precheck(claims, perClaim) {
  const issues = []
  for (const c of claims) {
    if (!c.locators.length) { issues.push({ id: c.id, code: 'NO_EVIDENCE', detail: '断言没有附任何证据定位符' }); continue }
    const pc = perClaim.find(p => p.id === c.id)
    if (!pc) continue
    if (!pc.sources.length) {
      issues.push({
        id: c.id, code: 'EVIDENCE_UNRESOLVABLE',
        detail: `全部证据无法解引用：${pc.failures.map(f => `${f.label} → ${f.reason}`).join('; ')}`,
      })
    } else if (pc.failures.length) {
      issues.push({ id: c.id, code: 'EVIDENCE_PARTIAL', detail: `部分证据无法解引用：${pc.failures.map(f => `${f.label} → ${f.reason}`).join('; ')}` })
    }
    // 断言里如果出现术语表能归一化的中文术语，但证据里一个源语言形式都没出现，多半是空谈
    const norm = normalizeTerms(c.claim)
    if (norm === c.claim && /[\u3400-\u9fff]/.test(c.claim) && pc.sources.length) {
      const hasLatin = pc.sources.some(s => /[a-zA-Z]{4,}/.test(s.label))
      if (!hasLatin) issues.push({ id: c.id, code: 'NO_SOURCE_LANGUAGE', detail: '断言为中文但证据全落在无拉丁文的页面上，术语可能对不上' })
    }
  }
  return { ok: issues.length === 0, issues }
}
