/**
 * 生成并安装 `hema-v2` agent preset。
 *
 * ## 为什么复制已安装的 standard，而不是签入一份自己的 composition
 *
 * `standard` 的行是**当前这次 DSH 构建**的行。签入一份副本的话，DSH 一升级，
 * 这份 preset 就会引用不存在的行 —— 而失败方式是启动时报一个很难看懂的 loader 错。
 * 复制安装副本可以从根上避免这件事。`@ghogiel/dsh-jev` 的 sync-preset.mjs 同此做法。
 *
 * ## 为什么必须在 preset 层
 *
 * Web 会话按 agent preset 逐代理组合工具，host 行不进会话里的 agent。
 * 本包因此不声明 `dsh.bundle`、不带 `cordis.patch.yml`：模型可见的行只有这里这一处，
 * 而且**只对挂了这个 preset 的会话可见**。
 *
 * 用法：
 *   node sync-preset.mjs            # 生成 agent.cordis.yml 并安装到 <DSH_HOME>/.agent-presets/
 *   node sync-preset.mjs --build    # 只生成，不安装
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BUILD_ONLY = process.argv.includes('--build')
// `--dry-run` 必须真的什么都不写：根 install.mjs 会带着它跑一遍，而它的承诺是
// "先看它会做什么"。以前这里不认这个参数，于是 dry-run 其实重写了本地 preset
// 和 .agent-presets/ 里的副本 —— 幂等，但"什么也没改"就成了假话。
const DRY = process.argv.includes('--dry-run')
const HERE = import.meta.dirname
const PRESET_ID = 'hema-v2'

const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')

/**
 * 本 preset 存在的理由：这些行。
 *
 * 顶层追加（与 standard 内部的嵌套分组并存是合法的：standard 自己末尾也有顶层行）。
 */
const ROWS = `
# ── HEMA v2 研究链路 ────────────────────────────────────────────────────────
# 插件本体：注册 hema_start / hema_decompose_check / hema_verify /
# hema_report_check / hema_status / hema_finish。
# 所有硬规则（JEV 阈值、轮数封顶、证据悬置）都在这些工具里，由代码裁决；
# 模型可以决策但无法超轮 —— 工具会直接拒。
- id: hema-v2
  name: '@ghogiel/dsh-hema-v2'
  config:
    jevMode: http

# 数据访问层（wiki_search / wiki_get_page / wiki_get_section / wiki_prefix_search /
# wiki_get_links / glossary_lookup）**已并进 hema-v2 插件本身**，
# 不再需要单独的 @ghogiel/dsh-weinao 行。
#
# 合并的第二个理由才是关键：并进来之后 wiki_get_page 能返回**带 anchor 的页面大纲**，
# 于是研究者自行检索到的页面也能给精确到节的定位符 ——
# 而 v1 的 wiki_get_page 只返回纯文本，自行检索只能给整页（anchor: null）。

# ── 角色：研究者 ────────────────────────────────────────────────────────────
# continuable：它保留自己的对话，打回时用 send_message 在**同一对话里**继续，
# 不要每轮重建 —— 这正是"别做完第一次就释放"要的效果。
#
# toolFilter.allow 只留 wiki 与术语表：去掉 fs / shell / web / 编排工具。
# 理由不是洁癖：证据的唯一合法形态是 wiki 定位符。给它 write 工具，
# 它就会把原文摘抄成文件，"证据只以定位符传递"这个前提当场失效，
# 而且这种失效**不会报错**，只会让结论不可追溯。
- id: tool-hema-researcher
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: hema_researcher
    backgroundMode: continuable
    # 允许创建**这一层**子代理，但不允许它再往下开。
    # 主会话的代理是 depth 0，它的子代理 attemptedDepth = 1 —— 所以这里必须是 1。
    #
    # ⚠ 这里原本写的是 0，本意是"不许它再开子代理"，实际含义却是"禁止创建任何子代理"。
    # 实测真机上三次 hema_researcher 调用全部返回：
    #   Error: subagent depth 1 exceeds maxDepth 0
    # 模型只好自己用 wiki_get_page 把活干完，从外面看就像"根本没起 subagent"。
    # 教训：这个参数是**子代理自身的深度上限**，不是"还能再往下几层"。
    maxDepth: 1
    persona: >-
      你是 HEMA（欧洲历史武术）文献取证员。你的唯一职责是：针对给定的原子命题，
      在 Wiktenauer 上找到证据，产出「断言 + 证据定位符」包。
      取证顺序：先用 glossary_lookup 把中文术语换成历史拼写；再用 wiki_prefix_search
      找页面（本站全文检索 wiki_search 召回很低，别把它当"没有材料"的结论）；
      用 wiki_get_page 拿到**带 anchor 的节列表**；再用 wiki_get_section 读需要的节。
      证据**不是原文摘抄，而是定位符**：{page, anchor, revid}，指向 wiki 某页某节。
      绝对不要在证据字段里贴引文或段落 —— 需要文本时由程序去解引用。
      每条断言都要具体、可查证；不要写空话或同义反复，也不要为了好通过而把断言削弱成废话。
    toolFilter:
      allow:
        - wiki_search
        - wiki_prefix_search
        - wiki_get_page
        - wiki_get_section
        - wiki_get_links
        - glossary_lookup
`

/** 定位已安装构建里的 standard preset */
function findShippedStandard() {
  const candidates = []
  const npmCache = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx')
  if (existsSync(npmCache)) {
    for (const entry of readdirSync(npmCache)) {
      candidates.push(join(npmCache, entry, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'))
    }
  }
  candidates.push(join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'))
  candidates.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'))
  return candidates.find(c => existsSync(c))
}

const standardPath = findShippedStandard()
if (standardPath === undefined) {
  console.error('找不到已安装的 standard preset；请设置 DSH_HOME，或先安装 @deepseek-ai/dsh')
  process.exit(2)
}
console.log(`源 preset: ${standardPath}`)

const source = readFileSync(standardPath, 'utf8').replace(/[\s\uFEFF]+$/, '')
for (const id of ['hema-v2', 'weinao', 'tool-hema-researcher']) {
  if (new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`, 'm').test(source)) {
    console.error(`源 preset 已经带有 ${id} 行；拒绝追加重复行`)
    process.exit(2)
  }
}

const target = join(HERE, PRESET_ID, 'agent.cordis.yml')
if (DRY) {
  console.log(`  --  dry-run：会写 ${target}`)
} else {
  writeFileSync(target, `${source}\n${ROWS}`)
  console.log(`已生成 ${target}`)
}

if (BUILD_ONLY) {
  console.log('（--build：未安装）')
  process.exit(0)
}

const destDir = join(dshHome, '.agent-presets', PRESET_ID)
if (DRY) {
  console.log(`  --  dry-run：会安装到 ${destDir}`)
} else {
  mkdirSync(destDir, { recursive: true })
  cpSync(join(HERE, PRESET_ID, 'preset.yml'), join(destDir, 'preset.yml'))
  cpSync(target, join(destDir, 'agent.cordis.yml'))
  console.log(`已安装到 ${destDir}`)
}
console.log('')
console.log('下一步：在本机 DSH_HOME 里让插件包可解析（junction + link 依赖），然后重启 Host / 刷新页面，')
console.log('在 preset 选择器里选「HEMA v2 研究链路」。install.mjs 会自动做前者。')
