/**
 * 术语归一化：中文术语 -> 德/英术语
 *
 * 为什么 v2 也需要它：报告与断言是中文，而 Wiktenauer 的正文是英/德文。
 * 不归一化的话，选段时唯一能匹配的 token 就是断言里的人名（如 "Ringeck"），
 * 结果会选中满是人名的**标签行**而不是证据正文（实测确认）。
 *
 * 数据源：data/glossary.md（用户的《完整术语表.md》副本，解析出 100+ 条）
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const GLOSSARY_MD = join(HERE, '..', 'data', 'glossary.md')

/**
 * 解析术语表。两个来源：
 *   1) 文末三列表 `| 中文 | 德语 | 英语 |`
 *   2) 正文条目 `N. **中文** - 英文 / 德文`
 */
export function parseGlossary(md) {
  const entries = new Map()
  const put = (zh, de, en) => {
    const k = String(zh ?? '').trim()
    if (!k || k.length > 40) return
    const cur = entries.get(k) ?? {}
    const d = String(de ?? '').trim()
    const e = String(en ?? '').trim()
    if (d && d.length <= 60) cur.de = cur.de || d
    if (e && e.length <= 60) cur.en = cur.en || e
    if (cur.de || cur.en) entries.set(k, cur)
  }
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/)
    if (!m) continue
    const [, zh, de, en] = m
    if (/^-+$/.test(zh) || /中文术语/.test(zh)) continue
    put(zh, de, en)
  }
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*\d+\.\s*\*\*(.+?)\*\*\s*[-–—]\s*(.+?)\s*$/)
    if (!m) continue
    const zh = m[1].trim()
    const rest = m[2].replace(/\s*\([^)]*\)\s*$/, '').trim()
    const parts = rest.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean)
    if (!parts.length) continue
    if (parts.length >= 2) put(zh, parts[parts.length - 1], parts[0])
    else {
      const only = parts[0]
      if (/[äöüß]/.test(only)) put(zh, only, null)
      else put(zh, null, only)
    }
  }
  return entries
}

let _cache = null
export function loadGlossary() {
  if (_cache) return _cache
  if (!existsSync(GLOSSARY_MD)) { console.warn(`⚠ 未找到 ${GLOSSARY_MD}`); _cache = new Map(); return _cache }
  _cache = parseGlossary(readFileSync(GLOSSARY_MD, 'utf8'))
  return _cache
}

/**
 * 把文本里的中文术语替换成德语（无德语则英文）。
 * 按长度降序遍历，避免短词先吃掉长词的一部分。
 * @returns {{text:string, applied:Array<{zh:string,to:string}>}}
 */
export function normalizeTermsVerbose(text) {
  const g = loadGlossary()
  const keys = [...g.keys()].sort((a, b) => b.length - a.length)
  let out = String(text ?? '')
  const applied = []
  for (const zh of keys) {
    if (!out.includes(zh)) continue
    const e = g.get(zh)
    const repl = e.de || e.en
    if (!repl) continue
    out = out.split(zh).join(` ${repl} `)
    applied.push({ zh, to: repl })
  }
  return { text: out, applied }
}

/** 便捷：只取归一化后的文本 */
export function normalizeTerms(text) {
  return normalizeTermsVerbose(text).text
}

/**
 * 查术语：中文 → 德/英，或**反查**（德/英 → 中文）。
 *
 * 反查是给 researcher 用的：它从英文页面里读到 `Zornhau`，
 * 需要知道中文该写「怒击」。归一化是单向的（中文→德英），所以反查要另做。
 *
 * @param {string} term 要查的词（大小写与首尾空白不敏感）
 * @param {{limit?:number}} [opts]
 * @returns {{forward:Array<{zh:string,de:string|null,en:string|null}>, reverse:Array<{zh:string,de:string|null,en:string|null}>}}
 */
export function lookupTerm(term, { limit = 12 } = {}) {
  const g = loadGlossary()
  const q = String(term ?? '').trim()
  const out = { forward: [], reverse: [] }
  if (!q) return out
  const ql = q.toLowerCase()

  // 正向：中文键包含查询词（允许「怒击」查到「怒击（Zornhau）」这类长键）
  for (const [zh, e] of g) {
    if (zh.includes(q) || q.includes(zh)) out.forward.push({ zh, de: e.de ?? null, en: e.en ?? null })
    if (out.forward.length >= limit) break
  }
  // 反向：德/英侧精确或包含匹配
  for (const [zh, e] of g) {
    const de = (e.de ?? '').toLowerCase()
    const en = (e.en ?? '').toLowerCase()
    if (!de && !en) continue
    if (de === ql || en === ql) out.reverse.unshift({ zh, de: e.de ?? null, en: e.en ?? null })
    else if ((de && de.includes(ql)) || (en && en.includes(ql))) out.reverse.push({ zh, de: e.de ?? null, en: e.en ?? null })
    if (out.reverse.length >= limit) break
  }
  return out
}

/** 术语表规模（给工具输出里报一下，便于判断数据是否加载成功） */
export function glossarySize() {
  return loadGlossary().size
}
