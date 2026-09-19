/**
 * 探针 Stage 5 —— 单次角色调用是否真的可用
 *
 * 在把五个阶段串起来跑之前，先证明最基本的一环：headless 能起来、能出 stdout、能退出 0。
 * 这一步失败的话，全链路跑出来的所有现象都是噪声。
 *
 * 同时验最要紧的能力边界：**researcher 有没有 wiki 工具、leader 有没有**。
 * 验法是让模型自己报告 —— 它看不到工具清单就调不动，调不动就会说实话。
 */
import { runRole, resolveDshEntry } from './dsh.mjs'
import { V2_ROOT } from '../lib/wiki.mjs'
import { join } from 'node:path'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}

const outDir = join(V2_ROOT, 'out', 'role-smoke')
const entry = resolveDshEntry()
ok('dsh 入口可解析', Boolean(entry), entry ?? '')
if (!entry) process.exit(1)

// ── 1. 最廉价的连通性：leader 只回一个词 ──────────────────
console.log('\n── leader 最小调用 ──')
const t0 = Date.now()
const r1 = runRole({
  role: 'hema-leader',
  prompt: '不要使用任何工具。只回复这五个字符：SMOKE',
  label: 'smoke-leader',
  outDir,
  timeoutMs: 240_000,
})
console.log(`  exit=${r1.exitCode} ${(r1.durationMs / 1000).toFixed(1)}s stdout=${r1.stdout.length}B stderr=${r1.stderr.length}B`)
if (r1.spawnError) console.log(`  spawnError: ${r1.spawnError}`)
console.log(`  stdout 末尾: ${JSON.stringify(r1.stdout.trim().slice(-120))}`)
if (r1.stderr) console.log(`  stderr 末尾: ${JSON.stringify(r1.stderr.trim().slice(-300))}`)

ok('leader 调用退出码 0', r1.exitCode === 0, `exit=${r1.exitCode}`)
ok('leader 有 stdout 输出', r1.stdout.trim().length > 0, `${r1.stdout.length}B`)
ok('leader 回出了标记', /SMOKE/i.test(r1.stdout))
ok('无 spawn 错误', !r1.spawnError, r1.spawnError ?? '')
ok('原始输出已落盘（可审计）', Boolean(r1.paths?.prompt) && Boolean(r1.paths?.stdout))

// ── 2. 能力边界：leader 不得有 wiki 工具 ───────────────────
console.log('\n── leader 不应有 wiki 工具 ──')
const r2 = runRole({
  role: 'hema-leader',
  prompt: '请调用名为 wiki_search 的工具搜索 "Zornhau"。如果这个工具不存在或无法调用，'
    + '就只回复这一行：NO_WIKI_TOOL。如果调用成功，只回复：WIKI_TOOL_WORKS。不要做其他事。',
  label: 'smoke-leader-nowiki',
  outDir,
  timeoutMs: 240_000,
})
console.log(`  exit=${r2.exitCode} ${(r2.durationMs / 1000).toFixed(1)}s`)
console.log(`  stdout 末尾: ${JSON.stringify(r2.stdout.trim().slice(-200))}`)
ok('leader 调用成功', r2.exitCode === 0)
ok('leader 没有 wiki_search（边界生效）',
  /NO_WIKI_TOOL/i.test(r2.stdout) && !/WIKI_TOOL_WORKS/i.test(r2.stdout),
  r2.stdout.trim().slice(-120))

// ── 3. 能力边界：researcher 必须有 wiki 工具 ───────────────
console.log('\n── researcher 应有 wiki 工具 ──')
const r3 = runRole({
  role: 'hema-researcher',
  prompt: '请调用名为 wiki_search 的工具，搜索关键词 "Zornhau"。'
    + '然后只回复一行，格式为：WIKI_TOOL_WORKS: <你看到的第一个结果标题>。'
    + '如果工具不存在或无法调用，只回复 NO_WIKI_TOOL。不要做其他事。',
  label: 'smoke-researcher-wiki',
  outDir,
  timeoutMs: 300_000,
})
console.log(`  exit=${r3.exitCode} ${(r3.durationMs / 1000).toFixed(1)}s`)
console.log(`  stdout 末尾: ${JSON.stringify(r3.stdout.trim().slice(-300))}`)
ok('researcher 调用成功', r3.exitCode === 0)
ok('researcher 有 wiki_search（边界生效）', /WIKI_TOOL_WORKS/i.test(r3.stdout), r3.stdout.trim().slice(-150))
ok('researcher 真的检索到了内容', /WIKI_TOOL_WORKS:\s*\S/.test(r3.stdout))

// ── 4. 能力边界：researcher 不得有 fs 工具 ─────────────────
console.log('\n── researcher 不应有 fs 工具 ──')
const r4 = runRole({
  role: 'hema-researcher',
  prompt: '请尝试调用名为 read 的工具读取文件 package.json。'
    + '如果 read 工具不存在或无法调用，只回复：NO_FS_TOOL。如果读成功，只回复：FS_TOOL_WORKS。不要做其他事。',
  label: 'smoke-researcher-nofs',
  outDir,
  timeoutMs: 300_000,
})
console.log(`  exit=${r4.exitCode} ${(r4.durationMs / 1000).toFixed(1)}s`)
console.log(`  stdout 末尾: ${JSON.stringify(r4.stdout.trim().slice(-200))}`)
ok('researcher 调用成功', r4.exitCode === 0)
ok('researcher 没有 read（边界生效）',
  /NO_FS_TOOL/i.test(r4.stdout) && !/FS_TOOL_WORKS/i.test(r4.stdout),
  r4.stdout.trim().slice(-120))

console.log(`\n原始产物: ${outDir}`)
console.log(`${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
process.exit(fails === 0 ? 0 : 1)
