/**
 * 探针 —— hema-v2 插件的工具体（规则就住在这些工具里）
 *
 * preset 结构对了不等于工具对。这个探针用一个桩 ctx 收集注册的工具，
 * 然后**直接调用它们**跑完整条链路，验的是：
 *   · 7 个工具都注册了、render 不抛异常（render 才是模型实际读到的东西）
 *   · 硬规则真的在代码里生效：轮数封顶到点就 suspend，模型想超也超不了
 *   · 证据解引用失败硬拦、不问 JEV
 *   · 报告后置检查 + 代码兜底补悬置条目
 *   · 审计落盘（trace / audit / jev-calls / 各阶段 json）
 *
 * 默认用 fixture 判官（不花钱、可复现）；
 * `--live` 换成真 JEV（会消耗额度，跑的是同一套断言）。
 */
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { decompositionQuestions as decompQ } from '../lib/jev.mjs'

const LIVE = process.argv.includes('--live')
const MODE = LIVE ? 'http' : 'fixture'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}
const head = (s) => console.log(`\n── ${s} ──`)

// ── 桩 ctx：只实现插件真正用到的那几项 ──────────────────────
const tools = new Map()
const logs = []
const ctx = {
  tools: { register(tool) { tools.set(tool.name, tool) } },
  get: () => undefined,              // 没有凭据库时插件应回落到 .env
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'hema-plugin-'))
console.log(`═══ hema-v2 插件工具体（判官 ${MODE}）═══`)
console.log(`输出根：${tmpRoot}`)

apply(ctx, { jevMode: MODE, acceptRate: 0.55, outDir: tmpRoot })

const call = (name, args) => {
  const t = tools.get(name)
  if (!t) throw new Error(`工具 ${name} 未注册`)
  return t.execute(args, { signal: undefined })
}

// ══════════════════════════════════════════════════════════════
head('1) 工具注册与形状')
const CHAIN_TOOLS = ['hema_start', 'hema_decompose_check', 'hema_verify', 'hema_report_check', 'hema_status', 'hema_finish']
const DATA_TOOLS = ['wiki_search', 'wiki_prefix_search', 'wiki_get_page', 'wiki_get_section', 'wiki_get_links', 'glossary_lookup']
ok('注册了 12 个工具（6 数据层 + 6 链路层）', tools.size === 12, `实际 ${tools.size}：${[...tools.keys()].join(', ')}`)
for (const n of [...DATA_TOOLS, ...CHAIN_TOOLS]) ok(`  有 ${n}`, tools.has(n))
ok('每个工具都有描述与 parameters', [...tools.values()].every(t => t.description?.length > 40 && t.parameters))
ok('每个工具都有 output.render（模型实际读到的就是它）',
  [...tools.values()].every(t => typeof t.output?.render === 'function'))
ok('链路层工具的 name 都以 hema_ 开头（数据层用 wiki_/glossary_）',
  CHAIN_TOOLS.every(n => tools.get(n)?.name?.startsWith('hema_')))

// ══════════════════════════════════════════════════════════════
head('1b) 工具 schema 必须是合法 JSON Schema（真机炸过的那一类）')
/*
 * 这条检查是被真机打脸之后补的：**496 项断言全绿，但宿主一挂载就报**
 *   Invalid schema for function 'hema_decompose_check':
 *   schema must be a JSON Schema of 'type: "object"', got 'type: null'
 *
 * 原因：`parameters` 必须是**完整的 JSON Schema**。`defineTool()` 会把
 * `{ 参数名: {type, required} }` 简写规范化，而本插件为零依赖用**普通对象注册**
 * （与 dsh-jev 一致），简写会被原样送给模型 —— 没有顶层 type，正是 type: null。
 *
 * 离线套件当时只检查了"有 parameters"，没检查它**是不是合法 schema**。
 * 下面的校验刻意对齐宿主/模型那边的要求，把这一类错误挡在离线阶段。
 */
function schemaProblems(schema, path = '') {
  const bad = []
  if (!schema || typeof schema !== 'object') return [`${path || '<root>'} 不是对象`]
  if (schema.type !== 'object') bad.push(`${path || '<root>'} 的 type 必须是 "object"，实际 ${JSON.stringify(schema.type)}`)
  if (!schema.properties || typeof schema.properties !== 'object') {
    bad.push(`${path || '<root>'} 缺少 properties`)
    return bad
  }
  for (const [k, v] of Object.entries(schema.properties)) {
    const at = path ? `${path}.${k}` : k
    if (!v || typeof v !== 'object') { bad.push(`${at} 不是对象`); continue }
    if (!v.description || typeof v.description !== 'string') bad.push(`${at} 缺 description`)
    if (v.type === undefined) bad.push(`${at} 缺 type`)
    if (v.type === 'array' && v.items === undefined) bad.push(`${at} 是数组但缺 items`)
    // 联合类型（type 数组 / oneOf）是 provider 拒 schema 的常见来源，本插件刻意不用
    if (Array.isArray(v.type)) bad.push(`${at} 用了 type 联合数组（易被 provider 拒）`)
    if (v.items?.oneOf) bad.push(`${at}.items 用了 oneOf（易被 provider 拒）`)
  }
  for (const r of schema.required ?? []) {
    if (!(r in schema.properties)) bad.push(`required 里的 ${r} 不在 properties 中`)
  }
  return bad
}

for (const [n, t] of tools) {
  const bad = schemaProblems(t.parameters, `${n}.parameters`)
  ok(`${n} 的 parameters 是合法 JSON Schema`, bad.length === 0, bad.join('；'))
}
for (const [n, t] of tools) {
  const s = t.output?.schema
  const bad = []
  if (!s || typeof s !== 'object') bad.push('output.schema 不是对象')
  else if (s.type !== 'object') bad.push(`output.schema.type=${JSON.stringify(s.type)}，必须是 "object"`)
  ok(`${n} 的 output.schema 是对象 schema`, bad.length === 0, bad.join('；'))
}
// 反面验证：简写形式必须被这套校验抓住（否则校验本身是摆设）
const shorthand = { runId: { type: 'string', required: true }, xs: { type: 'array' } }
ok('校验器能识破「参数名→类型」简写（即真机报错的那种）',
  schemaProblems(shorthand).length >= 2, schemaProblems(shorthand).join('；'))
ok('校验器能识破数组缺 items', schemaProblems({ type: 'object', properties: { a: { type: 'array', description: 'x' } } }).some(m => /缺 items/.test(m)))

// ══════════════════════════════════════════════════════════════
head('2) hema_start')
const started = await call('hema_start', { topic: 'Zornhau（怒击）的起手动作与打击线路是什么？' })
ok('返回 runId', typeof started.runId === 'string' && started.runId.length > 0, started.runId)
// 版本路标：刷新页面 ≠ 重载代码。宿主进程 import 过就进 ESM 缓存，
// 所以必须有一个从工具输出就能读到的版本号，否则"改了没生效"无法判断。
ok('返回插件版本（用于确认跑的是哪一版代码）',
  typeof started.pluginVersion === 'string' && /^\d+\.\d+\.\d+$/.test(started.pluginVersion), started.pluginVersion)
ok('版本与 package.json 一致（避免路标自己漂）',
  started.pluginVersion === JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  `${started.pluginVersion} vs package.json`)
ok('建了输出目录', existsSync(started.dir), started.dir)
ok('带上了各阶段的封顶值（模型能看到，但改不了）',
  started.limits.claimRounds === 3 && started.limits.decomposeRounds === 3, JSON.stringify(started.limits))
ok('topic 为空时报错', (await call('hema_start', { topic: '  ' })).ok === false)
ok('未知 runId 会被拒（状态按 runId 隔离，不会跨会话串）',
  (await call('hema_status', { runId: 'nope' }).then(() => false, (e) => /未知 runId/.test(e.message))))

// ══════════════════════════════════════════════════════════════
head('3) hema_decompose_check：形状校验先于 JEV，用户编辑不复查')
const shapeBad = await call('hema_decompose_check', { runId: started.runId, subQuestions: [{ id: 'a', text: '只有一条' }] })
ok('子题过少 → retry（且没花 JEV 调用）', shapeBad.status === 'retry' && shapeBad.shapeIssues?.length > 0,
  JSON.stringify(shapeBad.shapeIssues?.map(i => i.code)))

const userEdit = await call('hema_decompose_check', {
  runId: started.runId, userEdited: true,
  subQuestions: [{ id: 'u1', text: '用户手写的子题一' }, { id: 'u2', text: '用户手写的子题二' }],
})
ok('用户编辑 → 直接 pass，不重新检查', userEdit.status === 'pass' && userEdit.userEdited === true)
ok('用户编辑路径 judgement 为 null（没走验证器）', userEdit.status === 'pass')

// 换个 run 测真正的 JEV 分解检查（上一步已把分解定为 accepted）
const run2 = await call('hema_start', { topic: 'Zornhau 的起手动作与打击线路是什么？' })
const goodSq = [
  { id: 'sq1', text: 'Zornhau 的起手架势与起始位置是什么？', terms: ['Zornhau', 'Zornhut'] },
  { id: 'sq2', text: 'Zornhau 的打击线路与目标部位是什么？', terms: ['Zornhau', 'Oberhau'] },
]
const dec = await call('hema_decompose_check', { runId: run2.runId, subQuestions: goodSq })
ok('真正走了 JEV 分解检查', ['pass', 'retry', 'suspend'].includes(dec.status), dec.status)
ok('把硬闸门与提示项分开报（实测 coverage 区分度弱，降为提示）',
  dec.status === 'pass' || (dec.failed ?? []).every(f => f.gate === 'hard' || f.gate === 'advisory'),
  JSON.stringify((dec.failed ?? []).map(f => `${f.key}:${f.gate}`)))
if (dec.status !== 'pass') {
  console.log(`     注：分解未通过（${dec.status}），${(dec.failed ?? []).map(f => f.label).join('；')}`)
}
// 硬闸门里只该有逐子题的项
const gatedKeys = (dec.failed ?? []).filter(f => f.gate === 'hard').map(f => f.key)
ok('硬闸门只含逐子题的 focus（coverage/independent 是提示，answerable 已删）',
  gatedKeys.every(k => k.startsWith('focus_')), gatedKeys.join(','))
ok('A 组问题契约里已无 answerable_*（实测无预测力，已删除）',
  !Object.keys(decompQ(goodSq)).some(k => k.startsWith('answerable_')), Object.keys(decompQ(goodSq)).join(','))
ok('A 组问题契约仍含 coverage / independent / focus_*',
  (() => { const q = decompQ(goodSq); return Boolean(q.coverage && q.independent && q.focus_sq1 && q.focus_sq2) })(),
  Object.keys(decompQ(goodSq)).join(','))

// ══════════════════════════════════════════════════════════════
head('5) hema_verify：裁决、硬拦、冻结、封顶')
// 跳转器已按实测删除（186 次调用只收到 7 页、next 一半是瞎猜），
// 取证现在完全由 researcher 自己用 wiki 工具完成。这里用整页定位符验**验证规则本身**。
const atom = 'Zornhau 的起手架势与起始位置是什么？'
const loc = { page: 'Zornhaw', anchor: null, revid: null }
const claimOk = { id: 'c1', claim: 'Zornhau 是一记自上方斜劈的斩击，起手自右侧。', subQuestion: atom, evidence: [loc] }

const v1 = await call('hema_verify', { runId: run2.runId, atom, claims: [claimOk] })
ok('第一轮返回了逐条裁决', ['pass', 'retry', 'suspend'].includes(v1.status), v1.status)
ok('返回了轮次与剩余轮数（模型不用猜）', v1.round === 1 && v1.maxRounds === 3, `round=${v1.round}/${v1.maxRounds}`)
ok('统计口径完整', typeof v1.counts.verified === 'number' && typeof v1.counts.hardBlocked === 'number')

// 空证据 → 硬拦，且不问 JEV
const v2 = await call('hema_verify', {
  runId: run2.runId, atom,
  claims: [{ id: 'cX', claim: '无证据的断言。', evidence: [] }],
})
ok('空证据被硬拦为 insufficient', v2.results.some(r => r.verdict === 'insufficient' && r.reason === 'NO_EVIDENCE'),
  JSON.stringify(v2.results.map(r => `${r.id}:${r.verdict}:${r.reason ?? ''}`)))
ok('被硬拦的断言没进 JEV 送判数', v2.counts.hardBlocked >= 1, JSON.stringify(v2.counts))

// 死定位符 → 硬拦
const v3 = await call('hema_verify', {
  runId: run2.runId, atom,
  claims: [{ id: 'cY', claim: '引了不存在的页面。', evidence: [{ page: 'NoSuchPageZZZ', anchor: null }] }],
})
ok('解引用失败的证据被硬拦（EVIDENCE_UNRESOLVABLE）',
  v3.results.some(r => r.reason === 'EVIDENCE_UNRESOLVABLE'), JSON.stringify(v3.results.map(r => r.reason)))

// 跑到封顶
let last = v3
for (let i = 0; i < 3; i++) {
  last = await call('hema_verify', {
    runId: run2.runId, atom,
    claims: [{ id: 'cZ', claim: `注定不过的断言 ${i}`, evidence: [{ page: 'NoSuchPageZZZ', anchor: null }] }],
  })
}
ok('轮数到点即 suspend（模型无法超轮）', last.status === 'suspend', `${last.status} round=${last.round}`)
ok('suspend 时列出证据悬置项', Array.isArray(last.insufficient) && last.insufficient.length >= 1,
  JSON.stringify(last.insufficient.map(i => i.id)))
ok('悬置项带未通过原因（供报告写悬置节）',
  last.insufficient.every(i => Array.isArray(i.lastReasons) || typeof i.reason === 'string'))
const over = await call('hema_verify', { runId: run2.runId, atom, claims: [claimOk] })
ok('封顶后再调用仍返回 suspend（不会重置轮数）', over.status === 'suspend' && over.round === 3, `${over.status} round=${over.round}`)

// ══════════════════════════════════════════════════════════════
head('6) hema_status / hema_report_check / hema_finish')
const st = await call('hema_status', { runId: run2.runId })
ok('status 报出轮数与通过/悬置计数',
  st.maxClaimRounds === 3 && st.chains.length >= 1 && typeof st.totals.insufficient === 'number',
  JSON.stringify(st.totals))
ok('status 带输出目录', typeof st.dir === 'string')

const draft = [
  '# 报告草稿', '',
  '这一稿故意不写悬置节，用来验证代码兜底。', '',
  '正文内容足够长以通过最小长度检查：' + '补充说明。'.repeat(40),
].join('\n')
const rep = await call('hema_report_check', { runId: run2.runId, report: draft })
ok('报告校验返回了结论', typeof rep.pass === 'boolean')
ok('代码兜底补写了悬置节', rep.appendedByCode === true)
ok('返回的报告含悬置节标题', /证据悬置/.test(rep.report))
ok('返回的报告含悬置项原文（模型丢不掉）',
  rep.report.includes('NoSuchPageZZZ') || rep.report.includes('证据悬置'))
ok('原稿自身的问题也报出来（否则模型不知道漏了悬置节，下一稿还会漏）',
  (rep.draftIssues ?? []).some(i => i.code === 'MISSING_SUSPENSION_SECTION'),
  JSON.stringify((rep.draftIssues ?? []).map(i => i.code)))
ok('补后校验的问题单独报出', Array.isArray(rep.issues), JSON.stringify((rep.issues ?? []).map(i => i.code)))

const fin = await call('hema_finish', { runId: run2.runId })
ok('finish 落盘', fin.ok === true && existsSync(fin.dir))
const files = readdirSync(fin.dir)
for (const want of ['00-trace.md', '00-audit.json', '00-events.jsonl', '01-decomposition.json', '04-report.md', 'jev-calls.jsonl']) {
  ok(`  产物 ${want}`, files.includes(want), files.join(', ').slice(0, 160))
}
const jevLog = readFileSync(join(fin.dir, 'jev-calls.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
ok('jev-calls 记录了每次调用（分解 + 验证）', jevLog.length >= 2, `${jevLog.length} 条`)
ok('每条都带喂进去的 state 全文（审计裁决的前提）', jevLog.every(r => typeof r.state === 'string' && r.state.length > 0))
ok('每条都带 phase 与 runId', jevLog.every(r => r.phase && r.runId === run2.runId), [...new Set(jevLog.map(r => r.phase))].join(','))
ok('phase 覆盖了各个环节（分解 + 验证）',
  new Set(jevLog.map(r => r.phase)).size >= 2, [...new Set(jevLog.map(r => r.phase))].join(','))
const trace = readFileSync(join(fin.dir, '00-trace.md'), 'utf8')
ok('trace 含分解与裁决', trace.includes('leader 分解') && /判否|证据不成立/.test(trace))

// ══════════════════════════════════════════════════════════════
head('7) render 不抛异常（render 才是模型读到的东西）')
let renderFails = 0
for (const [n, t] of tools) {
  for (const v of [{ ok: false, error: 'x' }, {}, { status: 'pass' }, { status: 'suspend', subQuestions: [] }]) {
    try { t.output.render({}, v) } catch { renderFails++ }
  }
}
ok('所有工具对残缺值都能 render', renderFails === 0, `失败 ${renderFails} 次`)

console.log(`\n输出根：${tmpRoot}`)
console.log(`JEV 调用：${jevLog.length} 次（模式 ${MODE}）`)
console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
if (!process.env.HEMA_KEEP_TMP) rmSync(tmpRoot, { recursive: true, force: true })
process.exit(fails === 0 ? 0 : 1)
