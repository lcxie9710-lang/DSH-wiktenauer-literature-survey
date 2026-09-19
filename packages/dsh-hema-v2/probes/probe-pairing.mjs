/**
 * 验证「HTML 内容 + API anchor 按位置配对」是否成立
 *
 * 背景：Wiktenauer 技术页的 wikitext 是 {{#lst: ...}} 转借空壳，
 * 真正内容只在渲染后的 HTML 里；而 HTML 的 heading 没有 id。
 * 两者都是文档顺序 → 尝试按位置把 anchor 贴到 HTML 切出的节上。
 */
import { api, API } from '../lib/wiki.mjs'

const UA = 'dsh-hema-v2/0.1 (anchor pairing probe)'

const PAGES = [
  ['技术页', 'Zornhaw'],
  ['技术页', 'Schilhaw'],
  ['技术页', 'Nachreisen'],
  ['薄页', 'Indes'],
  ['手稿页', 'Codex Ringeck (MS Dresd.C.487)'],
  ['手稿页', 'Goliath Fechtbuch (MS Germ.Quart.2020)'],
]

/** 从 HTML 里按 heading 切节（不依赖 id） */
function splitHtmlByHeadings(html) {
  const heads = []
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\[\s*edit\s*\]/gi, '').replace(/\s+/g, ' ').trim()
    heads.push({ level: Number(m[1]), heading: text, start: m.index, end: re.lastIndex })
  }
  const out = []
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]
    const stop = i + 1 < heads.length ? heads[i + 1].start : html.length
    const body = html.slice(h.end, stop)
    const text = body
      .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    out.push({ level: h.level, heading: h.heading, textLen: text.length, htmlLen: body.length, text })
  }
  return out
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/\[\s*edit\s*\]/gi, '').trim().toLowerCase()

const report = []
for (const [kind, page] of PAGES) {
  const url = new URL(API)
  const params = { action: 'parse', page, prop: 'sections|text|revid', redirects: '1', format: 'json' }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  const data = await res.json()
  if (data?.error) { console.log(`【${kind}】${page}  ✗ ${data.error.code}`); continue }

  const p = data.parse
  const apiSections = p.sections ?? []
  const html = p.text?.['*'] ?? ''
  const htmlSections = splitHtmlByHeadings(html)

  // 丢掉 TOC 节（heading 文本为 Contents 且是第一个）
  const htmlNoToc = htmlSections.filter((s, i) => !(i === 0 && /^contents$/i.test(s.heading)))

  console.log('='.repeat(76))
  console.log(`【${kind}】${String(p.title).slice(0, 50)}`)
  console.log(`  API sections: ${apiSections.length}   HTML headings: ${htmlSections.length}   （去 TOC 后 ${htmlNoToc.length}）`)

  const n = Math.min(apiSections.length, htmlNoToc.length)
  let matched = 0
  const rows = []
  for (let i = 0; i < n; i++) {
    const a = norm(apiSections[i].line)
    const h = norm(htmlNoToc[i].heading)
    const same = a === h
    if (same) matched++
    rows.push({ i, anchor: apiSections[i].anchor, apiLine: apiSections[i].line, htmlHeading: htmlNoToc[i].heading, same, textLen: htmlNoToc[i].textLen })
  }
  console.log(`  位置配对一致: ${matched}/${n}`)
  for (const r of rows.slice(0, 8)) {
    console.log(`    ${r.same ? '✓' : '✗'} [${r.i}] anchor=${String(r.anchor).padEnd(28)} api=「${String(r.apiLine).slice(0, 26)}」 html=「${String(r.htmlHeading).slice(0, 26)}」 ${r.textLen}字`)
  }
  const lens = htmlNoToc.map(s => s.textLen).filter(x => x > 0)
  if (lens.length) {
    const sorted = [...lens].sort((a, b) => a - b)
    console.log(`  HTML 切出的节字数 min/中位/max = ${sorted[0]} / ${sorted[Math.floor(sorted.length / 2)]} / ${sorted[sorted.length - 1]}   合计 ${lens.reduce((a, b) => a + b, 0)}`)
    console.log(`  超过 4000 字的节: ${lens.filter(x => x > 4000).length}`)
  }
  // 展示第一个非 TOC 节的实际内容开头
  const firstReal = htmlNoToc.find(s => s.textLen > 200)
  if (firstReal) {
    console.log(`  「${firstReal.heading}」内容开头 200 字:`)
    console.log(`    ${firstReal.text.slice(0, 200).replace(/\n/g, ' ⏎ ')}`)
  }
  console.log()

  report.push({ kind, page, apiSections: apiSections.length, htmlHeadings: htmlSections.length, paired: n, matched, lens })
}

console.log('='.repeat(76))
console.log('汇总：位置配对')
console.log('类型    页面                             API节  HTML节  配对  一致  一致率')
for (const r of report) {
  const rate = r.paired ? (r.matched / r.paired * 100).toFixed(0) + '%' : 'n/a'
  console.log(`${r.kind.padEnd(6)} ${String(r.page).slice(0, 32).padEnd(32)} ${String(r.apiSections).padStart(5)} ${String(r.htmlHeadings).padStart(6)} ${String(r.paired).padStart(6)} ${String(r.matched).padStart(5)}  ${rate}`)
}
