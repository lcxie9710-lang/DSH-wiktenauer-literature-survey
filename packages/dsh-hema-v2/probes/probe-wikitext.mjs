import { fetchPage } from '../lib/wiki.mjs'

const doc = await fetchPage('Zornhaw')
for (const s of doc.sections.slice(0, 3)) {
  console.log('='.repeat(74))
  console.log(`节「${s.heading}」 anchor=${s.anchor} wikitext ${s.wikitext.length} 字节, 清理后 ${s.textLen} 字`)
  console.log('--- wikitext 前 1200 字符 ---')
  console.log(s.wikitext.slice(0, 1200))
  console.log('--- 清理后前 500 字 ---')
  console.log(s.text.slice(0, 500))
  console.log()
}

// 统计：wikitext 里各种结构占多少
console.log('='.repeat(74))
console.log('全页 wikitext 结构统计')
const full = await fetchPage('Zornhaw')
const all = full.sections.map(s => s.wikitext).join('\n')
const count = (re) => (all.match(re) ?? []).length
console.log(`  {| 表格开始:      ${count(/\{\|/g)}`)
console.log(`  |} 表格结束:      ${count(/\|\}/g)}`)
console.log(`  <table 标签:      ${count(/<table/gi)}`)
console.log(`  </table>:         ${count(/<\/table>/gi)}`)
console.log(`  { 模板开始:       ${count(/\{\{/g)}`)
console.log(`  |- 表格行:        ${count(/^\s*\|-/gm)}`)
console.log(`  ! 表头行:         ${count(/^\s*!/gm)}`)
console.log(`  | 单元格行:       ${count(/^\s*\|/gm)}`)
console.log(`  总字节:           ${all.length}`)

// Indes 到底有什么
console.log()
console.log('='.repeat(74))
console.log('Indes 的原始 wikitext')
const indes = await fetchPage('Indes')
console.log(`  节数 ${indes.sections.length}, flat ${indes.flat.length} 字`)
try {
  const { api } = await import('../lib/wiki.mjs')
  const d = await api({ action: 'parse', page: 'Indes', prop: 'wikitext', redirects: '1' }, { cacheName: 'page' })
  console.log('  原始 wikitext:')
  console.log('  ' + String(d?.parse?.wikitext?.['*'] ?? '(空)').slice(0, 800).replace(/\n/g, '\n  '))
} catch (e) { console.log('  ✗ ' + e.message) }
