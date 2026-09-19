/**
 * Stage 5 · headless 角色调用器
 *
 * 把「调一个角色」这件事收敛成一个函数：`dsh --profile <role> "<prompt>"`。
 *
 * 两个必须照做的细节（都是踩过的坑）：
 *  1. **不 spawn `dsh.cmd`**。Node 20+ 在 Windows 上拒绝 spawn .cmd/.bat（EINVAL，
 *     CVE-2024-27980 缓解）；改用 node + 解析出的 `@deepseek-ai/dsh/lib/bin.js`。
 *  2. **stdout/stderr 走文件描述符，不走管道**。受限环境下管道 stdio 会被拒绝
 *     （EPERM），而 spawnSync 默认就是管道。用 openSync 拿 fd 直接给子进程写文件，
 *     既绕开限制，又天然留下可审计的原始输出。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME, roleEnv } from './provision.mjs'
import { V2_ROOT } from '../lib/wiki.mjs'

/** 定位 dsh 入口：npm shim 在 node_modules/.bin/，入口在其 ../@deepseek-ai/dsh/lib/bin.js */
export function resolveDshEntry(explicit = null) {
  if (explicit && existsSync(explicit)) return explicit
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
 * 跑一个角色的一次调用。
 *
 * 注意这是**一次性**调用：每轮全新进程，没有对话记忆。
 * 轮次之间传递的唯一状态是 harness 显式拼进 prompt 的「证据-断言包」。
 *
 * @param {object} o
 * @param {string} o.role profile 名（hema-leader / hema-researcher / hema-writer）
 * @param {string} o.prompt 完整提示词
 * @param {string} [o.label] 审计用的短标签（决定原始输出文件名）
 * @param {string} o.outDir 原始输出落盘目录
 * @param {number} [o.timeoutMs]
 * @param {string} [o.dshEntry]
 * @param {boolean} [o.dryRun] 只生成命令不执行
 * @param {(e:object)=>void} [o.onEvent]
 */
export function runRole({
  role, prompt, label = null, outDir, timeoutMs = 600_000,
  dshEntry = null, dryRun = false, onEvent = () => {},
}) {
  const entry = resolveDshEntry(dshEntry)
  const stem = label ?? `${role}-${Date.now()}`
  if (!entry) return { ok: false, error: 'DSH_ENTRY_NOT_FOUND', role, stem, stdout: '', stderr: '' }

  if (dryRun) {
    onEvent({ type: 'dry_run', role, stem, promptChars: prompt.length })
    return { ok: true, dryRun: true, role, stem, stdout: '', stderr: '', durationMs: 0 }
  }

  mkdirSync(outDir, { recursive: true })
  const stdoutPath = join(outDir, `${stem}.stdout.txt`)
  const stderrPath = join(outDir, `${stem}.reasoning.txt`)
  const promptPath = join(outDir, `${stem}.prompt.txt`)
  const metaPath = join(outDir, `${stem}.meta.json`)

  const started = Date.now()
  let status = null, spawnError = null
  try {
    const fdOut = openSync(stdoutPath, 'w')
    const fdErr = openSync(stderrPath, 'w')
    try {
      const res = spawnSync(process.execPath, [entry, '--profile', role, prompt], {
        stdio: ['ignore', fdOut, fdErr],
        timeout: timeoutMs,
        cwd: V2_ROOT,
        env: roleEnv(role),
        windowsHide: true,
      })
      status = res.status
      if (res.error) spawnError = String(res.error.message ?? res.error)
      if (res.signal) spawnError = `signal ${res.signal}`
    } finally {
      closeSync(fdOut)
      closeSync(fdErr)
    }
  } catch (e) {
    spawnError = String(e.message ?? e)
  }

  const durationMs = Date.now() - started
  const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
  const stdout = read(stdoutPath)
  const stderr = read(stderrPath)
  const ok = status === 0 && !spawnError

  try {
    writeFileSync(promptPath, prompt, 'utf8')
    writeFileSync(metaPath, JSON.stringify({
      role, stem, exitCode: status, durationMs, spawnError,
      promptChars: prompt.length, stdoutChars: stdout.length, stderrChars: stderr.length,
      cmd: `dsh --profile ${role} <prompt ${prompt.length} chars>`,
      finishedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
  } catch { /* 审计写失败不影响主流程 */ }

  onEvent({ type: 'role_done', role, stem, ok, exitCode: status, durationMs, stdoutChars: stdout.length })
  return {
    ok, role, stem, exitCode: status, spawnError, stdout, stderr, durationMs,
    paths: { prompt: promptPath, stdout: stdoutPath, stderr: stderrPath, meta: metaPath },
  }
}

export { DSH_HOME }
