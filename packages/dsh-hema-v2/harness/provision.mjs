/**
 * Stage 5 · 隔离 DSH_HOME 生成器
 *
 * 为什么要有这个文件而不是手写三份 profile 配置：
 *   三个角色（leader / researcher / writer）的能力边界是本架构的**硬规则**之一
 *   （用户冻结决定⑤：researcher 没有 fs/write 工具）。手写三份 YAML 迟早会漂移，
 *   而漂移的表现是"某个角色悄悄多拿了工具"——这种 bug 不会报错，只会让结论不可信。
 *   所以边界写成代码，由生成器保证三个 profile 只差在该差的地方。
 *
 * 生成物落在**仓库根**的 `.dsh-home/`（隔离，不污染用户真实的 ~/.dsh）：
 * 为什么不在包目录里：包里每个 profile 的 node_modules 都会 junction 回包目录本身
 * （PLUGIN_SRC = V2_ROOT），DSH_HOME 若也在包目录里就会造出一条自我递归的路径
 * （`.dsh-home/profiles/<role>/node_modules/@ghogiel/dsh-hema-v2/.dsh-home/...`），
 * 递归遍历包目录的工具会在里面绕不出来。
 *   settings.yaml                     模型与 reasoningEffort
 *   profiles/<role>/{cordis.yml,cordis.patch.yml,package.json,pnpm-workspace.yaml}
 *
 * 关键：base bundle 里的工具行按 id 精确 `disabled: true`。
 * headless 模式**不挂 agent-presets roster**，所以插件当宿主面普通行用 `insert` 追加
 * （不是替换工具集）——这也是必须显式禁用默认工具行的原因。
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, lstatSync, readlinkSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { V2_ROOT } from '../lib/wiki.mjs'

export const DSH_HOME = join(V2_ROOT, '..', '..', '.dsh-home')
export const CREDENTIALS = 'C:\\Users\\Ghogiel\\.dsh\\.credentials.yaml'

/** 本地插件包名与源码位置（本 monorepo 的 packages/dsh-hema-v2） */
export const PLUGIN_PKG = '@ghogiel/dsh-hema-v2'
// 包根就是插件本体（lib/ harness/ 都在它下面）
export const PLUGIN_SRC = V2_ROOT

/**
 * 所有角色都禁用的模型面工具行。
 *
 * 分三类，各有理由：
 *  · **文件与 shell**（tool-fs / tool-fs-search / tool-pwsh / tool-bash）——
 *    用户冻结决定⑤：researcher 不得有 fs 写工具；证据只能通过定位符流出，
 *    不允许它把原文摘抄成文件。leader/writer 一并不给，保持三角色边界一致。
 *  · **web**（tool-web）——researcher 的证据必须来自 Wiktenauer 文献；
 *    放开 web 就会引入不可追溯的来源，破坏"证据=wiki 定位符"这个唯一形态。
 *  · **编排类**（tool-subagent* / tool-workflow / tool-ralph / tool-jobs）——
 *    这是本架构最重要的一条：**角色不得自己再建团队**。
 *    否则 researcher 可以绕开链路的轮数封顶，自己开一堆子代理，
 *    验证器的打回与轮数上限就形同虚设。
 *  · **自我管理类**（tool-todo / tool-goal / tool-skill 及 skill 服务）——
 *    只增加 prompt 噪声，与职责无关。
 */
export const DISABLED_ROWS = [
  // 文件与 shell
  'tool-fs', 'tool-fs-search', 'tool-pwsh', 'tool-bash',
  // web
  'tool-web',
  // 编排
  'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control',
  'tool-subagent-list-agents', 'tool-workflow', 'tool-ralph', 'tool-jobs',
  // 自我管理
  'tool-todo', 'tool-goal', 'tool-skill', 'skill', 'skill-filesystem',
]

/** 角色定义：唯一差异是"有没有 wiki 工具" */
export const ROLES = {
  'hema-leader': {
    label: 'leader —— 分解研究题目，不取证、不写报告',
    wiki: false,
    purpose: '把研究题目分解为方向集中的子题目，输出 JSON。',
  },
  'hema-researcher': {
    label: 'researcher —— 取证并产出证据-断言包（唯一能读 wiki 的角色）',
    wiki: true,
    purpose: '基于跳转收集到的页面取证，产出「断言 + 证据定位符」的 JSON 包，不摘录原文。',
  },
  'hema-writer': {
    label: 'writer —— 依据已通过的证据-断言撰写报告',
    wiki: false,
    purpose: '依据已通过验证的断言撰写研究报告，并逐条列出未确证的断言。',
  },
}

const CORDIS_YML = `# dsh profile root —— 空条目列表。配置树由 patch 组合而成：
# package.json 的 dsh.profile.bundles → cordis.patch.yml → --patch 覆盖。
# 要改配置请改 cordis.patch.yml，不要改这个文件。
[]
`

const PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

function patchYml(role) {
  const def = ROLES[role]
  const lines = [
    '# 本文件由 packages/dsh-hema-v2/harness/provision.mjs 生成 —— 请改生成器，不要手改这里。',
    '',
    '# 固定模型，保证三个角色同配置、可复现。',
    '# 注意：agent-default-model 的组合 Config 只有 provider/model；',
    '# reasoningEffort 属于 settings schema，只能从 settings.yaml 设。',
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-flash',
    '',
    '# 凭据：只【指向】真实的 .credentials.yaml，不复制密钥。',
    '- id: credentials',
    '  config:',
    `    path: ${JSON.stringify(CREDENTIALS)}`,
    '',
    '# 无人值守：批准请求一律自动拒绝。',
    '# 之所以要显式写 never：默认是 ask，而这里没有人在旁边点批准，',
    '# 会挂住等批准。never 让越权调用**失败**而不是**卡死**。',
    '- id: approval',
    '  config:',
    '    policy: never',
    '',
    '# permission-presets 要求「沙箱模式 + 批准策略」这个组合**必须命中表里某个预设**，',
    '# 否则启动即失败：',
    '#   permission: composed sandbox and approval defaults match no preset',
    '# 默认表只收录 (workspace-write, ask) 与 (danger-full-access, never)，',
    '# 而我们要的是 (read-only, never) —— 无人值守 + 只读。所以必须自己加一条并指定为默认。',
    '# 注意 patch 是**整体替换** config，不是合并，所以三个标准预设也要原样重述。',
    '- id: permission',
    '  config:',
    '    defaultPreset: unattended-readonly',
    '    presets:',
    '      read-only:',
    "        sandbox: 'read-only'",
    "        approval: 'ask'",
    '        name: read-only',
    '        description: 只读；越权访问需要批准。',
    '      workspace-write:',
    '        sandbox: workspace-write',
    "        approval: 'ask'",
    '        name: workspace-write',
    '        description: 可在工作区内写入；越权重试需要批准。',
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    "        approval: 'never'",
    '        name: danger-full-access',
    '        description: 完全文件访问且不弹批准。',
    '      unattended-readonly:',
    "        sandbox: 'read-only'",
    "        approval: 'never'",
    '        name: unattended-readonly',
    '        description: 无人值守：只读且不弹批准，越权调用直接失败而不是挂住等人。',
    '',
    '# ── 能力边界：禁用默认工具行 ──',
    '# base bundle 的 insert 只是【追加】插件行，不会收窄默认工具集，',
    '# 所以必须按 id 逐行禁用。这是「硬规则在代码里」而不是「写在 prompt 里」。',
  ]
  for (const id of DISABLED_ROWS) {
    lines.push(`- id: ${id}`, '  disabled: true')
  }
  if (def.wiki) {
    lines.push(
      '',
      '# ── 唯一的角色差异：researcher 追加 wiki 工具 ──',
      '# headless 不挂 agent-presets roster，所以插件当宿主面普通行插入。',
      '- insert:',
      '    - id: hema-v2',
      "      name: '@ghogiel/dsh-hema-v2'",
      '      config: {}',
    )
  } else {
    lines.push('', '# 本角色不挂 wiki 工具：它不负责取证。')
  }
  return lines.join('\n') + '\n'
}

function packageJson(role) {
  return JSON.stringify({
    name: `dsh-profile-${role}`,
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
        patchReload: 'startup',
      },
    },
  }, null, 2) + '\n'
}

/**
 * 把本地插件源码 junction 进 profile 的 node_modules。
 *
 * 为什么必须做这一步：headless 下插件是当宿主面普通行 `insert` 的，
 * 加载时从 **profile 目录**解析包名。没链接就会：
 *   Cannot find package '@ghogiel/dsh-hema-v2' imported from <profile>
 * 注意这不是从 npm 安装 —— 用的是本地源码，所以改了 plugin 源码立刻生效，
 * 也避免了"harness 依赖某个已发布的插件版本"这种隐藏耦合。
 *
 * 用 junction 而不是目录符号链接：Windows 上 junction 不需要管理员权限。
 */
function linkPlugin(profileDir) {
  const scopeDir = join(profileDir, 'node_modules', '@ghogiel')
  const linkPath = join(scopeDir, PLUGIN_PKG.split('/')[1])
  const target = resolve(PLUGIN_SRC)
  mkdirSync(scopeDir, { recursive: true })

  try {
    const st = lstatSync(linkPath)
    if (st.isSymbolicLink() && resolve(readlinkSync(linkPath)) === target) {
      return { linkPath, target, created: false }
    }
    rmSync(linkPath, { recursive: true, force: true })
  } catch { /* 尚不存在 */ }

  symlinkSync(target, linkPath, 'junction')
  return { linkPath, target, created: true }
}

const SETTINGS_YAML = `# 隔离的 DSH 设置。三角色共用。
# reasoningEffort 只能在这里设（不在 agent-default-model 的 Config 里）。
agent-default-model:
  provider: deepseek-official
  model: deepseek-flash
  reasoningEffort: low
`

const GITIGNORE = `# 隔离的 DSH_HOME：profile、session log、投影缓存都落在这里。
# 不含密钥 —— profile 的 patch 只【指向】真实的 .credentials.yaml。
# 但这些是运行数据，不该进版本库。
*
!.gitignore
`

/**
 * 生成（或刷新）隔离 DSH_HOME。幂等：每次覆盖生成物，不动运行数据。
 * @returns {{home:string, roles:string[], written:string[]}}
 */
export function provision({ home = DSH_HOME } = {}) {
  const written = []
  mkdirSync(home, { recursive: true })

  const put = (rel, content) => {
    const p = join(home, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
    written.push(rel)
  }

  put('settings.yaml', SETTINGS_YAML)
  put('.gitignore', GITIGNORE)

  const links = []
  for (const role of Object.keys(ROLES)) {
    put(join('profiles', role, 'cordis.yml'), CORDIS_YML)
    put(join('profiles', role, 'cordis.patch.yml'), patchYml(role))
    put(join('profiles', role, 'package.json'), packageJson(role))
    put(join('profiles', role, 'pnpm-workspace.yaml'), PNPM_WORKSPACE)
    if (ROLES[role].wiki) {
      links.push({ role, ...linkPlugin(join(home, 'profiles', role)) })
    }
  }

  return { home, roles: Object.keys(ROLES), written, links }
}

/** 环境变量：让 base bundle 的 !!js 表达式把沙箱收到 read-only */
export function roleEnv(role, extra = {}) {
  return {
    ...process.env,
    DSH_HOME,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_DISABLED: '1',
    HEMA_ROLE: role,
    ...extra,
  }
}

/** 自检：确认生成物齐全、插件已链接、三个角色的差异符合预期 */
export function verify({ home = DSH_HOME } = {}) {
  const issues = []

  // 插件本体：源码存在 + 已构建（未构建的话 boot 时会以 ERR_MODULE_NOT_FOUND 失败）
  const pluginEntry = join(PLUGIN_SRC, 'index.js')
  if (!existsSync(PLUGIN_SRC)) {
    issues.push({ code: 'PLUGIN_SRC_MISSING', detail: PLUGIN_SRC })
  } else if (!existsSync(pluginEntry)) {
    issues.push({ code: 'PLUGIN_MISSING', detail: `缺少 ${pluginEntry}` })
  }

  for (const role of Object.keys(ROLES)) {
    for (const f of ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']) {
      const p = join(home, 'profiles', role, f)
      if (!existsSync(p)) issues.push({ role, file: f, code: 'MISSING' })
    }
    const p = join(home, 'profiles', role, 'cordis.patch.yml')
    if (!existsSync(p)) continue
    const yml = readFileSync(p, 'utf8')
    const hasWiki = /id: hema-v2/.test(yml)
    if (hasWiki !== ROLES[role].wiki) {
      issues.push({ role, code: 'WIKI_MISMATCH', detail: `期望 wiki=${ROLES[role].wiki}，实际 ${hasWiki}` })
    }
    for (const id of DISABLED_ROWS) {
      if (!new RegExp(`- id: ${id}\\n\\s+disabled: true`).test(yml)) {
        issues.push({ role, code: 'ROW_NOT_DISABLED', detail: id })
      }
    }
    // 需要 wiki 工具的角色的 junction 必须存在且指向本地源码
    if (ROLES[role].wiki) {
      const linkPath = join(home, 'profiles', role, 'node_modules', PLUGIN_PKG.split('/')[0], PLUGIN_PKG.split('/')[1])
      try {
        const st = lstatSync(linkPath)
        if (!st.isSymbolicLink()) {
          issues.push({ role, code: 'PLUGIN_LINK_NOT_SYMLINK', detail: linkPath })
        } else if (resolve(readlinkSync(linkPath)) !== resolve(PLUGIN_SRC)) {
          issues.push({ role, code: 'PLUGIN_LINK_WRONG_TARGET', detail: `${readlinkSync(linkPath)} ≠ ${PLUGIN_SRC}` })
        }
      } catch {
        issues.push({ role, code: 'PLUGIN_LINK_MISSING', detail: `${PLUGIN_PKG} 未链接进 ${linkPath}` })
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('provision.mjs')) {
  const res = provision()
  console.log(`已生成隔离 DSH_HOME: ${res.home}`)
  console.log(`角色: ${res.roles.join(', ')}`)
  console.log(`文件数: ${res.written.length}`)
  const v = verify()
  console.log(v.ok ? '自检通过' : `自检失败: ${JSON.stringify(v.issues, null, 2)}`)
  process.exit(v.ok ? 0 : 1)
}
