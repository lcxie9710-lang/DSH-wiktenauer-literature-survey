# @ghogiel/dsh-hema-v2

DSH 上用 JEV 做验证器的 HEMA（欧洲历史武术）文献研究链路。
**preset 层插件**，12 个工具：6 个 Wiktenauer 数据层 + 6 个链路控制层。

核心只有三个动作：

```
leader 把研究题目分解为方向集中的子题目
   ↓  JEV A 组检查；≤3 轮，仍不过 → 悬置问用户
每条子题一条链：
   researcher 自己检索取证 → 产出「断言 + 证据定位符」包
      ↓
   JEV B+C 组判定（证据是否支持 / 是否跑题 / 是否够具体）
      ↓  判否 → 逐条证据诊断（指出是哪个来源不支持）→ 打回 researcher 改证据或改断言；≤3 轮
   仍不过 → 证据悬置（绝不假装通过）
   ↓
报告撰写者依据**已通过**的证据-断言写报告 + 确定性后置检查 + 代码兜底强制「证据悬置」节
```

没有 Skeptic，没有全局反证搜索，没有 Synthesizer，也**没有跳转器**（按实测删除，见下文）。

---

## 证据的形态

用户定下的简化形态，也是全系统的地基：

- 只有两样东西：**断言（文本）** 与 **证据（定位符）**
- 证据**不摘录任何原文**，只是 `{page, anchor, revid}` —— 指向 wiki 某页某节某版本
- 证据始终以定位符形式传递；**只有需要 JEV/LLM 处理时**，才由程序去定位符指向的位置提取并拼装上下文

这不是洁癖，是被 JEV 的属性逼出来的：JEV 是 evaluation model，**没有 context、没有 memory**，
要判的东西必须整个塞进 `state`。所以"何时把指针变成文本"必须是一个显式动作，
否则证据会以自由文本形式全系统漂流，既无法审计也无法钉版本。

## 12 个工具

数据层（`wiki_*` / `glossary_*`）只做取数与定位，不做判定：

| 工具 | 作用 |
|---|---|
| `wiki_search` | 全文搜索，找**页面名**（Wiktenauer 无 CirrusSearch，召回天生很低，1–3 条是常态） |
| `wiki_prefix_search` | 前缀搜索，专治拼写变体（`Zornha` → `Zornhaw`） |
| `wiki_get_page` | 取**带 anchor 的页面大纲**（节名 + 每节首段摘要），据此挑要读哪一节 |
| `wiki_get_section` | 按 `page#anchor` 取该节正文 |
| `wiki_get_links` | 取某页出链，用于顺传本/大师页横向扩散 |
| `glossary_lookup` | 术语表双向查询（`怒击` → `Zornhau`，`Zornhau` → `怒击`） |

链路层（`hema_*`）持有全部硬规则：

| 工具 | 作用 |
|---|---|
| `hema_start(topic)` | 开一次 run，返回 `runId` 与 `pluginVersion` |
| `hema_decompose_check(runId, subQuestions)` | 分解校验 → `pass` / `retry` / `suspend`（封顶 3 轮） |
| `hema_verify(runId, atom, claims)` | 逐条裁决 + 打回原因 + 逐条证据诊断 |
| `hema_report_check(runId, report)` | 校验报告并**强制**补齐悬置节 |
| `hema_status(runId)` | 看当前状态与已用轮数 |
| `hema_finish(runId)` | 审计与 trace 落盘 |

## 硬规则在代码里，不在 prompt 里

| 规则 | 落在哪 |
|---|---|
| 断言重试封顶 3 轮，超过即证据悬置 | `lib/chain.mjs` |
| 分解检查封顶 3 轮，超过即悬置问用户 | `lib/decompose.mjs` |
| **用户编辑过的分解不再重新检查** | `lib/decompose.mjs` `acceptUserEdit`（纯同步，连 JEV 都不碰） |
| 证据定位不到 = 证据不成立，硬拦不问 JEV | `lib/evidence.mjs` `precheck` + `lib/chain.mjs` |
| 已通过的断言冻结，重交文本未变则不重复验证 | `lib/chain.mjs` |
| JEV 调用失败 → 中止本轮重试，绝不默认通过 | `lib/chain.mjs` / `lib/decompose.mjs` |
| 失败路径的逐条证据诊断（只在判否且多来源时才问） | `lib/jev.mjs` `perEvidenceQuestions` + `lib/chain.mjs` |
| 报告必须带完整「证据悬置」节 | `lib/report.mjs` `enforceSuspension`（模型不配合就由代码补） |
| 角色能力边界（researcher 无 fs/shell/web/编排工具） | `preset/sync-preset.mjs` + `harness/provision.mjs` |

**为什么规则在工具里，而不是让模型自己数轮数。** DSH 的 `sendMessage` 只确认送达、
**不返回子代理的答案**，subagent service 上也没有 public 的 await-settlement：
continuable 子代理拿得到持久化，却无法被代码 `await`；能 await 的只有 one-shot。
于是分工落回原始设计那句话 ——
**Harness = 插件（持有状态、调 JEV、执行封顶）；Agent = 决策者与工人。**
模型想做第 4 轮也做不到：`hema_verify` 会直接拒。

**researcher 用 continuable subagent，不会被"做完一次就释放"**：它保留自己的对话，
打回时用 `send_message` 在**同一对话里**继续。preset 里给它配了
`toolFilter.allow`（只留 6 个数据工具）与 `maxDepth: 1`
（`maxDepth` 是**子代理自身的深度上限**：主会话 depth 0、子代理 depth 1，
所以 `0` 等于禁止创建任何子代理 —— 这个坑真机踩过，见下文）。

## 冻结参数

| 参数 | 值 | 位置 |
|---|---|---|
| JEV 通过阈值 | `0.7`（boolean 的 p(true) / choice 的目标选项概率） | `lib/jev.mjs` `THRESHOLD` |
| score 类判定 | 可接受等级的**概率质量和** ≥ 0.7（不是"argmax 必须等于某级"） | `passScore` |
| 断言重试 | 3 轮 | `CHAIN_DEFAULTS.maxRounds` |
| 分解检查 | 3 轮 | `DECOMPOSE_DEFAULTS.maxRounds` |
| 硬闸门键 | 只有 `focus`（逐子题）；`coverage`/`independent` 降为反馈信号 | `DECOMPOSE_DEFAULTS.hardKeys` |
| 证据包上限 | 4000 字符 / 6 段 | `CHAIN_DEFAULTS.maxChars` |

---

## 怎么用（两条路径）

### A. 在 DSH 会话里跑一个研究主题（**preset 层**，推荐）

插件在 **preset 层**，不在 host 层。这不是风格问题：Web 会话是**按 agent preset
逐代理组合工具**的，host 行不会进到会话里的 agent。早先那版（以及 parked eval 里的
armA）走的是 host 层 `insert` —— 那在 `dsh-headless` 下能用（headless 不挂
agent-presets roster），但在你真正使用的 GUI 会话里工具根本不会出现。

```bash
# 从仓库根执行
node packages/dsh-hema-v2/preset/sync-preset.mjs   # 生成 composition 装进 <DSH_HOME>/.agent-presets/hema-v2/
node packages/dsh-hema-v2/preset/install.mjs       # junction 插件包进 web profile + 写 link 依赖
node packages/dsh-hema-v2/preset/verify-mount.mjs  # 让 roster 自己判断能不能挂载
```

然后**重启 DSH Host**，在 preset 选择器里选「**HEMA v2 研究链路**」，说一句研究题目即可。
模型会依次调用 `hema_start` → `hema_decompose_check` → （为每条子题起 researcher 子代理）
`hema_verify` → `hema_report_check` → `hema_finish`。

### B. 外部 CLI 驱动（无头，用于批量与对照）

```bash
node packages/dsh-hema-v2/probes/run-all.mjs                        # 全量离线回归（487 项断言）
node packages/dsh-hema-v2/harness/run.mjs --question "..." --jev fixture   # 端到端（合成裁决）
node packages/dsh-hema-v2/harness/run.mjs --question "..." --jev http      # 端到端（真 JEV）
```

这条路径用**隔离的 `DSH_HOME`**（`.dsh-home/`）与 host 层 `insert` 行，
三个角色各有独立 profile。它现在只当**测试与对照**用 —— 真正要给你用的入口是 A。

产物落在 `out/sessions/<runId>/`（preset 路径）或 `out/<runId>/`（CLI 路径）：

```
00-trace.md          全链路时间线（人可读，含逐条裁决）
04-report.md         最终报告
00-audit.json        汇总审计
00-events.jsonl      事件流（可重放）
01/02/03/04-*.json   分阶段结构化记录
jev-calls.jsonl      每次 JEV 调用（**含喂进去的 state 全文**）
roles/               每个角色每次调用的 prompt / stdout / reasoning 原文
```

`--sub-questions '<JSON>'` 可以传入你自己编辑的分解。**用户编辑的分解不再重新检查** ——
人改完了还要被验证器否决，人就没有决定权了。

---

## 三种判官模式

| 模式 | 裁决从哪来 | 能验什么 | 不能验什么 |
|---|---|---|---|
| `stub` | 词袋启发式 | 管道形状、抓取、切片、预算、轮数 | **裁决质量** |
| `fixture` | 断言文本的稳定哈希（可复现） | 裁决**路由**：接受/打回/冻结/悬置/报告汇总 | **裁决质量** |
| `http` | 真 JEV | 全部 | —— |

**为什么需要 fixture 而不只有 stub**：实测发现 `stub` 对真实内容是坏的尺子。
断言是中文（「怒击的起手动作自右肩发起」），证据是 Meÿer 1570 的德文正文；
中文 bigram 在德文里永远不可能出现，覆盖率只能到 ~0.4，
于是**无论断言好坏都落在不通过区**，真实内容跑下来永远是"全被拒"，
通过路径一次都走不到。`fixture` 把「裁决质量」与「裁决路由」解耦，
用可控且可复现的混合裁决把整条流转验通。

## 已验证 / 未验证

**已用 487 项断言验证**（`node packages/dsh-hema-v2/probes/run-all.mjs`）：

| 套件 | 断言数 | 验什么 |
|---|---|---|
| `probes/test-jev` | 37 | JEV 契约与阈值判定 |
| `probes/test-chain` | 68 | 单链轮数封顶、冻结、逐条证据诊断 |
| `probes/test-decompose` | 53 | 分解悬置、硬闸门、用户编辑接受 |
| `probes/test-report` | 67 | 报告后置检查与代码兜底 |
| `probes/test-logging` | 28 | 全链路留痕（每次 JEV 调用含 state 全文） |
| `probes/test-plugin` | 88 | 12 个工具体 + **schema 合法性** + 产物齐全 |
| `probes/test-data-tools` | 47 | 6 个数据层工具（含真网络取数） |
| `preset/verify-preset` | 35 | preset 结构（与 standard 逐行对比、白名单、`maxDepth` 能真正起子代理） |
| `preset/verify-mount` | 9 | **让 roster 自己判断能不能挂载**（调 `dsh-agent-presets` 的 `scanRoot`） |
| `harness/verify-profiles` | 35 | 隔离 profile 的角色能力边界（CLI 路径） |
| `harness/run --self-test` | 20 | CLI 接线自检 |

> `run-all.mjs` 的统计不是只数 `ok`/`FAIL` 行。脚本中途抛异常会让输出**截断**，
> 于是 ok 变少、fail 仍为 0，和"全部通过"长得一模一样 —— 实测被这个坑过一次
> （探针里引用了不存在的函数，统计显示 0 项失败，实际后半段根本没跑）。
> 所以判据是退出码 0 + 打印了终止行 + FAIL 为 0，外加 ok 数不低于写死的基线。

**真 JEV 实测结论**（`node probes/probe-jev-live.mjs`，5 次调用，每次 0.4–1.0s）：

| 用例 | 真 JEV 裁决 |
|---|---|
| 证据明确支持 | `SUPPORTED` p=0.95–0.96 |
| 证据完全无关 | `NOT_IN_SOURCE` p=1.00 |
| 证据表达**相反**意思 | `CONTRADICTED` p=1.00 |
| 「Zornhau 很重要」 | 具体性质量 **0.00** |
| 半空泛 | 质量 **0.45** |
| 具体可查证 | 质量 **0.99** |

它把反向断言识别成「相反」而不是「无关」——是语义判定，不是关键词匹配；
具体性的概率质量和单调，说明「可接受等级质量和」这个判定方式是对的。

**未验证（只有你能做）**：

- **JEV 的裁决质量**：A/B/C 三组问题是否真的能把好断言与坏断言分开、
  阈值 0.7 是否合适、`score` 类的"概率质量和"判定是否合理。
  链路里所有 JEV 调用都记在 `out/jev-log.jsonl`，可直接用于这一步。

## 按实测删掉/改掉的东西（都有数据，不是拍脑袋）

一次真实 run（"长剑技术的社会使用群体与情景"，199 次 JEV 调用）给出的证据：

| 改动 | 依据 |
|---|---|
| **删除跳转器**（`lib/jump.mjs`、`lib/seeds.mjs`、`hema_jump`） | 186 次跳转调用只收到 **7 个页面**（26.6 次/页）；`relevance` 中位数 **0.19**、仅 4% ≥0.7；`next` 最高候选概率中位数 **0.385**、**52% 的步数 <0.4**（≈在候选间瞎猜）。占全 run 93% 的调用量，产出极低。`maxDepth: 0 → 1` 已让 researcher 能自己检索，精度不再靠跳转器 |
| **删除 `answerable_*`**（不是降级） | 四个子题目（含明显的后世社会史问题）全部拿到 p=**0.95–1.00**；而同一批子题目的实际证据可得性中位数只有 0.19。它对"能不能取到证"**没有预测力** |
| **`coverage`/`independent` 降为反馈信号** | 结构良好的分解 coverage 只有 0.59–0.63（阈值 0.7），糟糕分解 0.51 —— 既不过阈值、区分度也弱；另一次 run 里 independent 判 0.20，若当硬闸门会让那份**可用**的分解直接悬置。现在 `hardKeys = ['focus']` |
| **研究者 `maxDepth: 0 → 1`** | `maxDepth` 是**子代理自身的深度上限**：主会话 depth 0、子代理 depth 1，所以 0 等于禁止创建任何子代理。真机上三次 `hema_researcher` 全部报 `subagent depth 1 exceeds maxDepth 0`，模型只好自己把活干完，看起来就像"没起 subagent"。旧断言把 `maxDepth === 0` 写成了绿勾，等于把我的误解固化成了测试 |
| **JEV 的 `score` 按浮点理解** | 真 JEV 的 `score` 是**浮点期望值**（0.69 / 1.48 / 2.93），不是整数索引，且**不返回 `scoreLabel`** —— 标签必须由概率分布 argmax 推出 |
| **数据层并进本插件，`@ghogiel/dsh-weinao` 退役** | 一个 preset 里挂两个包、且 wiki 工具来自另一个包，会让"researcher 的白名单"跨包漂移。6 个数据工具直接注册在本插件里，preset 只需一行 |

## 已知缺口（有意的选择，不是遗漏）

1. **A 组的 `coverage`/`independent` 只是反馈信号**（`hardKeys: ['focus']`）。
   依据见上表。它们仍然**喂给 leader 促其改进**，但不单独否决整次分解；
   硬闸门只留逐子题的 `focus_*`。要改回全闸门：插件行配置
   `hardKeys: ['coverage','independent','focus']`。
2. **报告泄漏检查是词面代理，且刻意收得很紧**。它只认程序生成的无歧义引用标记
   （正文里原样出现 `Page#Anchor` 或 `Page @revid`）。原因是两次实测教训：
   悬置来源多是整页定位符，页面名就是传本名或大师名（Jobst von Württemberg / Joachim Meyer），
   而锚点显著词里含泛用英文词（`treatise`）—— 这类词出现在 HEMA 报告正文里完全正常，
   见名字就判泄漏会让撰写者**永远无法合格**。所以它抓"把定位符抄进正文"，
   **抓不到**"把悬置内容改写成断言融进正文"—— 那种只能靠人判。
   真正兜住诚实性的是悬置节的强制完整性，不是这一条。
3. **JEV 会偶发挂起**。实测一次 120s 超时，同批其余调用只要 0.4–0.6s。
   验证调用沿用 120s 超时 + 轮内重试。
4. **`on_topic` 问法尚未替换（等决策）**。实测它的 0.7 阈值没有参考性：中位数 0.78、
   55–58% 落在 0.55–0.85，且**同一 state 问两遍有 31% 的判定翻转**（噪声底）。影子测试
   （`probes/probe-ontopic-shadow.mjs`，同 state 换问题重问 120 个断言）显示：
   把它拆成三个二元判断**更糟** —— `answers_atom` 只 5% 通过、`same_scope` **0%** 通过
   （都会否掉几乎全部合法断言），`self_contained` 98% 通过（饱和，白花配额）。
   极性对照证实问题本身是对称的（正问 0.21 / 反问 0.67，平均和 0.898），所以低通过率是
   真实内容判断：**这批断言 88% 是"提供证据"而非"直接回答"**（三选项 choice 实测
   answers 12 / evidence 106 / unrelated 2）。建议改成三选项 `choice`、闸门取"非 unrelated"
   （98% 通过、翻转区 0%、重复翻转 4%）。**尚未实施，等确认。**
5. **`hema_report_check` 只做一遍校验，没有"打回重写"的轮次循环**。
   CLI 路径有（`runReport` 最多 3 稿），preset 路径把重写交给模型自己判断
   —— 因为模型的每一稿都是一次完整对话，让它自己看着问题清单改更自然。
   代码兜底（`enforceSuspension`）两条路径都有，所以终稿一定带完整悬置节。

## 文件

```
index.js            **preset 层插件**：12 个工具，全部硬规则在此
lib/wiki.mjs        Wiktenauer 客户端：节配对（stage-0.1 发现）、解引用、选段
lib/glossary.mjs    术语表 CN→DE/EN 归一化
lib/jev.mjs         JEV 客户端 + A/B/C 三组问题契约 + 阈值判定 + 逐条证据诊断 + stub/fixture 判官
lib/evidence.mjs    证据-断言包：规范化、解引用、state 拼装、确定性 precheck
lib/chain.mjs       单链重试环
lib/decompose.mjs   分解控制环 + 悬置 + 用户编辑接受 + hardKeys 闸门
lib/report.mjs      报告后置检查 + 代码兜底强制悬置节
preset/hema-v2/{preset.yml,agent.cordis.yml}   agent-plane 组合
preset/sync-preset.mjs  生成 composition 并装进 <DSH_HOME>/.agent-presets/
preset/install.mjs      junction 插件包进 profile + 写 link 依赖
preset/verify-preset.mjs 结构校验（与 standard 逐行对比）
preset/verify-mount.mjs  调 roster 的 scanRoot 验证可挂载
harness/trace.mjs           全链路时间线渲染
harness/provision.mjs       隔离 DSH_HOME + 三角色 profile 生成器（CLI 路径用）
harness/dsh.mjs             headless 角色调用器（CLI 路径用）
harness/roles.mjs           三角色提示词 + 结构化输出提取（CLI 路径用）
harness/run.mjs             端到端编排 CLI
harness/env.mjs             .env 读取（只报存在性，不回显密钥）
harness/verify-profiles.mjs 角色能力边界验证
harness/test-role-call.mjs  角色调用冒烟（4 次模型调用）
probes/analyze-run.mjs      统计一次 run 里各环节 JEV 概率分布（阈值是否合理的证据）
probes/probe-ontopic-shadow.mjs  on_topic 问法的影子测试（同 state 换问题重问）
probes/run-all.mjs          全量回归（带截断检测）
data/glossary.md            术语表
```

### 两个必须照做的调用细节（都是踩过的坑）

1. **不 spawn `dsh.cmd`**。Node 20+ 在 Windows 上拒绝 spawn `.cmd`/`.bat`（EINVAL，
   CVE-2024-27980 缓解），必须用 `node` + 解析出的 `@deepseek-ai/dsh/lib/bin.js`。
2. **stdout/stderr 走文件描述符，不走管道**（`spawnSync` 默认就是管道）。
   受限环境下管道 stdio 会被拒绝；用 `openSync` 直接给子进程写文件既绕开限制，
   又天然留下可审计的原始输出。

### 改插件时的两个坑

**① `parameters` 必须是完整的 JSON Schema。**
本插件为零依赖用**普通对象注册**，而不是 `defineTool()`。
区别很关键：`defineTool()` 会把 `{ 参数名: {type, required} }` 简写**规范化**成 JSON Schema，
普通对象注册则把 `parameters` **原样**送给模型。于是简写会直接炸在真机上：

```
Invalid schema for function 'hema_decompose_check':
schema must be a JSON Schema of 'type: "object"', got 'type: null'
INVALID_REQUEST
```

`type: null` 就是因为简写没有顶层 `type`。现在用 `props()/str()/bool()/objArray()` 拼规范 schema，
并且 **`probes/test-plugin.mjs` 里有一节专门校验它**（要求顶层 `type: "object"`、
每个属性有 `type` 与 `description`、数组带 `items`、`required` 都在 `properties` 里，
且不用联合类型）。这一节是被真机打脸后补的 —— 当时全部断言全绿却照样挂不上，
因为离线套件只检查了"有没有 parameters"，没检查"它是不是合法 schema"。

**② 改插件*代码*之后必须重启 Host；改 preset *目录*不用。**
- preset 能不能被**发现**：roster 的 `list()` 每次都重新扫描 `.agent-presets/`，**不缓存** ——
  新装/改名的 preset 刷新页面就能看到。
- 插件模块：宿主进程一旦 import 过就进了 Node 的 ESM 缓存，且 base 里 `hmr` 是 `disabled` 的，
  所以**代码改动不会热生效**。表现为：修好了、测试全绿，但会话里还是旧行为。

  这个坑实测连吃两轮 —— 第一次我说"刷新页面即可"（那句只对 preset 发现成立），
  结果报错一字不差地复现。判断办法只能是**比对进程启动时间**：
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 看 `CreationDate` 是不是早于
  你改代码的时间。刷新浏览器**不会**重启 Node 进程。

  为此插件有**版本路标**：`hema_start` / `hema_status` 的返回里带 `pluginVersion`
  （当前 `0.2.0`），`apply()` 也会往宿主日志打一行
  `hema-v2 v0.2.0: 已注册 12 个工具（...）`。
  跑一次 `hema_start` 看版本号，就知道跑的是哪一版。改行为时记得同时 bump
  `index.js` 的 `VERSION` 与 `package.json` 的 `version`（离线套件会校验两者一致）。

### 改 profile 配置时的一个坑

`permission-presets` 在**构造时**校验「沙箱模式 + 批准策略」必须命中预设表，
否则 boot 直接失败：

```
permission: composed sandbox and approval defaults match no preset
```

而 `--dump-config` 只组合配置树、不加载插件，**它能通过而启动照样失败**。
所以 `harness/provision.mjs` 显式加了一个 `unattended-readonly` 预设
（`read-only` + `never`：无人值守且不弹批准，越权调用直接失败而不是挂住等人），
并把三个标准预设原样重述（patch 是整体替换 config，不是合并）。
`verify-profiles.mjs` 里那一轮真启动就是为挡这类错误。
