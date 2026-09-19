/**
 * 把插件包接进本机 DSH_HOME。**纯原子：要么装全，要么一点不动。**
 *
 * ## 为什么不再手工建 junction
 *
 * 早先的版本是手做三步：① `symlinkSync(..., 'junction')` ② 往 `package.json` 写
 * `link:` 依赖 ③ 让 pnpm 记账。这个顺序有个陷阱 —— ①②在③之前落盘，所以③跑不了时
 * 留下的是一种**半装**状态：junction 在磁盘上、依赖写在表里、preset 在 roster 里可见，
 * 但 lockfile 从来不知道这个包。下一次 `pnpm install`（或任何 `dsh plugin` 操作）会把
 * junction 当多余依赖清掉，症状是"preset 在，一选就报找不到包"。
 *
 * 而且①②本来就多余：`pnpm install` 对 `link:` 依赖**自己会建这个链接**。
 * Windows 上实测它建的是 **junction**（reparse tag 0xa0000003），不需要管理员权限、
 * 也不需要开发者模式。所以顺序改成：
 *
 *   ① 预检 `dsh plugin` 整条通路 —— 走不通就什么都不碰
 *   ② 写 `link:` 依赖（原文留在内存里）
 *   ③ `dsh plugin --profile <p> install` —— 一次同时建链接**和** lockfile 账目
 *   ④ 复查两者；任何一步不对就还原 `package.json` 并删掉链接
 *
 * ## 预检为什么是 `dsh plugin --version`，而不是去 PATH 上找 pnpm
 *
 * `dsh plugin` 把参数转发给 profile 目录里的 pnpm，所以要测的正是这一跳。
 * `dsh plugin --profile <p> --version` 用 pnpm 跑一个不安装任何东西的参数，
 * 没有 pnpm 时它会非零退出：
 *
 *   'pnpm' is not recognized as an internal or external command
 *   dsh: pnpm failed in profile directory <...>
 *
 * **纯净的 DSH 不等于有 pnpm。** 实测：全新 DSH_HOME 上 `dsh --profile web --help`
 * 能正常 boot（bundle 从 dsh 安装目录解析），只有 `dsh plugin` 需要 pnpm。
 * 所以这是一个真实机器上会出现的状态，不是假想。
 *
 * 用法：
 *   node install.mjs                 # 默认装到 web profile
 *   node install.mjs --profile web
 *   node install.mjs --dry-run
 *   node install.mjs --uninstall
 */

import { existsSync, readFileSync, writeFileSync, rmSync, lstatSync, readlinkSync } from 'node:fs'
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
// 本脚本在 <包>/preset/ 下，上一级就是包根 —— 既是链接目标，也是 link: 依赖指向的位置。
const PLUGIN_DIR = resolve(import.meta.dirname, '..')

const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const profile = arg('profile', 'web')
const profileDir = join(dshHome, 'profiles', profile)
const linkPath = join(profileDir, 'node_modules', SCOPE, NAME)
const pkgJsonPath = join(profileDir, 'package.json')
const lockPath = join(profileDir, 'pnpm-lock.yaml')

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

/** 找 dsh 入口。**不要** spawn `dsh.cmd` —— Node 在 Windows 上拒绝（EINVAL）。 */
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

/** 跑 `dsh plugin --profile <p> <args>`（入口已解析好） */
function dshPlugin(entry, args, timeout = 300_000) {
  return spawnSync(process.execPath, [entry, 'plugin', '--profile', profile, ...args], {
    cwd: profileDir, encoding: 'utf8', timeout, windowsHide: true,
  })
}

/**
 * pnpm 在不在 PATH 上 —— 我们自己的判断，不去解析子进程的报错文本。
 * pnpm 在中文 Windows 上把"不是内部或外部命令"按 OEM 码页写出来，
 * 照原样打印会是一串乱码；而"PATH 上有没有 pnpm"这个事实本来就能直接查。
 */
function pnpmOnPath() {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.cmd', '.ps1', ''] : ['']
  return (process.env.PATH ?? '').split(sep).some((dir) =>
    dir && exts.some((ext) => existsSync(join(dir, `pnpm${ext}`))))
}

// ═══════════════════════════════════════════════════════════════
// 0. 预检 —— 通路走不通就什么都不碰
// ═══════════════════════════════════════════════════════════════
if (!existsSync(profileDir)) {
  console.error(`profile 目录不存在：${profileDir}`)
  console.error(`先让 DSH 至少启动过一次这个 profile（\`dsh --profile ${profile}\`），目录是它建的。`)
  process.exit(2)
}
if (!existsSync(join(PLUGIN_DIR, 'package.json'))) {
  console.error(`插件目录里没有 package.json：${PLUGIN_DIR}`)
  process.exit(2)
}

const entry = resolveDshEntry()
if (entry === null) {
  console.error('PATH 上找不到 `dsh` 命令 —— 什么也没改。\n')
  console.error('`dsh plugin` 既是本脚本保持 profile 一致的手段，也是 pnpm 认识这个包的途径。')
  console.error('请把 DSH 装成能在普通 shell 里直接跑 `dsh`：')
  console.error('  npm i -g @deepseek-ai/dsh')
  console.error('（只用 `npx` 跑 DSH 不会把 `dsh` 放进别的进程的 PATH。）')
  process.exit(2)
}

{
  // `--version` 会被转发给 pnpm 且不安装任何东西 —— 测的正是本脚本依赖的那一跳。
  // 它在 `--dry-run` 下也安全（不改任何东西），所以 dry-run 报的是真实结论，
  // 而不是把最可能踩的那个坑糊过去。
  const probe = dshPlugin(entry, ['--version'], 120_000)
  if (probe.status !== 0) {
    console.error('`dsh` 能用，但它转发给 pnpm 失败 —— 什么也没改。\n')
    if (!pnpmOnPath()) {
      console.error('  诊断：PATH 上找不到 pnpm。')
    } else {
      // 有 pnpm 却失败：把子进程的报错带出来，但只留 ASCII 行 ——
      // pnpm 在中文 Windows 上输出的是 OEM 码页字节，直接打会是一串乱码。
      console.error('  诊断：PATH 上能找到 pnpm，但它没能在 profile 目录里跑起来：')
      const ascii = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.split(/\r?\n/)
        .filter(l => l.trim() && /^[\x20-\x7e]+$/.test(l.trim())).slice(-3)
      for (const l of ascii) console.error(`    ${l.trim()}`)
    }
    console.error('')
    console.error('`dsh plugin` 是在 profile 目录里转发给 pnpm 的，而 **boot DSH 并不需要 pnpm**')
    console.error('（实测全新 DSH_HOME 能正常启动）—— 所以"有 dsh"不代表"有 pnpm"。装上再重跑：')
    console.error('  corepack enable pnpm        # 或：npm i -g pnpm')
    console.error('')
    console.error('为什么这里宁可拒绝也不"先装上再说"：只写 junction 和 `link:` 依赖、不写 lockfile')
    console.error('账目，留下的是一种半装状态 —— preset 还在 roster 里可见，但下一次 pnpm 操作')
    console.error(`会把链接当多余依赖清掉，会话报 "Cannot find package '${PKG}'"。`)
    process.exit(2)
  }
}

// ── 卸载 ────────────────────────────────────────────────────
if (UNINSTALL) {
  if (!DRY && existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true })
  console.log(`已移除 junction${DRY ? '（dry-run）' : ''}`)
  console.log(`更彻底的做法：dsh plugin --profile ${profile} remove ${PKG}`)
  console.log('（那条会把 package.json 的依赖与 lockfile 一起清掉；本脚本不擅自动你的依赖表）')
  process.exit(0)
}

// ═══════════════════════════════════════════════════════════════
// 1. 写 `link:` 依赖
// ═══════════════════════════════════════════════════════════════
const originalPkgJson = readFileSync(pkgJsonPath, 'utf8')
let pkg
try { pkg = JSON.parse(originalPkgJson) } catch (e) {
  console.error(`无法解析 ${pkgJsonPath}：${e.message}`)
  process.exit(2)
}
pkg.dependencies = pkg.dependencies ?? {}
// pnpm 在这个 profile 里记 link 依赖用的是**正斜杠**路径（见已有条目），
// 所以这里也统一成正斜杠：格式不一致时 pnpm 可能把条目判为需要重写。
const want = `link:${PLUGIN_DIR.replace(/\\/g, '/')}`
const had = pkg.dependencies[PKG]
const depUnchanged = had === want
if (!depUnchanged && !DRY) {
  pkg.dependencies[PKG] = want
  // 保留原有缩进风格：读出来时是怎样的就写回去
  const indent = /\n(\s+)"/.exec(originalPkgJson)?.[1]?.length ?? 2
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, indent)}\n`, 'utf8')
}
ok(depUnchanged
  ? 'package.json 已有正确的 link 依赖'
  : `package.json 的 link 依赖已写入${had ? `（覆盖旧值 ${had}）` : ''}${DRY ? '（dry-run）' : ''}`,
true, want)

// ═══════════════════════════════════════════════════════════════
// 2. 让 pnpm 一次做完"建链接 + 记账"
// ═══════════════════════════════════════════════════════════════
/** 撤掉我们自己的改动。半装比不装更糟 —— 这是本文件存在的全部理由。 */
const rollback = () => {
  if (DRY) return
  try { writeFileSync(pkgJsonPath, originalPkgJson, 'utf8') } catch { /* 尽力而为 */ }
  try {
    if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()
      && resolve(readlinkSync(linkPath)) === PLUGIN_DIR) {
      rmSync(linkPath, { recursive: true, force: true })
    }
  } catch { /* 尽力而为 */ }
}

if (DRY) {
  console.log(`  --  dry-run：会跑 \`dsh plugin --profile ${profile} install\`（建链接 + 写 lockfile 账目）`)
} else {
  const r = dshPlugin(entry, ['install'])
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const lock = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : ''
  const recorded = r.status === 0 && lock.includes(PKG)

  let linked = false
  try { linked = existsSync(linkPath) && resolve(readlinkSync(linkPath)) === PLUGIN_DIR } catch { linked = false }

  ok('pnpm 记账（lockfile 已含本包）', recorded,
    recorded ? PKG
      : r.status !== 0 ? out.trim().split(/\r?\n/).slice(-3).join(' | ')
        : 'lockfile 里没有这一条 —— 下次 pnpm install 会把链接当多余依赖清掉')
  ok('链接就位（由 pnpm 建立/维护）', linked, linkPath)

  if (!recorded || !linked) {
    rollback()
    console.log('\n已回滚：package.json 还原、链接已删 —— profile 保持原样。')
    console.log(`要手工完成，在 ${profileDir} 里跑：`)
    console.log(`  dsh plugin --profile ${profile} install`)
    process.exit(1)
  }
}

// ── 3. 检查 preset 是否已装 ──────────────────────────────────
const presetDir = join(dshHome, '.agent-presets', 'hema-v2')
ok('preset 已安装（否则先跑 node preset/sync-preset.mjs）', existsSync(join(presetDir, 'agent.cordis.yml')), presetDir)

// ── 4. 复查：插件能解析它 import 的相对模块 ──────────────────
const needs = ['./lib/wiki.mjs', './lib/jev.mjs', './lib/evidence.mjs', './lib/decompose.mjs', './lib/report.mjs', './harness/trace.mjs']
for (const rel of needs) {
  ok(`  相对依赖存在: ${rel}`, existsSync(resolve(PLUGIN_DIR, rel)))
}

console.log(`\n${DRY ? 'dry-run 结束 —— 什么也没改' : fails === 0 ? '安装完成' : fails + ' 项失败'}`)
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
process.exit(DRY || fails === 0 ? 0 : 1)
