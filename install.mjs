/**
 * 一条命令把本仓库的两个包接进本机 DSH_HOME。
 *
 * 做四件事：
 *   1. `@ghogiel/dsh-jev`   —— 生成 conditioned-reflex preset、junction 进 profile、pnpm 记账
 *   2. `@ghogiel/dsh-hema-v2` —— 生成 hema-v2 preset 并装进 .agent-presets/、junction、pnpm 记账
 *   3. 清掉 v1 遗留：`@ghogiel/dsh-weinao` 的 junction 与 link 依赖、以及只认它的 `hema` preset
 *   4. 复查：preset 结构、roster 能不能挂载
 *
 * **不动宿主进程。** preset 目录的改变刷新页面就能生效；插件*代码*的改动必须重启
 * Host（宿主 import 过就进了 Node 的 ESM 缓存，base 里 hmr 又是 disabled）。
 *
 * 用法：
 *   node install.mjs                    # 默认 web profile
 *   node install.mjs --profile web
 *   node install.mjs --dry-run
 *   node install.mjs --skip-retired     # 保留 v1 遗留物（默认清理）
 */

import { existsSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const argv = process.argv.slice(2)
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const DRY = argv.includes('--dry-run')
const SKIP_RETIRED = argv.includes('--skip-retired')
const profile = arg('profile', 'web')
const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)

const HEMA = join(HERE, 'packages', 'dsh-hema-v2')
const JEV = join(HERE, 'packages', 'dsh-jev')

let failed = 0
const step = (n, title) => console.log(`\n${'─'.repeat(4)} ${n}. ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`)
const run = (label, script, extra = []) => {
  const args = [script, ...extra, ...(DRY ? ['--dry-run'] : [])]
  console.log(`$ node ${script.replace(HERE + '\\', '')} ${extra.join(' ')}${DRY ? ' --dry-run' : ''}`)
  const r = spawnSync(process.execPath, args, { cwd: HERE, stdio: 'inherit', timeout: 600_000 })
  if (r.status !== 0) { console.log(`  ⚠ ${label} 退出码 ${r.status}`); failed++ }
  return r.status === 0
}

console.log('DSH_HOME : ' + dshHome)
console.log('profile  : ' + profile)
console.log('repo     : ' + HERE)
console.log('dry-run  : ' + DRY)

if (!existsSync(profileDir)) {
  console.error(`\nprofile 目录不存在：${profileDir}\n先让 dsh 至少启动过一次这个 profile。`)
  process.exit(2)
}

// ═══════════════════════════════════════════════════════════════
step(1, '@ghogiel/dsh-jev')
run('jev sync-preset', join(JEV, 'preset', 'sync-preset.mjs'))
run('jev install', join(JEV, 'preset', 'install.mjs'), ['--profile', profile])
// sync-preset 只写本地目录；装进 .agent-presets 由这里做
const jevPresetSrc = join(JEV, 'preset', 'conditioned-reflex')
const jevPresetDst = join(dshHome, '.agent-presets', 'conditioned-reflex')
if (DRY) {
  console.log(`  --  dry-run: 会复制 ${jevPresetSrc} → ${jevPresetDst}`)
} else {
  rmSync(jevPresetDst, { recursive: true, force: true })
  cpSync(jevPresetSrc, jevPresetDst, { recursive: true })
  const okc = existsSync(join(jevPresetDst, 'agent.cordis.yml'))
  console.log(`${okc ? '  ok  ' : ' FAIL '} preset 已装到 ${jevPresetDst}`)
  if (!okc) failed++
}

// ═══════════════════════════════════════════════════════════════
step(2, '@ghogiel/dsh-hema-v2')
run('hema sync-preset', join(HEMA, 'preset', 'sync-preset.mjs'))
run('hema install', join(HEMA, 'preset', 'install.mjs'), ['--profile', profile])

// ═══════════════════════════════════════════════════════════════
step(3, '清理 v1 遗留（@ghogiel/dsh-weinao）')
const RETIRED_PKG = '@ghogiel/dsh-weinao'
const RETIRED_PRESETS = ['hema']   // v1 preset，只挂被删掉的 weinao 包

if (SKIP_RETIRED) {
  console.log('  --  --skip-retired：跳过')
} else {
  // junction
  const [scope, name] = RETIRED_PKG.split('/')
  const deadLink = join(profileDir, 'node_modules', scope, name)
  if (existsSync(deadLink)) {
    let points = '(not a symlink)'
    try { points = readlinkSync(deadLink) } catch { /* 普通目录 */ }
    if (DRY) console.log(`  --  dry-run: 会删除 junction ${deadLink} → ${points}`)
    else { rmSync(deadLink, { recursive: true, force: true }); console.log(`  ok   已删除 junction ${deadLink}`) }
  } else {
    console.log(`  ok   junction 已不存在`)
  }
  // link 依赖
  const pkgJsonPath = join(profileDir, 'package.json')
  const raw = readFileSync(pkgJsonPath, 'utf8')
  const pkg = JSON.parse(raw)
  if (pkg.dependencies?.[RETIRED_PKG]) {
    const had = pkg.dependencies[RETIRED_PKG]
    delete pkg.dependencies[RETIRED_PKG]
    if (DRY) console.log(`  --  dry-run: 会从 dependencies 删除 ${RETIRED_PKG}（${had}）`)
    else {
      const indent = /\n(\s+)"/.exec(raw)?.[1]?.length ?? 2
      writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, indent)}\n`, 'utf8')
      console.log(`  ok   已从 dependencies 删除 ${RETIRED_PKG}`)
    }
  } else {
    console.log(`  ok   dependencies 里已无 ${RETIRED_PKG}`)
  }
  // v1 preset
  for (const id of RETIRED_PRESETS) {
    const dead = join(dshHome, '.agent-presets', id)
    if (!existsSync(dead)) { console.log(`  ok   preset ${id} 已不存在`); continue }
    const yml = existsSync(join(dead, 'agent.cordis.yml')) ? readFileSync(join(dead, 'agent.cordis.yml'), 'utf8') : ''
    if (!yml.includes(RETIRED_PKG)) {
      console.log(`  --   preset ${id} 不引用 ${RETIRED_PKG}，保留（可能不是 v1 遗留）`)
      continue
    }
    if (DRY) console.log(`  --  dry-run: 会删除 preset 目录 ${dead}`)
    else { rmSync(dead, { recursive: true, force: true }); console.log(`  ok   已删除 v1 preset ${dead}`) }
  }
  // 清理后让 pnpm 重新记账
  if (!DRY) {
    const entry = resolveDshEntry()
    if (entry) {
      const r = spawnSync(process.execPath, [entry, 'plugin', '--profile', profile, 'install'],
        { cwd: profileDir, encoding: 'utf8', timeout: 300_000, windowsHide: true })
      const lock = existsSync(join(profileDir, 'pnpm-lock.yaml')) ? readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8') : ''
      const clean = r.status === 0 && !lock.includes(RETIRED_PKG)
      console.log(`${clean ? '  ok  ' : ' FAIL '} pnpm 重新记账后 lockfile 已无 ${RETIRED_PKG}`)
      if (!clean) failed++
    }
  }
}

// ═══════════════════════════════════════════════════════════════
step(4, '复查')
run('hema verify-preset', join(HEMA, 'preset', 'verify-preset.mjs'))
run('hema verify-mount', join(HEMA, 'preset', 'verify-mount.mjs'), ['--profile', profile])

console.log(`\n${failed === 0 ? '全部完成' : failed + ' 个脚本失败'}`)
if (failed === 0 && !DRY) {
  console.log('')
  console.log('接下来：')
  console.log('  · preset **目录**的改动（新装 / 改名）→ roster 每次都重扫 .agent-presets/，刷新页面即可。')
  console.log('  · 插件**代码**的改动 → **必须重启 Host**：宿主 import 过就进了 Node 的 ESM 缓存。')
  console.log('    确认办法：跑一次 hema_start，看返回里的 pluginVersion。')
  console.log('  · 已开着的会话留在它当初的 preset 上 —— 要**开新会话**。')
}
process.exit(failed === 0 ? 0 : 1)

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
