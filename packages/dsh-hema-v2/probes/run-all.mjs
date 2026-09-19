/**
 * 全量回归（离线套件）
 *
 * 为什么不能只数 ok/fail 行：脚本中途抛异常时输出会**截断**，
 * 于是 ok 计数变少、fail 仍为 0 —— 和"全部通过"长得一模一样。
 * 实测就被这个坑过一次（test-jev 里引用了不存在的 head()，
 * 统计显示 0 项失败，实际后半段根本没跑）。
 *
 * 所以判据三条缺一不可：
 *   1. 退出码为 0
 *   2. 打印了终止行（"全部通过" / "接线自检全部通过"）
 *   3. FAIL 计数为 0
 * 并要求 ok 计数不低于写死的基线（低于基线 = 有断言凭空消失，同样可疑）。
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { V2_ROOT } from '../lib/wiki.mjs'

/**
 * 预检：每个 .mjs/.js 先过 `node --check`。
 *
 * 为什么值得单独加一步：语法错误会让**整条套件**一行输出都没有，
 * 于是 ok=0、fail=0 —— 只靠"退出码 + 终止行 + 基线"也能抓到（下面确实抓到了），
 * 但报出来是一串 module loader 的栈，得往回翻才知道真正坏在哪一行。
 * 实测踩过：往块注释里写了一行含"星号紧跟斜杠"的路径，注释提前闭合，
 * 整个文件变成语法错误，两条套件直接消失。预检直接给出文件与错误行。
 */
function syntaxPreflight() {
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'out') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(mjs|js)$/.test(e.name)) files.push(p)
    }
  }
  walk(V2_ROOT)

  const bad = []
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 60_000 })
    if (r.status !== 0) bad.push({ f: f.replace(V2_ROOT + '\\', ''), out: `${r.stdout ?? ''}${r.stderr ?? ''}` })
  }
  for (const b of bad) {
    console.log(` FAIL  语法预检 ${b.f}`)
    console.log('       ' + b.out.trim().split(/\r?\n/).slice(0, 4).join('\n       '))
  }
  console.log(`  ${bad.length ? 'FAIL' : 'ok  '} 语法预检                  ${files.length} 个文件，${bad.length} 个语法错误\n`)
  return bad.length
}

/** 基线：每条套件的断言数下限。加了断言要同步上调，掉下来就是有东西没跑。 */
const SUITES = [
  // 基线随功能删减而调整（跳转器与 answerable 已按实测删除，相关断言一并移除）。
  // 基线的作用是"有断言凭空消失就报错"，所以每次删断言都要同步下调，别让它变成噪声。
  { name: 'probes/test-jev', args: ['probes/test-jev.mjs'], minOk: 49 },
  { name: 'probes/test-chain', args: ['probes/test-chain.mjs'], minOk: 68 },
  { name: 'probes/test-decompose', args: ['probes/test-decompose.mjs'], minOk: 53 },
  { name: 'probes/test-report', args: ['probes/test-report.mjs'], minOk: 67 },
  { name: 'probes/test-logging', args: ['probes/test-logging.mjs'], minOk: 28 },
  { name: 'probes/test-plugin', args: ['probes/test-plugin.mjs'], minOk: 88 },
  { name: 'probes/test-data-tools', args: ['probes/test-data-tools.mjs'], minOk: 47 },
  { name: 'preset/verify-preset', args: ['preset/verify-preset.mjs'], minOk: 35 },
  { name: 'preset/verify-mount', args: ['preset/verify-mount.mjs'], minOk: 9 },
  { name: 'harness/verify-profiles', args: ['harness/verify-profiles.mjs'], minOk: 35 },
  { name: 'harness/run --self-test', args: ['harness/run.mjs', '--self-test'], minOk: 20 },
]

/**
 * 终止行：各套件自己的结束语措辞不一（全部通过 / 接线自检全部通过 / N 项失败 / PASS: n/m）。
 * 这里一律认，否则"合法失败"和"中途截断"就分不开 —— 而这两种情况的处置完全不同。
 */
const TERMINAL = /(全部通过|接线自检全部通过|\d+ 项失败|^PASS\b|^FAIL\b|PASS：|FAIL：)/m

let totalOk = 0
let totalFail = 0
let broken = 0

console.log('═══ HEMA v2 全量回归 ═══\n')
broken += syntaxPreflight()
for (const s of SUITES) {
  // 沙箱：不用管道 stdio，把输出落盘再读（spawnSync 默认就是管道，受限环境会被拒）
  const res = spawnSync(process.execPath, s.args, {
    cwd: V2_ROOT, env: process.env, encoding: 'utf8', timeout: 900_000,
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const okc = (out.match(/^ {2}ok {2}/gm) ?? []).length
  const fails = (out.match(/^ FAIL /gm) ?? []).length
  const hasTerminal = TERMINAL.test(out)
  const exitOk = res.status === 0

  totalOk += okc
  totalFail += fails

  const problems = []
  if (!exitOk) problems.push(`退出码 ${res.status}${res.signal ? ` (${res.signal})` : ''}`)
  // 注意区分：合法失败也会退出非 0 并打印"N 项失败"，那不算截断
  if (!hasTerminal) problems.push('没有打印终止行（多半中途抛异常截断）')
  if (fails) problems.push(`${fails} 项失败`)
  if (okc < s.minOk) problems.push(`ok=${okc} 低于基线 ${s.minOk}（有断言没跑）`)

  const bad = problems.length > 0
  const truncated = !hasTerminal
  if (bad) broken++
  console.log(`${bad ? ' FAIL ' : '  ok  '} ${s.name.padEnd(26)} ok=${String(okc).padEnd(3)} fail=${fails}${bad ? `  ← ${problems.join('；')}` : ''}`)

  if (truncated) {
    const tail = out.trim().split(/\r?\n/).slice(-8).join('\n     ')
    console.log(`     截断处尾部:\n     ${tail}`)
  }
}

console.log(`\n══════ 总计: ${totalOk} 项通过, ${totalFail} 项失败, ${broken} 条套件异常 ══════`)
process.exit(broken === 0 && totalFail === 0 ? 0 : 1)
