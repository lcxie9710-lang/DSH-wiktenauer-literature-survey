/**
 * 阶段 0.1 —— 验证 Wiktenauer 的 section anchor 能否拿到
 *
 * 要回答三个问题：
 *   Q1  action=parse&prop=sections 是否返回可用 anchor？
 *   Q2  渲染后的 HTML 里的 heading 是否带匹配的 id？
 *   Q3  按 anchor 切出来的每一节，粒度是否可用（不是几百字一节，也不是几万字一节）？
 *
 * 直接决定定位符格式 { page, anchor, revid } 定不定得下来。
 */

const API = 'https://wiktenauer.com/api.php'
const UA = 'dsh-hema-v2/0.1 (section anchor probe)'
const TIMEOUT_MS = 30000

/** 技术页 / 薄页 / 手稿页 三类都测 */
const PAGES = [
  ['技术页', 'Zornhaw'],
  ['技术页', 'Schilhaw'],
  ['技术页', 'Nachreisen'],
  ['薄页', 'Indes'],
  ['手稿页', 'Codex Ringeck (MS Dresd.C.487)'],
  ['手稿页', 'Goliath Fechtbuch (MS Germ.Quart.2020)'],
]

async function api(params) {
  const url = new URL(API)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  url.searchParams.set('format', 'json')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message ?? e) }
  } finally { clearTimeout(timer) }
}

/** 把整页 HTML 按 heading 的 id 切成节，返回 [{anchor, level, heading, textLen, textHead}] */
function splitByAnchor(html) {
  // 找出所有 <h1..h6 ...> 的位置与它们的 id / 文本
  const heads = []
  const re = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const attrs = m[2]
    const inner = m[3]
    const idMatch = attrs.match(/\bid\s*=\s*"([^"]*)"/i)
    const headingText = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    heads.push({ level: Number(m[1]), anchor: idMatch ? idMatch[1] : null, heading: headingText, start: m.index, end: re.lastIndex })
  }
  const out = []
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]
    const stop = i + 1 < heads.length ? heads[i + 1].start : html.length
    const body = html.slice(h.end, stop)
    const text = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    out.push({ level: h.level, anchor: h.anchor, heading: h.heading, textLen: text.length, textHead: text.slice(0, 80) })
  }
  return { heads, sections: out }
}

console.log('阶段 0.1 · Wiktenauer section anchor 探针\n')

const report = []
for (const [kind, page] of PAGES) {
  console.log('='.repeat(78))
  console.log(`【${kind}】${page}`)
  const r = await api({
    action: 'parse', page, prop: 'sections|text|revid', redirects: '1',
  })
  if (!r.ok) { console.log(`  ✗ API 失败: ${r.error}\n`); report.push({ kind, page, ok: false, error: r.error }); continue }
  if (r.data?.error) { console.log(`  ✗ ${r.data.error.code}: ${r.data.error.info}\n`); report.push({ kind, page, ok: false, error: r.data.error.code }); continue }

  const p = r.data.parse
  const resolved = p.title ?? page
  const revid = p.revid
  const sectionsMeta = p.sections ?? []
  const html = p.text?.['*'] ?? ''

  console.log(`  真实标题: ${resolved}${resolved !== page ? '  (重定向)' : ''}`)
  console.log(`  revid: ${revid}`)
  console.log(`  prop=sections 返回: ${sectionsMeta.length} 节`)
  console.log(`  HTML 长度: ${html.length}`)

  const { heads, sections } = splitByAnchor(html)
  const withAnchor = heads.filter(h => h.anchor).length
  console.log(`  HTML 里的 heading: ${heads.length} 个，其中带 id 的: ${withAnchor}`)

  // Q1/Q2: section anchor 与 HTML id 是否对得上
  const metaAnchors = new Set(sectionsMeta.map(s => s.anchor).filter(Boolean))
  const htmlAnchors = new Set(heads.map(h => h.anchor).filter(Boolean))
  const overlap = [...metaAnchors].filter(a => htmlAnchors.has(a))
  console.log(`  API sections 的 anchor 数: ${metaAnchors.size}  |  HTML id 数: ${htmlAnchors.size}  |  交集: ${overlap.length}`)

  // Q3: 粒度
  const lens = sections.map(s => s.textLen).filter(n => n > 0)
  if (lens.length) {
    const sorted = [...lens].sort((a, b) => a - b)
    const med = sorted[Math.floor(sorted.length / 2)]
    console.log(`  切出 ${lens.length} 节正文；字数 min/中位/max = ${sorted[0]} / ${med} / ${sorted[sorted.length - 1]}`)
    console.log(`  超过 4000 字的节: ${lens.filter(n => n > 4000).length} 个`)
  }

  console.log('  前 6 节:')
  for (const s of sections.slice(0, 6)) {
    console.log(`    L${s.level} anchor=${String(s.anchor).padEnd(28)} ${String(s.heading).slice(0, 30).padEnd(32)} ${s.textLen}字`)
  }
  if (sections.length > 6) console.log(`    … 共 ${sections.length} 节`)

  // 展示 API section 元数据的字段
  if (sectionsMeta.length) {
    console.log(`  API section 字段示例: ${JSON.stringify(sectionsMeta[0])}`)
  }
  console.log()

  report.push({
    kind, page, ok: true, resolved, revid,
    apiSections: sectionsMeta.length,
    htmlHeadings: heads.length,
    htmlHeadingsWithId: withAnchor,
    anchorOverlap: overlap.length,
    slicedSections: sections.length,
    lenMin: lens.length ? Math.min(...lens) : null,
    lenMed: lens.length ? [...lens].sort((a, b) => a - b)[Math.floor(lens.length / 2)] : null,
    lenMax: lens.length ? Math.max(...lens) : null,
    over4000: lens.filter(n => n > 4000).length,
    sampleAnchors: sections.slice(0, 5).map(s => s.anchor),
  })
}

console.log('='.repeat(78))
console.log('汇总')
console.log('类型    页面                                  API节  HTML-id  交集  切出节  min/中位/max        超4000')
for (const x of report) {
  if (!x.ok) { console.log(`${x.kind.padEnd(6)} ${x.page.padEnd(38)} ✗ ${x.error}`); continue }
  console.log(
    `${x.kind.padEnd(6)} ${String(x.resolved).slice(0, 38).padEnd(38)} ${String(x.apiSections).padStart(5)} ${String(x.htmlHeadingsWithId).padStart(7)} ${String(x.anchorOverlap).padStart(5)} ${String(x.slicedSections).padStart(6)}  ${String(x.lenMin).padStart(6)}/${String(x.lenMed).padStart(6)}/${String(x.lenMax).padStart(7)}  ${String(x.over4000).padStart(6)}`,
  )
}

const { writeFileSync } = await import('node:fs')
writeFileSync(new URL('./probe-sections-result.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8')
console.log('\n结果已写入 probe-sections-result.json')
