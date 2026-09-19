/**
 * 验证生成的 `hema-v2` preset —— 在安装前先挡住结构性错误。
 *
 * 为什么值得单独写：preset 的错误**只在挂载时才炸**，而且报的是很难看懂的 loader 错。
 * 这里把能在安装前查的都查掉：两份文件能按 roster 读法解析、追加的行确实存在且启用、
 * 与 standard 的差异恰好是我们追加的那几行（顺序不变、无重复 id）。
 *
 * 用法：node verify-preset.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks++
  if (condition) { console.log(`  ok   ${label}`); return true }
  failures++
  console.log(`  FAIL ${label}${detail === undefined ? '' : `  — ${detail}`}`)
  return false
}

/** 从已安装的 profile 里借 js-yaml（它本来就依赖它），不为此装新包 */
async function loadYaml() {
  const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  const candidates = [
    join(dshHome, 'profiles', 'node_modules', 'js-yaml', 'index.js'),
    join(dshHome, 'profiles', 'web', 'node_modules', 'js-yaml', 'index.js'),
    join(import.meta.dirname, '..', '..', '..', 'dsh-wiktenauer', 'node_modules', 'js-yaml', 'index.js'),
  ]
  const found = candidates.find(c => existsSync(c))
  if (found === undefined) return undefined
  const mod = await import(pathToFileURL(found).href)
  return mod.default ?? mod
}

function shippedStandardCandidates() {
  const candidates = []
  const npmCache = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx')
  if (existsSync(npmCache)) {
    for (const entry of readdirSync(npmCache)) {
      candidates.push(join(npmCache, entry, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'))
    }
  }
  const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  candidates.push(join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'))
  return candidates
}

const yaml = await loadYaml()
if (yaml === undefined) {
  console.error('在已安装的 profile 里找不到 js-yaml，无法验证 preset')
  process.exit(2)
}

/** 解析 composition：`!!js` 标量交给 loader 求值，这里只当不透明文本 */
function parse(text) {
  const jsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: v => v })
  return yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([jsTag]) })
}

const here = import.meta.dirname
const presetPath = join(here, 'hema-v2', 'preset.yml')
const compositionPath = join(here, 'hema-v2', 'agent.cordis.yml')

console.log('1. preset.yml')
const preset = parse(readFileSync(presetPath, 'utf8'))
check('解析为映射', typeof preset === 'object' && preset !== null && !Array.isArray(preset))
check('有显示名', typeof preset?.name === 'string' && preset.name !== '', JSON.stringify(preset?.name))
check('有描述', typeof preset?.description === 'string' && preset.description !== '')
check('有 order', typeof preset?.order === 'number', JSON.stringify(preset?.order))

console.log('\n2. agent.cordis.yml')
const rows = parse(readFileSync(compositionPath, 'utf8'))
check('解析为顶层行数组', Array.isArray(rows), typeof rows)
check('每行都是有字符串 name 的对象',
  Array.isArray(rows) && rows.every(r => typeof r?.name === 'string' && r.name !== ''),
  '无名行会被 roster 判为损坏')

const allRows = Array.isArray(rows) ? rows : []
const byId = new Map()
const dupIds = []
for (const r of allRows) {
  if (r?.id === undefined) continue
  if (byId.has(r.id)) dupIds.push(r.id)
  byId.set(r.id, r)
}
check('没有重复 id（重复 = 后写覆盖前写，静默失效）', dupIds.length === 0, dupIds.join(', '))

console.log('\n3. 本 preset 存在的理由：追加的行')
const hemaRow = byId.get('hema-v2')
check('有 hema-v2 行', hemaRow !== undefined)
check('hema-v2 指向本包', hemaRow?.name === '@ghogiel/dsh-hema-v2', JSON.stringify(hemaRow?.name))
check('hema-v2 已启用', hemaRow?.disabled === undefined, JSON.stringify(hemaRow?.disabled))
check('hema-v2 的判官模式是 http（要真 JEV）', hemaRow?.config?.jevMode === 'http', JSON.stringify(hemaRow?.config))

/*
 * 数据访问层已并进 hema-v2 插件本身，所以 preset 里**不应再有** weinao 行。
 * 这里断言的是"不再引用它" —— 删掉一个包之后最该防的失效是它的行还留着，
 * 而那种失效只在挂载时报"找不到包"，离线测试看不出来。
 */
const weinaoRow = byId.get('weinao')
check('preset 里已无 weinao 行（数据层已并进 hema-v2）', weinaoRow === undefined,
  weinaoRow ? `仍存在，指向 ${weinaoRow.name}` : '')
check('preset 里没有任何 @ghogiel/dsh-weinao 引用',
  !allRows.some(r => typeof r?.name === 'string' && r.name === '@ghogiel/dsh-weinao'))

const resRow = byId.get('tool-hema-researcher')
check('有研究者角色行', resRow !== undefined)
check('研究者用 continuable（保住对话，别做完一次就释放）',
  resRow?.config?.backgroundMode === 'continuable', JSON.stringify(resRow?.config?.backgroundMode))
/*
 * maxDepth 的语义是**子代理自身的深度上限**，不是"还能再往下几层"：
 * 主会话的代理是 depth 0，它的子代理 attemptedDepth = 1。
 *
 * 早先这里断言的是 `maxDepth === 0`（本意"不许它再开子代理"），
 * 结果真机上三次 hema_researcher 调用全部报：
 *   Error: subagent depth 1 exceeds maxDepth 0
 * 我把自己的**误解**固化成了绿灯断言 —— 测试全过、功能全死。
 * 现在断言的是**行为要求**：能创建 depth 1，且不允许再往下。
 */
const mdRow = resRow?.config?.maxDepth
check('研究者 maxDepth = 1（能创建 depth 1，不允许再往下开）', mdRow === 1, JSON.stringify(mdRow))
check('研究者 maxDepth ≥ 1（=0 会让它根本创建不出来，本项目实测踩过）',
  typeof mdRow === 'number' && mdRow >= 1, `maxDepth=${JSON.stringify(mdRow)}`)
check('研究者带 persona', typeof resRow?.config?.persona === 'string' && resRow.config.persona.length > 40)
const allow = resRow?.config?.toolFilter?.allow
check('研究者有 toolFilter.allow 白名单', Array.isArray(allow) && allow.length > 0, JSON.stringify(allow))
for (const forbidden of ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash', 'web_search', 'web_fetch', 'subagent']) {
  check(`  白名单里没有 ${forbidden}`, !(allow ?? []).includes(forbidden))
}
for (const needed of ['wiki_search', 'wiki_get_page']) {
  check(`  白名单里有 ${needed}`, (allow ?? []).includes(needed))
}

console.log('\n4. 与已安装的 standard 对比')
const standardPath = shippedStandardCandidates().find(c => existsSync(c))
if (check('能找到已安装的 standard 供对比', standardPath !== undefined)) {
  const standard = parse(readFileSync(standardPath, 'utf8'))
  const added = 2   // hema-v2 行 + tool-hema-researcher 行（weinao 行已删除）
  check(`本 composition 恰好比 standard 多 ${added} 行（多了就是意外追加）`,
    allRows.length === standard.length + added, `${allRows.length} vs ${standard.length}+${added}`)
  check('standard 的每一行都原样保留且顺序不变',
    JSON.stringify(allRows.slice(0, standard.length).map(r => r.id)) === JSON.stringify(standard.map(r => r.id)))
}

console.log('\n5. 已安装的副本（若已装则必须与生成物一致）')
const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const installed = join(dshHome, '.agent-presets', 'hema-v2', 'agent.cordis.yml')
if (existsSync(installed)) {
  check('已安装副本与生成物逐字节一致',
    readFileSync(installed, 'utf8') === readFileSync(compositionPath, 'utf8'),
    '不一致说明装完之后又改了生成物，需要重跑 sync-preset.mjs')
} else {
  console.log('  --  尚未安装（跳过；node sync-preset.mjs 会装）')
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} 项通过`)
process.exit(failures === 0 ? 0 : 1)
