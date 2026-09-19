/**
 * 阶段 1a/1b 自测：wikitext+byteoffset 切节 → 定位符 → 解引用 → 选段拼 state
 */
import { fetchPage, dereference, makeLocator, selectParagraphs } from '../lib/wiki.mjs'

const line = (s = '') => console.log(s)
const bar = (t) => line(`\n${'='.repeat(74)}\n${t}`)

// ── 1. 取页 + 切节 ──
for (const [kind, title] of [['技术页', 'Zornhaw'], ['薄页', 'Indes'], ['手稿页', 'Codex Ringeck (MS Dresd.C.487)']]) {
  bar(`取页：${kind} / ${title}`)
  try {
    const doc = await fetchPage(title)
    line(`真实标题: ${doc.title}`)
    line(`revid: ${doc.revid}`)
    line(`节数: ${doc.sections.length}   导言: ${doc.lead ? doc.lead.textLen + '字' : '无'}`)
    for (const s of doc.sections.slice(0, 6)) {
      line(`  #${String(s.index).padStart(2)} L${s.level} @${String(s.byteOffset).padStart(7)}  ${String(s.anchor).padEnd(26)} ${s.textLen}字 ${s.paragraphs.length}段  「${s.heading.slice(0, 24)}」`)
    }
    if (doc.sections.length > 6) line(`  … 共 ${doc.sections.length} 节`)
    const total = doc.sections.reduce((a, s) => a + s.textLen, 0)
    line(`  节内正文合计: ${total} 字`)
  } catch (e) {
    line(`  ✗ ${e.message}`)
  }
}

// ── 2. 定位符 → 解引用 ──
bar('定位符解引用')
const doc = await fetchPage('Zornhaw')
const target = doc.sections.find(s => s.textLen > 2000) ?? doc.sections[0]
const loc = makeLocator({ page: doc.title, anchor: target.anchor, revid: doc.revid })
line(`定位符: ${JSON.stringify(loc)}`)
line(`目标节: 「${target.heading}」 ${target.textLen}字 ${target.paragraphs.length}段`)

const d = await dereference(loc)
line(`解引用: ok=${d.ok}${d.ok ? '' : '  reason=' + d.reason}`)
if (d.ok) {
  line(`  取回 ${d.text.length} 字 / ${d.paragraphs.length} 段`)
  line(`  首段: ${d.paragraphs[0]?.slice(0, 120) ?? '(无)'}`)
}

// ── 3. 选段（主路径：节太大时必须做）──
bar('选段（按断言挑最相关段落，中心窗口扩展）')
for (const claim of [
  'Ringeck 描述怒击用于回应对手上段斩',
  'Zornhau is a strike that breaks the guard of the opponent',
  '怒击从右肩斜劈而下',
]) {
  const sel = selectParagraphs(d.paragraphs, claim, {
    pageTitle: d.page, heading: d.heading, maxChars: 4000, maxParas: 10,
  })
  line(`\n断言: ${claim}`)
  line(`  策略=${sel.strategy} 选中 ${sel.selected.length} 段 / ${sel.chars} 字（原 ${d.text.length} → ${(sel.chars / Math.max(d.text.length, 1) * 100).toFixed(1)}%）`)
  line(`  停用词 ${sel.stoplistSize} 个（来自页/节标题），实际用词 ${sel.usedWords} 个，标签行 ${sel.labelCount} 个`)
  for (const [i, p] of sel.selected.slice(0, 4).entries()) line(`    [${i + 1}] ${p.slice(0, 160)}`)
}

// ── 4. anchor=null（薄页）──
bar('anchor=null 整页路径')
const indesDoc = await fetchPage('Indes')
const dl = await dereference(makeLocator({ page: 'Indes', anchor: null, revid: indesDoc.revid }))
line(`Indes: ok=${dl.ok} wholePage=${dl.wholePage ?? false} ${dl.text?.length ?? 0}字`)

// ── 5. 错误路径 ──
bar('错误路径')
const e1 = await dereference(makeLocator({ page: 'Zornhaw', anchor: 'NoSuchAnchor', revid: doc.revid }))
line(`不存在的 anchor: ok=${e1.ok} reason=${e1.reason}`)
line(`  可用 anchor: ${(e1.availableAnchors ?? []).join(' | ')}`)

const e2 = await dereference(makeLocator({ page: 'Zornhaw', anchor: target.anchor, revid: 999999999 }))
line(`错误的 revid:    ok=${e2.ok} reason=${String(e2.reason).slice(0, 60)}`)

const e3 = await dereference(makeLocator({ page: 'This Page Does Not Exist At All', anchor: null }))
line(`不存在的页面:    ok=${e3.ok} reason=${String(e3.reason).slice(0, 60)}`)

// ── 6. 拼 JEV state 的样子 ──
bar('拼出的 JEV state 长什么样')
const state = [
  `【原子命题】Zornhau 是对 Oberhau 的反击吗？`,
  `【断言】Ringeck 描述怒击用于回应对手上段斩`,
  `【来源】${loc.page}  revid=${loc.revid}  节「${d.heading}」`,
  ``,
  `【证据文本】`,
  (selectParagraphs(d.paragraphs, 'Ringeck 描述怒击用于回应对手上段斩', { pageTitle: d.page, heading: d.heading }).selected.join('\n\n')),
].join('\n')
line(`state 长度: ${state.length} 字`)
line('--- 前 600 字 ---')
line(state.slice(0, 600))
