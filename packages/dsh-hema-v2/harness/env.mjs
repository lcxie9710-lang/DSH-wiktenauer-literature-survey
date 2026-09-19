/**
 * 极小的 .env 读取器。
 *
 * 为什么需要：JEV 的 key 不能出现在命令行参数里（会进 shell 历史、进日志、进对话记录），
 * 所以要有一个进程外的地方放它。`.env` 已在仓库根 `.gitignore` 里，不进版本库。
 *
 * 刻意不引第三方 dotenv：这里只需要 KEY=VALUE 这一种语法，
 * 引一个依赖去解析它不值得。已存在的 process.env 优先（环境变量是显式覆盖）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { V2_ROOT } from '../lib/wiki.mjs'

export const ENV_PATH = join(V2_ROOT, '.env')

/** 解析 KEY=VALUE：忽略空行与 # 注释，去掉值两侧引号 */
export function parseEnv(text) {
  const out = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

/**
 * 把 .env 里的变量补进 process.env（**不覆盖**已存在的）。
 * @returns {string[]} 实际注入的变量名（便于打印"从 .env 读到了什么"，但不打印值）
 */
export function loadEnvFile(path = ENV_PATH) {
  if (!existsSync(path)) return []
  let vars
  try { vars = parseEnv(readFileSync(path, 'utf8')) } catch { return [] }
  const injected = []
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined && v) { process.env[k] = v; injected.push(k) }
  }
  return injected
}

/**
 * 报告密钥来源，**只看是否存在、绝不回显内容**。
 * 日志里一旦出现完整 key，它就会跟着日志被复制到各处。
 */
export function describeKeyState(envName = 'AI_GATEWAY_API_KEY') {
  const v = process.env[envName]
  if (!v) return { present: false, source: null, hint: `未找到 ${envName}（可写进仓库根的 .env）` }
  const fromEnvFile = existsSync(ENV_PATH) && (() => {
    try { return parseEnv(readFileSync(ENV_PATH, 'utf8'))[envName] === v } catch { return false }
  })()
  // 只暴露长度与首尾各 2 字符，足够确认"是同一把 key"而不泄露它
  const masked = v.length > 8 ? `${v.slice(0, 2)}…${v.slice(-2)}（${v.length} 字符）` : `（${v.length} 字符）`
  return { present: true, source: fromEnvFile ? '.env' : 'process.env', masked }
}
