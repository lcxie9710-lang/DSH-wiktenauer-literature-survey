/**
 * v2 wiki 客户端（阶段 0.1 + 1a 实测后定稿）
 *
 * ★ 核心结论（0.1 实测得出，与最初设想不同）★
 *
 *   Wiktenauer 技术页的 **wikitext 是空壳** —— 内容靠
 *   `{{#lst: 大师页 | Zornhaw }}` 标签式转借，只在渲染时出现。
 *   所以按 byteoffset 切 wikitext 只能拿到转借指令。
 *
 *   而渲染后的 HTML **heading 没有 id**（整页只有一个 mw-toc-heading），
 *   所以又不能靠 HTML 的 id 认节。
 *
 *   正解：两个都取，**按文档位置配对**
 *     action=parse&prop=sections|text|revid
 *     ├─ p.sections → anchor（稳定名字）
 *     └─ p.text     → 渲染后的真实内容
 *     切 HTML 的 heading，丢掉 TOC 节，与 p.sections 逐位配对
 *     → anchor + 真实内容
 *   实测 5 个页面（技术页/薄页/手稿页）配对一致率 **100%**。
 *
 *   附带：节粒度很粗（Zornhaw 中位 8805 字，Codex Ringeck 某节 24821 字），
 *   所以**节内按段落二级切分是主路径**。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeTermsVerbose } from './glossary.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const V2_ROOT = join(HERE, '..')
export const CACHE_DIR = join(V2_ROOT, 'out', 'cache')

export const API = 'https://wiktenauer.com/api.php'
const UA = 'dsh-hema-v2/0.1 (harness)'
const TIMEOUT_MS = 30000

// ── API + 缓存 ────────────────────────────────────────────────

function cacheKey(name, params) {
  const h = createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 16)
  return join(CACHE_DIR, name, `${h}.json`)
}

export async function api(params, { cacheName = 'api', retries = 3, useCache = true } = {}) {
  const path = cacheName ? cacheKey(cacheName, params) : null
  if (useCache && path && existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { /* 坏缓存重取 */ }
  }
  const url = new URL(API)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  url.searchParams.set('format', 'json')
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data), 'utf8') }
      return data
    } catch (e) {
      lastErr = e
      if (attempt < retries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
    } finally { clearTimeout(timer) }
  }
  throw new Error(`wiktenauer api failed: ${lastErr?.message ?? lastErr}`)
}

// ── 标题解析 / 链接 ───────────────────────────────────────────

export async function resolveTitles(titles) {
  const out = new Map()
  const CHUNK = 40
  for (let i = 0; i < titles.length; i += CHUNK) {
    const chunk = titles.slice(i, i + CHUNK)
    const data = await api({ action: 'query', titles: chunk.join('|'), redirects: '1', prop: 'info' }, { cacheName: 'resolve' })
    const normalized = data?.query?.normalized ?? []
    const redirects = data?.query?.redirects ?? []
    const pages = data?.query?.pages ?? {}
    for (const t of chunk) {
      let cur = t
      const n = normalized.find(x => x.from === cur); if (n) cur = n.to
      const r = redirects.find(x => x.from === cur); if (r) cur = r.to
      const page = Object.values(pages).find(p => p.title === cur)
      out.set(t, {
        resolved: cur,
        exists: page ? page.missing === undefined : false,
        isCategory: cur.startsWith('Category:'),
      })
    }
  }
  return out
}

export async function outlinks(title) {
  const data = await api({ action: 'query', titles: title, prop: 'links', pllimit: '500', plnamespace: '0' }, { cacheName: 'outlinks' })
  for (const p of Object.values(data?.query?.pages ?? {})) {
    if (p.missing !== undefined) return []
    return (p.links ?? []).map(x => x.title)
  }
  return []
}

/**
 * 前缀标题搜索。
 *
 * 与 list=search 的区别很关键：实测 Wiktenauer 上全文检索的召回**灾难性地低**
 * （技术术语只能命中 1–3 条），而且没有 CirrusSearch，`insource:` 不可用。
 * 但 `list=prefixsearch` 走的是标题前缀，对我们真正要解决的问题
 * ——「术语表写 Zornhau，wiki 页面叫 Zornhaw」这类拼写变体 —— 恰好有效。
 * 这是把术语表转成**起跳页**的关键一步。
 */
export async function prefixSearch(prefix, limit = 10) {
  const data = await api(
    { action: 'query', list: 'prefixsearch', pssearch: prefix, pslimit: String(Math.min(limit, 500)) },
    { cacheName: 'prefix' },
  )
  return (data?.query?.prefixsearch ?? []).map(x => x.title).filter(Boolean)
}

/**
 * 全文检索（`list=search`）。
 *
 * **实测召回很低**：Wiktenauer 没有 CirrusSearch，技术术语往往只命中 1–3 条。
 * 所以这个工具的正确用法是"找页面标题线索"，不是"找内容" ——
 * 真正的取证要靠 `wiki_get_page` 把页面读下来。
 */
export async function search(query, limit = 10) {
  const data = await api(
    { action: 'query', list: 'search', srsearch: query, srlimit: String(Math.min(limit, 50)) },
    { cacheName: 'search' },
  )
  return (data?.query?.search ?? []).map(x => ({
    title: x.title,
    snippet: stripWikiResidue(decodeEntities(String(x.snippet ?? '').replace(/<[^>]+>/g, ''))),
    wordcount: x.wordcount ?? null,
    size: x.size ?? null,
  })).filter(h => h.title)
}

/**
 * 给模型看的页面视图：**每个节都带 anchor**。
 *
 * 这是本插件相对 v1 `wiki_get_page` 的关键差别。v1 只返回纯文本，
 * 于是研究者自行检索到的页面**只能给整页定位符**（anchor: null）；
 * 而 v2 的证据形态是 {page, anchor, revid}，能精确到节。
 * 把 anchor 直接摆给模型，它就能精确引用自己检索到的页面 ——
 * 这堵上了"自行检索只能整页引用"那个缺口。
 *
 * 故意**不返回全文**：整页动辄几十万字符（实测最大 3.5MB），
 * 既撑爆上下文也压不住成本。返回节的标题 + anchor + 字数，
 * 由模型决定读哪一节，再用 wiki_get_section 取正文。
 */
export function pageOutline(doc, { maxSections = 60, leadChars = 800 } = {}) {
  const lead = String(doc.lead?.text ?? '').replace(/\s+/g, ' ').trim()
  return {
    page: doc.title,
    revid: doc.revid,
    totalChars: String(doc.flat ?? '').length,
    lead: lead.slice(0, leadChars),
    leadChars: lead.length,
    sections: (doc.sections ?? []).slice(0, maxSections).map(s => ({
      anchor: s.anchor,
      heading: s.heading,
      level: s.level,
      chars: s.textLen ?? String(s.text ?? '').length,
      paired: s.paired,
    })),
    sectionCount: (doc.sections ?? []).length,
  }
}

/** 取一个节（或整页）的正文，供模型精读 */
export function sectionText(doc, anchor, { maxChars = 6000 } = {}) {
  if (anchor === null || anchor === undefined || anchor === '') {
    const text = String(doc.flat ?? '')
    return {
      page: doc.title, revid: doc.revid, anchor: null, heading: null, found: true,
      chars: text.length, text: text.slice(0, maxChars), truncated: text.length > maxChars,
    }
  }
  const sec = (doc.sections ?? []).find(s => s.anchor === anchor)
  if (!sec) {
    return {
      page: doc.title, revid: doc.revid, anchor, found: false,
      availableAnchors: (doc.sections ?? []).map(s => s.anchor).filter(Boolean).slice(0, 80),
    }
  }
  const text = String(sec.text ?? '')
  return {
    page: doc.title, revid: doc.revid, anchor, heading: sec.heading, found: true,
    chars: text.length, text: text.slice(0, maxChars), truncated: text.length > maxChars,
  }
}

// ── HTML -> 文本 ──────────────────────────────────────────────

const NAMED = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', ouml: 'ö', auml: 'ä', uuml: 'ü',
  Ouml: 'Ö', Auml: 'Ä', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è',
  agrave: 'à', ccedil: 'ç', oslash: 'ø', aring: 'å', sect: '§', deg: '°',
  times: '×', middot: '·', bull: '•', laquo: '«', raquo: '»', copy: '©',
  shy: '', ensp: ' ', emsp: ' ', thinsp: ' ', zwsp: '',
}

const cp = (n) => { try { return String.fromCodePoint(n) } catch { return '' } }

/** 实体解码：数字（&#160; &#x27;）+ 命名。实测页面里 &#160; 与 &#91; 大量出现。 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => NAMED[n] ?? NAMED[n.toLowerCase()] ?? m)
}

/**
 * 去掉渲染输出里残留的**字面** wiki 表格标记。
 * 实测 Wiktenauer 的转借内容会留下不成对的 `|}` `|-` `| colspan=.. |`，
 * 它们是页面自身的残码，渲染成字面字符。按行首特征丢弃。
 */
export function stripWikiResidue(text) {
  const kept = []
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t) { kept.push(''); continue }
    if (/^\{?\|[-}]?/.test(t) && /^[|!{]/.test(t)) continue   // |} |- {| |xxx !xxx
    if (/^\|/.test(t)) continue
    if (/^!/.test(t)) continue
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * 渲染 HTML -> 文本。表格转成"单元格用制表符、行用换行"（保住对齐关系），
 * 段落/列表边界保留为换行。
 */
export function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|sup)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<sup\b[^>]*\/>/gi, '')
    // MediaWiki 的 [edit] 编辑链接（在正文里，不在 heading 里）
    .replace(/<span[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/\[\s*edit\s*\]/gi, '')
  // 表格：保留文字，单元格用 \t，行用换行
  s = s.replace(/<\/t[dh]>/gi, '\t')
  s = s.replace(/<\/tr>/gi, '\n')
  // 块边界
  s = s.replace(/<\/(p|div|li|h[1-6]|ul|ol|blockquote|dd|dt)>/gi, '\n')
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n')
  s = s.replace(/<li[^>]*>/gi, '\n• ')
  // 剩余标签
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = stripWikiResidue(s)
  s = s.replace(/[ \t\u00a0]+/g, ' ').replace(/ ?\t ?/g, '\t')
  const lines = []
  for (const raw of s.split('\n')) {
    const t = raw.trim()
    if (!t) { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); continue }
    lines.push(t)
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/** 段看起来像表格残渣/元数据而不是散文？ */
function looksLikeMarkup(p) {
  if (/\t/.test(p)) return true                       // 表格行
  const punct = (p.match(/[|!{}=\[\]<>]/g) ?? []).length
  if (punct / p.length > 0.04) return true
  const letters = (p.match(/[\p{L}]/gu) ?? []).length
  return letters / p.length < 0.55
}

/**
 * 段看起来像"标签"而不是证据？
 *
 * 实测：Wiktenauer 的转写节里，每个转写块前面有一行标签
 * （"Sigmund Schining ain Ringeck's Gloss of the Recital (before 1508)"、
 *   "Munich Version (ca. 1470) Transcribed by Dierk Hagedorn"）。
 * 它们含来源名，所以按关键词打分时会**盖过真正的证据正文**。
 * 不剔除（它们有 provenance 价值），但在选段时降权。
 */
export function looksLikeLabel(p) {
  const t = String(p).trim()
  if (!t) return true
  if (/^transcribed by\b/i.test(t)) return true
  if (/^translation by\b/i.test(t)) return true
  // 无句末标点且较短 → 标签
  const hasSentenceEnd = /[.!?。！？]/.test(t)
  if (!hasSentenceEnd && t.length < 120) return true
  // 句子数极少、词数不少但缺标点 → 标签
  const sentences = (t.match(/[.!?。！？]/g) ?? []).length
  const words = (t.match(/\S+/g) ?? []).length
  if (sentences === 0 && words <= 18) return true
  return false
}

/** 文本 -> 段落（按空行切；丢掉过短和像标记的块） */
export function splitParagraphs(text, { minLen = 60 } = {}) {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length >= minLen && !looksLikeMarkup(p))
}

// ── 取页：HTML 内容 + API anchor 位置配对 ─────────────────────

const TOC_RE = /^contents$/i

/** 按 heading 切 HTML（不依赖 id） */
function splitHtmlByHeadings(html) {
  const heads = []
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const heading = decodeEntities(m[2].replace(/<[^>]+>/g, '').replace(/\[\s*edit\s*\]/gi, '')).replace(/\s+/g, ' ').trim()
    heads.push({ level: Number(m[1]), heading, start: m.index, end: re.lastIndex })
  }
  const out = []
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]
    const stop = i + 1 < heads.length ? heads[i + 1].start : html.length
    out.push({ level: h.level, heading: h.heading, html: html.slice(h.end, stop) })
  }
  return out
}

const normHeading = (s) => String(s ?? '').replace(/\[\s*edit\s*\]/gi, '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * 取一页，返回带 anchor 的节。
 * @param {string} title
 * @param {{revid?:number}} [opts] 传 revid 用 oldid 钉住版本
 */
export async function fetchPage(title, opts = {}) {
  const params = { action: 'parse', prop: 'sections|text|revid' }
  if (opts.revid) params.oldid = String(opts.revid)
  else { params.page = title; params.redirects = '1' }

  const data = await api(params, { cacheName: opts.revid ? 'page-rev' : 'page' })
  if (data?.error) throw new Error(`page '${title}': ${data.error.code} ${data.error.info ?? ''}`)
  const p = data?.parse
  if (!p) throw new Error(`page '${title}': no parse result`)

  const resolvedTitle = p.title ?? title
  const revid = Number(p.revid) || null
  const html = p.text?.['*'] ?? ''
  const apiMeta = (p.sections ?? []).map((s, i) => ({
    index: Number(s.index ?? i + 1),
    level: Number(s.level ?? 2),
    anchor: s.anchor ?? null,
    heading: s.line ?? '',
    byteOffset: s.byteoffset ?? null,
  }))

  // 切 HTML，丢掉第一个 TOC 节
  let htmlSecs = splitHtmlByHeadings(html)
  if (htmlSecs.length && TOC_RE.test(normHeading(htmlSecs[0].heading))) htmlSecs = htmlSecs.slice(1)

  // 位置配对 + heading 文本校验
  const sections = []
  const n = Math.max(htmlSecs.length, apiMeta.length)
  for (let i = 0; i < n; i++) {
    const h = htmlSecs[i] ?? null
    const a = apiMeta[i] ?? null
    const text = h ? htmlToText(h.html) : ''
    sections.push({
      index: a?.index ?? i + 1,
      level: h?.level ?? a?.level ?? 2,
      anchor: a?.anchor ?? null,
      heading: h?.heading || a?.heading || '',
      byteOffset: a?.byteOffset ?? null,
      paired: Boolean(h && a) && (a.heading ? normHeading(a.heading) === normHeading(h.heading) : true),
      text,
      textLen: text.length,
      paragraphs: splitParagraphs(text),
    })
  }

  // 导言（第一个 heading 之前）
  const leadText = htmlSecs.length ? htmlToText(html.slice(0, (splitHtmlByHeadings(html)[0]?.start) ?? 0)) : htmlToText(html)

  const flat = sections.length ? sections.map(s => s.text).filter(Boolean).join('\n\n') : htmlToText(html)

  return {
    title: resolvedTitle,
    revid,
    lead: { text: leadText, textLen: leadText.length, paragraphs: splitParagraphs(leadText) },
    sections,
    flat,
  }
}

// ── 定位符 ────────────────────────────────────────────────────

export function makeLocator({ page, anchor = null, revid = null }) {
  return { page, anchor, revid }
}

/**
 * 解引用：定位符 -> 真实文本与段落。
 * 架构的核心动作 —— 证据以定位符传递，只有交给 JEV/LLM 时才解引用。
 */
export async function dereference(locator) {
  const { page, anchor = null, revid = null } = locator ?? {}
  if (!page) return { ok: false, reason: 'MISSING_PAGE', text: '', paragraphs: [] }
  let doc
  try {
    doc = await fetchPage(page, revid ? { revid } : {})
  } catch (e) {
    const m = String(e.message ?? e)
    const reason = /nosuchrevid/i.test(m) ? 'REVID_NOT_FOUND' : /missingtitle/i.test(m) ? 'PAGE_NOT_FOUND' : `FETCH_FAILED: ${m}`
    return { ok: false, reason, page, anchor, revid, text: '', paragraphs: [] }
  }
  if (revid && doc.revid && Number(revid) !== doc.revid) {
    return { ok: false, reason: `REVID_MISMATCH want=${revid} got=${doc.revid}`, page: doc.title, anchor, revid, text: '', paragraphs: [] }
  }
  if (anchor === null) {
    return { ok: true, page: doc.title, anchor: null, revid: doc.revid, text: doc.flat, paragraphs: splitParagraphs(doc.flat), wholePage: true }
  }
  const sec = doc.sections.find(s => s.anchor === anchor)
  if (!sec) {
    return {
      ok: false, reason: `ANCHOR_NOT_FOUND: ${anchor}`, page: doc.title, anchor, revid: doc.revid,
      text: '', paragraphs: [], availableAnchors: doc.sections.map(s => s.anchor).filter(Boolean),
    }
  }
  return { ok: true, page: doc.title, anchor, revid: doc.revid, heading: sec.heading, text: sec.text, paragraphs: sec.paragraphs }
}

/**
 * 从解引用结果里按断言挑最相关的若干段（节太粗，这是主路径）。
 *
 * 三个实测得出的要点：
 *  1. **停用词 = 页标题 + 节标题里的词**。它们在这条来源里到处都是，不具区分度。
 *     例：断言含 "Ringeck"，而 Primary Sources 节里每块转写都标着来源名 →
 *     不去掉它，选段就会全选到标签行。
 *  2. **标签行降权而非剔除** —— 「Sigmund Schining ain Ringeck's Gloss…」有
 *     provenance 价值，但不是证据。
 *  3. **以最高分段为中心向两侧扩展**（而不是取 top-N 个互不相邻的段）——
 *     转写内容是连续的行/段，取窗口才能保住上下文。
 */
export function selectParagraphs(paragraphs, claim, {
  pageTitle = '', heading = '', maxChars = 4000, maxParas = 10,
} = {}) {
  const list = paragraphs ?? []
  if (!list.length) return { selected: [], chars: 0, strategy: 'empty' }

  // ★ 术语归一化：中文断言里的术语换成德/英，否则与英德正文完全对不上
  const { text: claimNorm, applied } = normalizeTermsVerbose(claim)

  const pageWords = new Set(tokenize(`${pageTitle} ${heading}`))
  const allClaimWords = [...new Set(tokenize(claimNorm))]
  let useWords = allClaimWords.filter(w => !pageWords.has(w))
  if (!useWords.length) useWords = allClaimWords

  const scored = list.map((p, i) => {
    const low = p.toLowerCase()
    const toks = new Set(low.split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 4))
    let hit = 0
    for (const w of useWords) {
      if (low.includes(w)) { hit++; continue }
      // 拼写变体兜底：实测术语表写 Zornhau，wiki 正文写 zornnhaw / zornhaw。
      // 对长度 ≥6 的词，用前 4 字符前缀在段内词表里找近形。
      if (w.length >= 6) {
        const pre = w.slice(0, 4)
        let found = false
        for (const t of toks) { if (t.startsWith(pre)) { found = true; break } }
        if (found) hit++
      }
    }
    const label = looksLikeLabel(p)
    const score = (hit / Math.max(useWords.length, 1)) * (label ? 0.15 : 1)
    return { i, p, hit, label, score, len: p.length }
  })

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0])
  const meta = {
    stoplistSize: pageWords.size,
    usedWords: useWords.length,
    labelCount: scored.filter(s => s.label).length,
    termNormalized: applied.map(a => `${a.zh}→${a.to}`),
  }

  if (best.score <= 0) {
    const sel = list.slice(0, Math.min(maxParas, 3))
    return { selected: sel, chars: sel.join('\n\n').length, strategy: 'no-match-head', ...meta }
  }

  const picked = [best]
  let chars = best.len
  let lo = best.i - 1
  let hi = best.i + 1
  while (chars < maxChars && picked.length < maxParas && (lo >= 0 || hi < list.length)) {
    const cands = []
    if (lo >= 0) cands.push({ ...scored[lo], side: 'lo' })
    if (hi < list.length) cands.push({ ...scored[hi], side: 'hi' })
    if (!cands.length) break
    cands.sort((a, b) => (b.score - a.score) || (b.len - a.len))
    const next = cands[0]
    if (chars + next.len > maxChars && picked.length >= 2) break
    picked.push(next)
    chars += next.len
    if (next.side === 'lo') lo--
    else hi++
  }
  picked.sort((a, b) => a.i - b.i)

  return {
    selected: picked.map(x => x.p),
    chars,
    strategy: 'center-window',
    bestIndex: best.i,
    bestScore: Number(best.score.toFixed(3)),
    ...meta,
  }
}

/** 粗分词：拉丁按词，CJK 按字符二元 */
export function tokenize(text) {
  const out = []
  for (const seg of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!seg) continue
    if (/[\u3400-\u9fff]/.test(seg)) {
      const cs = [...seg]
      for (let i = 0; i + 1 < cs.length; i++) out.push(cs[i] + cs[i + 1])
    } else if (seg.length >= 3) out.push(seg)
  }
  return out
}
