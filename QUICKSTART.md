# 快速开始

适用于windows平台，从零到在 DSH 里跑一个 HEMA 研究题目。全部命令都在**仓库根**执行。

---

## 0. 前置条件

| 需要 | 检查 | 为什么 |
|---|---|---|
| Node ≥ 20 | `node -v` | |
| **`dsh` 能在普通 shell 里直接跑** | `dsh --version` | 光用 `npx` 跑过 DSH **不算** —— `npx` 不会把 `dsh` 放进别的进程的 PATH。装：`npm i -g @deepseek-ai/dsh` |
| **pnpm** | `pnpm -v` | `dsh plugin` 是在 profile 目录里转发给 pnpm 的。**boot DSH 本身不需要 pnpm**，所以"有 dsh"不代表"有 pnpm"。装：`corepack enable pnpm` 或 `npm i -g pnpm` |
| 已启动过一次 web profile | `dsh --profile web`，看到界面即可 | 安装脚本要往 `<DSH_HOME>/profiles/web/` 里写东西，那个目录是 DSH 自己建的 |
| Vercel AI Gateway 的 key | 见第 2 节 | JEV 的唯一凭据 |

> 缺 `dsh` 或 pnpm 的话不用担心装坏：`node install.mjs` 会在**动任何东西之前**停下
> 并告诉你装什么（见第 3 节）。

`DSH_HOME` 默认是 `~/.dsh`（Windows 上是 `C:\Users\<你>\.dsh`）。
装在别处的话，所有命令前面加 `DSH_HOME=...`（PowerShell：`$env:DSH_HOME='...'`）。
`node install.mjs` 每次都会把实际用的 `DSH_HOME` 和 profile 打在头两行。

---

## 1. 装包

```bash
git clone https://github.com/lcxie9710-lang/DSH-wiktenauer-literature-survey.git
cd DSH-wiktenauer-literature-survey
```

不装 npm 依赖 —— 两个插件都是**零依赖的纯 ESM**（`packages/*/index.js` 直接 import
Node 内置模块）。`pnpm install` 只是为了仓库根脚本方便，可以跳过。

---

## 2. 配 JEV 的 key

JEV 走 Vercel AI Gateway。**放错位置不会报错**，只会让 JEV 调用全部失败，vercel官网为https://vercel.com/ai-gateway
症状和"没配 key"一模一样 —— 所以这一步别跳。

### GUI / preset 路径（你实际用的那条）

由 DSH 的凭据服务解析，固定优先级：

| 层 | 位置 | 说明 |
|---|---|---|
| 1 | 启动环境变量 | `AI_GATEWAY_API_KEY=vck_... dsh web` |
| 2 | `<DSH_HOME>/.credentials.yaml` | GUI 的设置界面写进去的就是这里 |
| 3 | **`<invocation cwd>/.env`** | **你启动 dsh 时所在目录**的 `.env` |
| 4 | `<DSH_HOME>/.env` | |

**推荐写第 4 层**（与 cwd 无关，配一次就不用再想）：

```bash
# Windows
echo AI_GATEWAY_API_KEY=vck_... > "%USERPROFILE%\.dsh\.env"
# macOS / Linux
echo "AI_GATEWAY_API_KEY=vck_..." >> ~/.dsh/.env
```

**如果你更想用仓库根的那个 `.env`**（`cp .env.example .env`），那第 3 层要求你
**从仓库根启动 dsh**：

```bash
cd <你 clone 的仓库>
npx @deepseek-ai/dsh web
```

从别处启动就走着第 3 层读到另一个目录，key 不会生效 —— 这是本项目实测踩过的坑。

### 无头 CLI 路径（`harness/run.mjs`）是另一套

它读 `packages/dsh-hema-v2/.env`（`harness/env.mjs` 的 `ENV_PATH`）或进程环境变量，
**不认**第 3/4 层。想跑 CLI 就在那里也放一份，或者导出环境变量：

```bash
AI_GATEWAY_API_KEY=vck_... node packages/dsh-hema-v2/harness/run.mjs --question "..." --jev http
```

### 自检

```bash
node packages/dsh-jev/verify-key.mjs
```

它验的是上面 A 那套链路（会真调一次网关，约 $0.00002）。
**它偶发 120s 超时** —— 实测第一次 `FAIL: 5/6`、紧接着重跑 `PASS: 6/6`；
失败时它其实**已经找到了 key**（前两条 `ok` 就是证据），纯粹是那次网关调用慢。
超时就重跑一遍，不要急着改 key。

`.env` 已经在 `.gitignore` 里，**不会被提交**。

---

## 3. 一条命令接进 DSH

```bash
node install.mjs                # 默认 web profile
node install.mjs --dry-run      # 先看它会做什么（也会做通路预检）
node install.mjs --profile web  # 指定 profile
```

它会先做**通路预检**，然后做四件事：

1. `@ghogiel/dsh-jev` —— 生成 `conditioned-reflex` preset、接进 profile、pnpm 记账
2. `@ghogiel/dsh-hema-v2` —— 生成 `hema-v2` preset 并装进 `.agent-presets/`、接进 profile、pnpm 记账
3. 清理 v1 遗留（`@ghogiel/dsh-weinao` 的链接 / link 依赖 / 只认它的 `hema` preset）
4. 复查 preset 结构与挂载

### 为什么先预检：`dsh plugin` 要 pnpm，而"有 dsh"不等于"有 pnpm"

`dsh plugin --profile <p> <args>` 是在 profile 目录里**转发给 pnpm** 的。而 boot DSH
本身**不需要** pnpm（实测全新 `DSH_HOME` 能正常启动，bundle 从 dsh 安装目录解析）——
所以一台机器完全可能"有纯净的 dsh，没有 pnpm"。

这种情况下老版本会**留下半装状态**：链接建了、`link:` 依赖写了、preset 也在 roster 里
可见，但 lockfile 从来不知道这个包 —— 下一次 pnpm 操作会把链接当多余依赖清掉，
症状是"**preset 在，一选就报找不到包**"。

现在不会了。脚本先用 `dsh plugin --version`（不安装任何东西）探一次那条通路，
走不通就在**动任何东西之前**停下：

```
`dsh` 能用，但它转发给 pnpm 失败 —— 什么也没改。

  诊断：PATH 上找不到 pnpm。

...
  corepack enable pnpm        # 或：npm i -g pnpm
```

装完 pnpm 再重跑即可。（同理，PATH 上找不到 `dsh` 也会在动手前停下并提示
`npm i -g @deepseek-ai/dsh` —— 只用 `npx` 跑 DSH 不会把 `dsh` 放进别的进程的 PATH。）

### 安装本身是原子的

**不需要**手工建 junction：`pnpm install` 对 `link:` 依赖会自己建这个链接。
Windows 上实测它建的是 **junction**（reparse tag `0xa0000003`），
不需要管理员权限、也不需要开发者模式。所以流程是
「写 `link:` 依赖 → `dsh plugin install`（一次同时建链接和 lockfile 账目）→ 复查」，
任何一步不对就**还原 `package.json` 并删掉链接** —— 要么装全，要么一点不动。

成功的输出长这样：

```
预检通过：dsh plugin → pnpm 通路正常（...）
  ok   package.json 的 link 依赖已写入
  ok   pnpm 记账（lockfile 已含本包）
  ok   链接就位（由 pnpm 建立）
  ok   preset 已安装
PASS: 35/35 项通过          ← preset 结构校验
PASS：preset 可挂载          ← roster 自己判断
全部完成
```

---

## 4. 重启 DSH Host，然后开新会话

```powershell
# 找到宿主进程并停掉（Windows）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, CreationDate, CommandLine
Stop-Process -Id <上面看到的 pid> -Force
npx @deepseek-ai/dsh web
```

**为什么必须重启** ：

| 改了什么 | 生效方式 |
|---|---|
| preset **目录**（`preset.yml` / `agent.cordis.yml`） | roster 的 `list()` **每次都重扫** `.agent-presets/`，**不缓存** → 刷新页面即可 |
| 插件**代码**（`index.js` / `lib/*.mjs`） | 宿主 import 过就进了 Node 的 **ESM 缓存**，base 里 `hmr` 是 `disabled` 的 → **刷新浏览器不会重载代码，必须重启 Host** |

判断办法只能是**比对进程启动时间**：`Get-CimInstance Win32_Process` 看 `CreationDate`
是不是早于你改代码的时间。为此插件带了**版本路标** —— 跑一次 `hema_start`，
返回里有 `pluginVersion`，当前是 `0.2.1`。看到旧版本号 = 宿主还是旧进程。

**还要开新会话**：已经开着的会话留在它当初的 preset 上，切 preset 不会换掉它。

---

## 5. 跑一个研究题目

在新会话里，preset 选择器选「**HEMA v2 研究链路**」，然后说一句话，例如：

```
研究：长剑技术的社会使用群体与情景
```

接下来应该看到（工具的调用顺序，不是 prompt 里的要求，是工具契约逼出来的）：

```
hema_start(topic)                          → runId + pluginVersion
hema_decompose_check(runId, subQuestions)  → pass / retry / suspend
  （每条子题起一个 hema_researcher 子代理，它在**自己的对话里**检索、取证、产出断言包）
hema_verify(runId, atom, claims)           → 逐条裁决 + 打回原因 + 逐条证据诊断
  （判否 → send_message 回同一个子代理改证据或改断言；≤3 轮）
hema_report_check(runId, report)           → 校验并强制补齐「证据悬置」节
hema_finish(runId)                         → 审计与 trace 落盘
```

**怎么知道它真的在按规则跑**，而不是模型自己在表演：

- `hema_verify` 的返回里带 `round`。第 4 次会被**直接拒**（`ROUNDS_EXHAUSTED`）——
  轮数封顶在代码里，模型想做也做不到。
- 判否时返回里带**逐条证据诊断**（指出是哪个来源不支持），不是一句"再改改"。
- 报告若缺「证据悬置」节，`hema_report_check` 会由**代码**补上，
  返回里 `appendedByCode: true`。
- 如果模型谎报"已通过"，看 `out/sessions/<runId>/jev-calls.jsonl` ——
  每次 JEV 调用都把喂进去的 `state` 全文记下来了。

---

## 产物在哪

```
<包目录>/out/sessions/<runId>/
├─ 00-trace.md          全链路时间线（人可读）
├─ 00-audit.json        汇总审计
├─ 00-events.jsonl      事件流（可重放）
├─ 01-decomposition.json
├─ 02-chain-<子题>.json 每条链的逐轮记录
├─ 03-brief.json        给撰写者的简报
├─ 04-report.md         最终报告
├─ 04-report-check.json 后置检查结果
├─ jev-calls.jsonl      每次 JEV 调用（**含 state 全文**）
└─ roles/               每个角色每次调用的 prompt / stdout / reasoning
```

`out/` 在 `.gitignore` 里。CLI 路径的产物落在 `out/<runId>/`（少一层 `sessions/`）。

CLI 路径还会在**仓库根**建一个隔离的 `.dsh-home/`（三个角色的 profile + 它们自己的
`node_modules`）。它**不能**放在包目录里：包里每个 profile 都会把
`@ghogiel/dsh-hema-v2` junction 回包目录本身，而 DSH_HOME 若也在包目录里，就会造出一条
自我递归的路径（`.dsh-home/profiles/*/node_modules/@ghogiel/dsh-hema-v2/.dsh-home/...`），
递归遍历包目录的工具会在里面绕不出来。`.dsh-home/` 也在 `.gitignore` 里，随时可删。

想统计一次 run 里 JEV 的概率分布（判断阈值 0.7 是否合适）：

```bash
node packages/dsh-hema-v2/probes/analyze-run.mjs out/sessions/<runId>
```

---

## 跑测试

```bash
pnpm test        # 499 项断言，全离线，几十秒
```

分套件：

```bash
node packages/dsh-hema-v2/probes/test-plugin.mjs       # 插件 12 个工具体 + schema 合法性
node packages/dsh-hema-v2/probes/test-chain.mjs        # 单链轮数封顶 / 冻结 / 逐条诊断
node packages/dsh-hema-v2/probes/test-data-tools.mjs   # 6 个数据层工具（会真联网取 Wiktenauer）
node packages/dsh-hema-v2/probes/test-jev.mjs          # JEV 契约与阈值
node packages/dsh-jev/verify.mjs                       # JEV 插件本体（**会真调网关**）
```

---

## 排错

按"症状 → 原因"排。下面每一条都是实测踩过的，不是设想。

### `node install.mjs` 报「PATH 上找不到 `dsh` 命令」，退出码 2
什么也没改，这是有意的。只用 `npx @deepseek-ai/dsh web` 跑过 DSH 的话，
`dsh` 不会出现在普通 shell 的 PATH 上。装成全局的再重跑：

```bash
npm i -g @deepseek-ai/dsh
```

### `node install.mjs` 报「`dsh` 能用，但它转发给 pnpm 失败」，退出码 2
什么也没改，这是有意的 —— 这种情况下继续装会留下半装状态。装上 pnpm 再重跑：

```bash
corepack enable pnpm        # 或：npm i -g pnpm
```

（`dsh plugin` 是在 profile 目录里转发给 pnpm 的；boot DSH 本身不需要 pnpm，
所以"有 dsh"并不代表"有 pnpm"。）

### JEV 调用失败 / 说找不到 key
见上面第 2 节。快速自查：key 在不在 `<DSH_HOME>/.env`？如果放在仓库根的
`.env` 里，dsh 是不是**从仓库根启动**的？（第 3 层读的是"启动时所在目录"，
不是"仓库根"。）跑 `node packages/dsh-jev/verify-key.mjs` 会告诉你哪一层答上了。

### `node packages/dsh-jev/verify-key.mjs` 报 `JEV did not answer within 120s`
**偶发，重跑即可。** 实测第一次 `FAIL: 5/6`、紧接着 `PASS: 6/6`。注意失败时它
其实**已经找到了 key**（输出里前两条 `ok` 就是证据），纯粹是那次网关调用慢
—— 别急着改 key。

### `Cannot find package '@ghogiel/dsh-hema-v2' imported from <profile>`
链接被 pnpm 清掉了。重跑 `node install.mjs`（现在它会先把通路预检一遍）。

### preset 选择器里看不到「HEMA v2 研究链路」
1. `node packages/dsh-hema-v2/preset/verify-mount.mjs` —— 让 roster 自己说能不能挂。
2. roster 扫的是 `<DSH_HOME>/.agent-presets/`，不是仓库。确认
   `<DSH_HOME>/.agent-presets/hema-v2/agent.cordis.yml` 存在。
3. `DSH_HOME` 指错地方了？`node install.mjs --dry-run` 第一行会打印它用的是哪个。

### 会话里工具没出现 / 行为还是旧的
宿主进程是旧的。见上面「必须重启」那节 —— **刷新浏览器不重启 Node 进程**。

### `Invalid schema for function 'hema_decompose_check': schema must be a JSON Schema of 'type: "object"', got 'type: null'`
本插件用**普通对象注册**（不是 `defineTool()`），所以 `parameters` 会被**原样**送给模型，
必须是完整 JSON Schema，不能用 `{ 参数名: {type, required} }` 简写。
`probes/test-plugin.mjs` 里有一节专门校验它。

### `Error: subagent depth 1 exceeds maxDepth 0`
`maxDepth` 是**子代理自身的深度上限**：主会话 depth 0、子代理 depth 1，
所以 `0` 等于禁止创建任何子代理。研究者的 `maxDepth` 必须是 `1`。
（这个坑真机踩过：三次 `hema_researcher` 全部创建失败，模型只好自己把活干完，
看起来就像"没起 subagent"。）

### `permission: composed sandbox and approval defaults match no preset`
`permission-presets` 在**构造时**校验「沙箱模式 + 批准策略」必须命中预设表。
而 `--dump-config` 只组合配置树、不加载插件，**它能通过而启动照样失败**。
`harness/provision.mjs` 里显式加了 `unattended-readonly` 预设并把它设成默认
（patch 是**整体替换** config，所以三个标准预设也要原样重述）。
这条只影响 CLI 路径。

### JEV 偶发挂起
实测过一次 120s 超时，同批其余调用只要 0.4–0.6s。验证调用用 120s 超时 + 轮内重试；
重试不消耗轮数（它不算一次"判定"）。

### 改代码后测试全绿但真机还报错
看进程启动时间。同样的报错一字不差地复现 = 跑的是旧代码。

---

## 卸载

```bash
node packages/dsh-hema-v2/preset/install.mjs --uninstall
node packages/dsh-jev/preset/install.mjs --uninstall
rm -rf <DSH_HOME>/.agent-presets/hema-v2 <DSH_HOME>/.agent-presets/conditioned-reflex
```

`--uninstall` 只删链接；更彻底的做法是让 pnpm 连依赖与 lockfile 一起清：

```bash
dsh plugin --profile web remove @ghogiel/dsh-hema-v2
dsh plugin --profile web remove @ghogiel/dsh-jev
```

（本脚本不擅自改你的依赖表，所以两条路都留着。）
