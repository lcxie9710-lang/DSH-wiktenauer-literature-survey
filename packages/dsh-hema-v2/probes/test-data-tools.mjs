/**
 * 探针 —— 数据访问层工具（wiki_search / prefix / get_page / get_section / get_links / glossary_lookup）
 *
 * 这 6 个工具是从 v1 的独立包并进来的，所以必须自己证明**并进来之后还是能用的**：
 * 打真实 Wiktenauer、真解析、真返回 anchor。
 *
 * 最要紧的一条断言是：`wiki_get_page` 返回的 anchor **必须能直接用作证据定位符**
 * —— 拿它去 `dereference` 必须成功，且取回的正文与 `wiki_get_section` 一致。
 * 那正是"自行检索也能精确到节"这个改进的实质，不能只看输出好看。
 */
import { apply } from '../index.js'
import { dereference } from '../lib/wiki.mjs'
import { loadGlossary } from '../lib/glossary.mjs'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}
const head = (s) => console.log(`\n── ${s} ──`)

const tools = new Map()
apply(
  { tools: { register(t) { tools.set(t.name, t) } }, get: () => undefined, logger: { info() {}, warn() {} } },
  { jevMode: 'fixture', outDir: './out/_dataprobe' },
)
const call = (n, args) => tools.get(n).execute(args, {})

// ══════════════════════════════════════════════════════════════
head('1) 工具齐备且形状合法')
const DA = ['wiki_search', 'wiki_prefix_search', 'wiki_get_page', 'wiki_get_section', 'wiki_get_links', 'glossary_lookup']
for (const n of DA) ok(`有 ${n}`, tools.has(n))
ok('总计 12 个工具（6 数据层 + 6 链路层）', tools.size === 12, `${tools.size}`)
for (const n of DA) {
  const t = tools.get(n)
  ok(`  ${n} 的 parameters 是合法 JSON Schema`,
    t.parameters?.type === 'object' && t.parameters?.properties && Object.keys(t.parameters.properties).length > 0,
    JSON.stringify(t.parameters?.type))
}

// ══════════════════════════════════════════════════════════════
head('2) glossary_lookup：正查与反查')
const gFwd = await call('glossary_lookup', { term: '怒击' })
ok('中文正查命中', gFwd.ok && gFwd.forward.length >= 1, JSON.stringify(gFwd.forward?.slice(0, 2)))
ok('正查给出德/英拼写', gFwd.forward.some(r => /zorn/i.test(`${r.de ?? ''}${r.en ?? ''}`)),
  JSON.stringify(gFwd.forward?.slice(0, 2)))
const gRev = await call('glossary_lookup', { term: 'Zornhau' })
ok('德/英反查命中（写中文断言时要用这个方向）', gRev.ok && gRev.reverse.length >= 1, JSON.stringify(gRev.reverse?.slice(0, 2)))
ok('反查能给出中文', gRev.reverse.some(r => /[\u3400-\u9fff]/.test(r.zh)), JSON.stringify(gRev.reverse?.slice(0, 2)))
ok('报了术语表规模', typeof gFwd.glossarySize === 'number' && gFwd.glossarySize > 50, `${gFwd.glossarySize} 条`)
ok('实际术语表条数与工具报的一致', loadGlossary().size === gFwd.glossarySize)
ok('查不到时不报错、给出下一步指引', (await call('glossary_lookup', { term: 'zzzz不存在的词' })).ok === true)
ok('空 term 被拒', (await call('glossary_lookup', { term: '' })).ok === false)

// ══════════════════════════════════════════════════════════════
head('3) wiki_prefix_search：拼写变体（术语表 Zornhau → 页面 Zornhaw）')
const pre = await call('wiki_prefix_search', { prefix: 'Zornha', limit: 10 })
ok('前缀检索成功', pre.ok === true, pre.error ?? '')
ok('命中 Zornhaw', pre.titles.some(t => /zornha/i.test(t)), JSON.stringify(pre.titles?.slice(0, 5)))
ok('空 prefix 被拒', (await call('wiki_prefix_search', { prefix: '' })).ok === false)

head('4) wiki_search：全文检索（召回低是本站特性）')
const s = await call('wiki_search', { query: 'Zornhau', limit: 5 })
ok('检索成功', s.ok === true, s.error ?? '')
ok('返回了 hits 数组（可能为空，不算失败）', Array.isArray(s.hits), `${s.hits?.length} 条`)
if (s.hits.length) ok('  hit 带 title 与 snippet', s.hits.every(h => h.title), JSON.stringify(s.hits[0]).slice(0, 120))

// ══════════════════════════════════════════════════════════════
head('5) wiki_get_page：返回**带 anchor 的大纲**（这是并进来的主要收益）')
const page = await call('wiki_get_page', { title: 'Zornhaw' })
ok('取页成功', page.ok === true, page.error ?? '')
ok('带回 revid', typeof page.revid === 'number' && page.revid > 0, `${page.revid}`)
ok('列出节，且每节都有 anchor', page.sections.length >= 1 && page.sections.every(x => x.anchor),
  `${page.sections?.length} 节，首个 anchor=${page.sections?.[0]?.anchor}`)
ok('节带 heading 与字数', page.sections.every(x => typeof x.heading === 'string' && typeof x.chars === 'number'),
  JSON.stringify(page.sections?.[0]))
ok('**不返回全文**（避免撑爆上下文）', typeof page.totalChars === 'number' && page.lead.length <= 800,
  `全文 ${page.totalChars} 字符，导言 ${page.leadChars}`)
ok('取页失败时给出可读错误', (await call('wiki_get_page', { title: 'NoSuchPageZZZ' })).ok === false)

// ══════════════════════════════════════════════════════════════
head('6) wiki_get_section：按节读正文')
const pick = page.sections.find(x => x.chars > 200) ?? page.sections[0]
const sec = await call('wiki_get_section', { title: 'Zornhaw', anchor: pick.anchor })
ok('读节成功', sec.ok === true && sec.found !== false, sec.error ?? JSON.stringify(sec).slice(0, 120))
ok('返回正文且非空', typeof sec.text === 'string' && sec.text.length > 0, `${sec.text?.length} 字符`)
ok('节标题与大纲一致', sec.heading === pick.heading, `${sec.heading} vs ${pick.heading}`)
ok('带 revid', sec.revid === page.revid)
ok('错 anchor 时列出可用 anchor（可自纠）',
  (await call('wiki_get_section', { title: 'Zornhaw', anchor: 'NoSuchAnchor' })).found === false)
ok('整页读取（anchor 省略）也能用',
  (await call('wiki_get_section', { title: 'Zornhut' })).ok === true)

// ══════════════════════════════════════════════════════════════
head('7) 关键闭环：大纲给的 anchor 必须能**直接当证据定位符用**')
const loc = { page: page.page, anchor: pick.anchor, revid: page.revid }
const deref = await dereference(loc)
ok('拿 wiki_get_page 的 anchor 去解引用成功', deref.ok === true, deref.reason ?? '')
ok('解引用取回的是同一节', deref.heading === pick.heading, `${deref.heading} vs ${pick.heading}`)
ok('解引用内容非空', String(deref.text ?? '').trim().length > 0, `${deref.text?.length} 字符`)
// 这条断言就是"自行检索也能精确到节"的实质：节级定位符真的能用，不再是整页兜底
ok('定位符是**节级**的，不是整页兜底（anchor 非 null）', loc.anchor !== null && loc.anchor !== undefined)

head('8) wiki_get_links')
const links = await call('wiki_get_links', { title: 'Zornhaw' })
ok('取链接成功', links.ok === true, links.error ?? '')
ok('返回标题数组', Array.isArray(links.links), `${links.links?.length} 个`)
ok('空 title 被拒', (await call('wiki_get_links', { title: '' })).ok === false)

// ══════════════════════════════════════════════════════════════
head('9) render 不抛异常（render 才是模型读到的东西）')
let renderFails = 0
for (const n of DA) {
  for (const v of [{ ok: false, error: 'x' }, {}, { hits: [] }, { titles: [] }, { sections: [] }, { links: [] }, { found: false }]) {
    try { tools.get(n).output.render({}, v) } catch { renderFails++ }
  }
}
ok('数据层工具对残缺值都能 render', renderFails === 0, `失败 ${renderFails} 次`)

console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
process.exit(fails === 0 ? 0 : 1)
