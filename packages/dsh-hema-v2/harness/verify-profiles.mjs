/**
 * Stage 5 · 角色能力边界的权威验证（零模型调用）
 *
 * `dsh --dump-config` 会打印**组合后**的配置树，所以这是唯一能证明
 * "researcher 真的没有 fs 工具"的权威手段 —— 靠读我们自己写的 patch 是不够的，
 * patch 可能被后续层覆盖。这里验的是组合结果。
 *
 * 为什么这条验证重要：能力边界是本架构的硬规则（用户冻结决定⑤），
 * 而边界失效**不会报错**。researcher 悄悄留着 write 工具，一切照跑，
 * 只是"证据只以定位符传递"这个前提被破坏了，而没有任何迹象。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { provision, verify as verifyFiles, DSH_HOME, ROLES, DISABLED_ROWS } from './provision.mjs'
import { V2_ROOT } from '../lib/wiki.mjs'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}
const head = (s) => console.log(`\n── ${s} ──`)

// ── 定位 dsh 入口（与 parked eval 相同的策略：绕开 .cmd 的 EINVAL）──
export function resolveDshEntry() {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.cmd', '.ps1', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      if (!existsSync(join(dir, `dsh${ext}`))) continue
      const candidate = join(dir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * 解析 dump 出来的扁平行列表。
 * 形状：`- id: x` 起一行，后续缩进行属于该行（name / disabled / config: …）。
 */
export function parseDump(text) {
  const rows = []
  let cur = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (/^\s*#/.test(line) || !line.trim()) continue
    const m = /^-\s+id:\s*(.+?)\s*$/.exec(line)
    if (m) { cur = { id: m[1], name: null, disabled: null, raw: [line] }; rows.push(cur); continue }
    if (!cur) continue
    cur.raw.push(line)
    const n = /^\s+name:\s*(.+?)\s*$/.exec(line)
    if (n) cur.name = n[1].replace(/^['"]|['"]$/g, '')
    const d = /^\s+disabled:\s*(.+?)\s*$/.exec(line)
    if (d) cur.disabled = d[1]
  }
  return rows
}

async function dump(entry, role) {
  const args = [entry, '--profile', role, '--dump-config']
  // 沙箱：用文件描述符接输出，不走管道
  mkdirSync(join(V2_ROOT, 'out'), { recursive: true })
  const tmp = join(V2_ROOT, 'out', `dump-${role}.yml`)
  const res = spawnSync(process.execPath, args, {
    cwd: V2_ROOT,
    env: { ...process.env, DSH_HOME, DSH_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (res.error) return { ok: false, error: String(res.error.message ?? res.error) }
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
  writeFileSync(tmp, text, 'utf8')
  if (res.status !== 0) return { ok: false, error: `exit ${res.status}: ${text.slice(0, 300)}` }
  return { ok: true, text, rows: parseDump(text), path: tmp }
}

// ══════════════════════════════════════════════════════════════
head('0) 生成器自检（文件层）')
const prov = provision()
ok('生成器写出 14 个文件', prov.written.length === 14, `got=${prov.written.length}`)
const fileCheck = verifyFiles()
ok('文件层自检通过', fileCheck.ok, JSON.stringify(fileCheck.issues))

head('0b) 解析器自测（合成输入）')
const sample = [
  '- id: a', "  name: '@x/a'", '  disabled: true',
  '- id: b', "  name: '@x/b'", '  config:', '    k: 1',
].join('\n')
const pr = parseDump(sample)
ok('解析出 2 行', pr.length === 2, `got=${pr.length}`)
ok('解析 disabled', pr[0].disabled === 'true')
ok('解析 name', pr[1].name === '@x/b')
ok('未写 disabled 的行保持 null', pr[1].disabled === null)

// ══════════════════════════════════════════════════════════════
head('1) 组合后的配置树（dsh --dump-config）')
const entry = resolveDshEntry()
ok('找到 dsh 入口', Boolean(entry), entry ?? '(未找到)')
if (!entry) {
  console.log('\n无法继续：需要 dsh 入口才能验证组合结果')
  process.exit(1)
}

const dumps = {}
for (const role of Object.keys(ROLES)) {
  const d = await dump(entry, role)
  ok(`${role} dump 成功`, d.ok, d.ok ? `${d.rows.length} 行 → ${d.path}` : d.error)
  if (d.ok) dumps[role] = d
}

// ══════════════════════════════════════════════════════════════
head('2) 硬边界：禁用行在组合结果里确实是 disabled')
for (const role of Object.keys(ROLES)) {
  const d = dumps[role]
  if (!d) continue
  const byId = new Map(d.rows.map(r => [r.id, r]))
  const notDisabled = DISABLED_ROWS.filter(id => byId.get(id)?.disabled !== 'true')
  ok(`${role}: 全部 ${DISABLED_ROWS.length} 个禁用行生效`, notDisabled.length === 0,
    notDisabled.length ? `漏掉: ${notDisabled.join(', ')}` : '')

  // 明确点出最关键的三条（防"整体通过但关键项被覆盖"）
  for (const id of ['tool-fs', 'tool-web', 'tool-subagent']) {
    ok(`  ${role}: ${id} 已禁用`, byId.get(id)?.disabled === 'true', `disabled=${byId.get(id)?.disabled}`)
  }
}

// ══════════════════════════════════════════════════════════════
head('3) 唯一的角色差异：只有 researcher 挂 wiki 工具')
for (const [role, def] of Object.entries(ROLES)) {
  const d = dumps[role]
  if (!d) continue
  const byId = new Map(d.rows.map(r => [r.id, r]))
  const hasWiki = byId.has('hema-v2')
  ok(`${role}: hema-v2 ${def.wiki ? '存在' : '不存在'}`, hasWiki === def.wiki,
    `期望 ${def.wiki}，实际 ${hasWiki}`)
  if (def.wiki) ok(`  ${role}: hema-v2 指向正确包名`, byId.get('hema-v2')?.name === '@ghogiel/dsh-hema-v2',
    byId.get('hema-v2')?.name)
}

head('3b) 三角色共享同一模型配置')
for (const [role, d] of Object.entries(dumps)) {
  const byId = new Map(d.rows.map(r => [r.id, r]))
  const raw = byId.get('agent-default-model')?.raw.join('\n') ?? ''
  ok(`${role}: 固定为 deepseek-flash`, /model:\s*deepseek-flash/.test(raw), raw.replace(/\n/g, ' '))
  ok(`${role}: 批准策略为 never（无人值守不卡死）`, /policy:\s*never/.test(byId.get('approval')?.raw.join('\n') ?? ''))
}

// ══════════════════════════════════════════════════════════════
head('4) 真启动一次（不调模型）—— dump-config 抓不到的加载期错误')
/*
 * `--dump-config` 只组合配置树，**不加载插件**，所以它能通过而启动照样失败。
 * 实测被这个坑到过一次：permission-presets 在构造时校验
 * 「沙箱模式 + 批准策略」必须命中预设表，否则抛异常 —— 配置树完全合法，
 * 一 boot 就死。`--help` 会真正 boot 整个 profile，零模型成本，正好用来挡这类错误。
 */
for (const role of Object.keys(ROLES)) {
  const res = spawnSync(process.execPath, [entry, '--profile', role, '--help'], {
    cwd: V2_ROOT,
    env: { ...process.env, DSH_HOME, DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  })
  const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const loadErr = /plugin tree failed to load|failed to apply loader entry/.exec(combined)
  ok(`${role}: 能真正 boot（插件树加载成功）`, res.status === 0 && !loadErr,
    loadErr ? loadErr[0] : `exit=${res.status}`)
}

console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
process.exit(fails === 0 ? 0 : 1)
