/**
 * 把插件包接进本机 DSH_HOME。**纯增量，不动既有东西**。
 *
 * 三件事，都是本机既有约定（照 `@ghogiel/dsh-weinao` / `dsh-jev` 的样子）：
 *   1. junction：`<DSH_HOME>/profiles/<profile>/node_modules/@ghogiel/dsh-hema-v2`
 *      → 本包目录。用 junction 而不是符号链接：Windows 上不需要管理员权限。
 *   2. `profiles/<profile>/package.json` 的 dependencies 里加 `link:` 条目。
 *      少了这一步，profile 的 pnpm 操作会把 junction 清掉。
 *   3. preset 目录拷进 `<DSH_HOME>/.agent-presets/hema-v2/`（由 sync-preset.mjs 做）。
 *
 * 用法：
 *   node install.mjs                 # 默认装到 web profile
 *   node install.mjs --profile web
 *   node install.mjs --dry-run
 *   node install.mjs --uninstall
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const DRY = argv.includes('--dry-run')
const UNINSTALL = argv.includes('--uninstall')

const PKG = '@ghogiel/dsh-hema-v2'
const [SCOPE, NAME] = PKG.split('/')
const PLUGIN_DIR = resolve(import.meta.dirname, '..')

const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const profile = arg('profile', 'web')
const profileDir = join(dshHome, 'profiles', profile)
const linkPath = join(profileDir, 'node_modules', SCOPE, NAME)
const pkgJsonPath = join(profileDir, 'package.json')

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}

console.log(`DSH_HOME   : ${dshHome}`)
console.log(`profile    : ${profile}`)
console.log(`插件目录   : ${PLUGIN_DIR}`)
console.log(`安装目标   : ${linkPath}`)
console.log(`dry-run    : ${DRY}\n`)

if (!existsSync(profileDir)) {
  console.error(`profile 目录不存在：${profileDir}`)
  process.exit(2)
}
if (!existsSync(join(PLUGIN_DIR, 'package.json'))) {
  console.error(`插件目录里没有 package.json：${PLUGIN_DIR}`)
  process.exit(2)
}

// ── 卸载 ────────────────────────────────────────────────────
if (UNINSTALL) {
  if (!DRY && existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true })
  console.log(`已移除 junction${DRY ? '（dry-run）' : ''}`)
  console.log('注意：package.json 的 link 依赖与 .agent-presets/hema-v2 需手工清理（脚本不擅自改你的依赖表）')
  process.exit(0)
}

// ── 1. junction ─────────────────────────────────────────────
const scopeDir = join(profileDir, 'node_modules', SCOPE)
if (!DRY) mkdirSync(scopeDir, { recursive: true })
let linkState = 'created'
if (existsSync(linkPath)) {
  const st = lstatSync(linkPath)
  if (st.isSymbolicLink() && resolve(readlinkSync(linkPath)) === PLUGIN_DIR) {
    linkState = 'already-correct'
  } else {
    linkState = 'replaced'
    if (!DRY) rmSync(linkPath, { recursive: true, force: true })
  }
}
if (!DRY && linkState !== 'already-correct') symlinkSync(PLUGIN_DIR, linkPath, 'junction')
ok(`junction 就位（${linkState}）`, DRY || existsSync(linkPath))

// ── 2. package.json 的 link 依赖 ─────────────────────────────
let raw = readFileSync(pkgJsonPath, 'utf8')
let pkg
try { pkg = JSON.parse(raw) } catch (e) {
  console.error(`无法解析 ${pkgJsonPath}：${e.message}`)
  process.exit(2)
}
pkg.dependencies = pkg.dependencies ?? {}
// pnpm 在这个 profile 里记 link 依赖用的是**正斜杠**路径（见已有条目），
// 所以这里也统一成正斜杠：格式不一致时 pnpm 可能把条目判为需要重写，
// 或让 dependabot / 人读起来以为两个依赖写法不同。
const want = `link:${PLUGIN_DIR.replace(/\\/g, '/')}`
const had = pkg.dependencies[PKG]
if (had === want) {
  ok('package.json 已有正确的 link 依赖', true, want)
} else {
  pkg.dependencies[PKG] = want
  if (!DRY) {
    // 保留原有缩进风格：读出来时是怎样的就写回去
    const indent = /\n(\s+)"/.exec(raw)?.[1]?.length ?? 2
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, indent)}\n`, 'utf8')
  }
  ok(`package.json 的 link 依赖已写入${had ? `（覆盖旧值 ${had}）` : ''}`, true, want)
}

// ── 3. 让 pnpm 记账（**这一步不能省**）─────────────────────────
/*
 * 只写 package.json 加建 junction 是**半成品**：pnpm 的 lockfile 与 node_modules
 * 账本都不认这个依赖，下一次 `pnpm install`（或任何 `dsh plugin` 操作）会把
 * junction 当多余依赖清掉 —— 而那时 preset 还在 roster 里，症状是"preset 在，
 * 一选就报找不到包"。实测踩过这个坑：装完 preset 在 roster 里可见且判为
 * 可挂载，但 lockfile 里根本没有这一条。
 *
 * 走官方途径 `dsh plugin --profile <p> install`（它把参数转发给 profile 目录里的
 * pnpm），让 package.json → pnpm-lock.yaml → node_modules 三者一致。
 */
function resolveDshEntry() {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.cmd', '.ps1', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      if (!existsSync(join(dir, `dsh${ext}`))) continue
      const cand = join(dir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (existsSync(cand)) return cand
    }
  }
  return null
}

if (!DRY) {
  const entry = resolveDshEntry()
  if (entry === null) {
    ok('pnpm 记账（找不到 dsh 入口，跳过）', false, '手工跑：dsh plugin --profile ' + profile + ' install')
  } else {
    const r = spawnSync(process.execPath, [entry, 'plugin', '--profile', profile, 'install'], {
      cwd: profileDir, encoding: 'utf8', timeout: 300_000, windowsHide: true,
    })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const lock = existsSync(join(profileDir, 'pnpm-lock.yaml'))
      ? readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8') : ''
    const recorded = r.status === 0 && lock.includes(PKG)
    ok('pnpm 记账（lockfile 已含本包）', recorded,
      recorded ? PKG
        : r.status !== 0 ? out.trim().split(/\r?\n/).slice(-3).join(' | ')
          : 'lockfile 里没有这一条 —— 下次 pnpm install 会把 junction 当多余依赖清掉')
  }
} else {
  console.log('  --  dry-run：跳过 pnpm 记账')
}

// ── 4. 检查 preset 是否已装 ──────────────────────────────────
const presetDir = join(dshHome, '.agent-presets', 'hema-v2')
ok('preset 已安装（否则先跑 node preset/sync-preset.mjs）', existsSync(join(presetDir, 'agent.cordis.yml')), presetDir)

// ── 5. 复查：插件能解析它 import 的相对模块 ──────────────────
const needs = ['./lib/wiki.mjs', './lib/jev.mjs', './lib/evidence.mjs', './lib/decompose.mjs', './lib/report.mjs', './harness/trace.mjs']
for (const rel of needs) {
  const p = resolve(PLUGIN_DIR, rel)
  ok(`  相对依赖存在: ${rel}`, existsSync(p))
}

console.log(`\n${fails === 0 ? '安装完成' : fails + ' 项失败'}`)
if (!DRY && fails === 0) {
  console.log('')
  console.log('分两种情况，别混（本项目两种都踩过）：')
  console.log('  · 只改 preset **目录/行**（preset.yml、agent.cordis.yml）→ **不用重启**。')
  console.log('    roster 的 list() 每次都重扫 .agent-presets/，不缓存；刷新页面 + 开新会话即可。')
  console.log('  · 改了插件**代码**（index.js、lib/*.mjs）→ **必须重启 Host**。')
  console.log('    宿主 import 过就进了 Node 的 ESM 缓存，base 里 hmr 又是 disabled 的 ——')
  console.log('    刷新浏览器不会重载代码。确认办法：跑一次 hema_start，看返回里的「插件版本」。')
  console.log('')
  console.log('  另：已开着的会话会留在它当初的 preset 上，所以要**开新会话**才生效。')
}
process.exit(fails === 0 ? 0 : 1)
