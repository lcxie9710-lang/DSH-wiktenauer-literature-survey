/**
 * 让 preset roster **自己**判断我们装的 preset 能不能挂载。
 *
 * 为什么不能用"目录存在"代替：目录存在只说明会被发现，不说明**行能解析**。
 * 行解析失败时 preset 会变成不可选、不可复制（roster 的原话是 "worse than
 * reporting the same stale row at mount time"），而那种失败只在宿主启动时才暴露。
 *
 * `scanRoot` 是 `@deepseek-ai/dsh-agent-presets` 导出的，它会读每个 preset 目录、
 * 逐行尝试解析 `name`，把失败原因放进 `broken`。这里直接调它 —— 用 roster 的实现
 * 验证我们自己的产物，而不是我自己写一套差不多就算过。
 *
 * 用法：node packages/dsh-hema-v2/preset/verify-mount.mjs [--profile web]
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const profile = arg('profile', 'web')
const profileDir = join(dshHome, 'profiles', profile)
const presetRoot = join(dshHome, '.agent-presets')

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}

/** 在已安装构建里找 dsh-agent-presets */
function findPresetsPkg() {
  const cands = []
  const npmCache = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx')
  if (existsSync(npmCache)) {
    for (const entry of readdirSync(npmCache)) {
      cands.push(join(npmCache, entry, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'lib', 'index.js'))
    }
  }
  cands.push(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'lib', 'index.js'))
  cands.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'lib', 'index.js'))
  return cands.find(c => existsSync(c))
}

const pkgPath = findPresetsPkg()
console.log(`DSH_HOME     : ${dshHome}`)
console.log(`profile      : ${profile}`)
console.log(`preset 根目录 : ${presetRoot}`)
console.log(`roster 实现   : ${pkgPath ?? '(未找到)'}\n`)

if (!pkgPath) { console.error('找不到 dsh-agent-presets，无法验证'); process.exit(2) }

const mod = await import(pathToFileURL(pkgPath).href)
const scanRoot = mod.scanRoot ?? mod.default?.scanRoot
if (typeof scanRoot !== 'function') {
  console.error('导出的 scanRoot 不是函数，无法验证')
  process.exit(2)
}

ok('preset 根目录存在', existsSync(presetRoot), presetRoot)

// harnessBase：包名从这里解析。宿主跑的是 web profile，所以解析基准是它。
const roots = [
  { path: presetRoot, trust: 'user' },
]

let entries = []
for (const root of roots) {
  const found = await scanRoot(root, pathToFileURL(`${profileDir}/`))
  entries = entries.concat(found.map(e => ({ ...e, rootPath: root.path })))
}

console.log(`\nroster 扫到 ${entries.length} 个 preset：`)
for (const e of entries) {
  const flag = e.broken ? '❌ broken' : '✔'
  console.log(`  ${flag}  ${e.id.padEnd(20)} ${e.name ?? '(无显示名)'}${e.broken ? `\n        ${e.broken}` : ''}`)
}

console.log('')
const mine = entries.find(e => e.id === 'hema-v2')
if (!mine) {
  // 没装不等于错：这个脚本是"装完之后验证装对了"，不是"必须装"。
  // 未安装时如实说明并放行，免得回归套件在干净环境里误报。
  console.log('  --  hema-v2 尚未安装（跳过；先跑 node sync-preset.mjs && node install.mjs）')
  console.log('\nPASS：未安装，跳过挂载验证')
  process.exit(0)
}
ok('roster 发现了 hema-v2', true)
ok('hema-v2 未被判为 broken（行都能解析）', mine.broken === undefined, mine.broken ?? '')
ok('有显示名（选择器里能看到）', typeof mine.name === 'string' && mine.name !== '', JSON.stringify(mine.name))
ok('有描述', typeof mine.description === 'string' && mine.description !== '')
ok('有 order（排序用）', typeof mine.order === 'number', JSON.stringify(mine.order))
ok('指向的 composition 文件存在', existsSync(mine.path), mine.path)

// 顺带确认 web profile 能解析插件包（否则挂载时才炸）
const linkPath = join(profileDir, 'node_modules', '@ghogiel', 'dsh-hema-v2')
ok('插件包已 junction 进 web profile', existsSync(linkPath), linkPath)
ok('插件入口存在（lib/main 指向的文件真的在）', existsSync(join(linkPath, 'index.js')), join(linkPath, 'index.js'))

console.log(`\n${fails === 0 ? 'PASS：preset 可挂载' : `FAIL：${fails} 项`}`)
process.exit(fails === 0 ? 0 : 1)
