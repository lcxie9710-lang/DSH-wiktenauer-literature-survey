# DSH Wiktenauer Literature Survey

用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）做 **HEMA
（欧洲历史武术）文献研究**：以 Wiktenauer（最大的 HEMA 传本库）为唯一证据来源，
由 **JEV**（`typesafe-ai/jev` 评估模型）逐条裁决研究者的断言，规则与轮数封顶写在代码里。

这个仓库是一个 pnpm monorepo，装两个 DSH 插件包：

| 包 | 作用 |
|---|---|
| [`packages/dsh-hema-v2`](./packages/dsh-hema-v2/README.md) | **HEMA v2 研究链路**。12 个工具：6 个 Wiktenauer 数据层 + 6 个链路控制层（preset 层插件） |
| [`packages/dsh-jev`](./packages/dsh-jev/README.md) | **JEV 评估模型工具**。一个 `jev_evaluate`，把闭式判断（概率 / 选择 / 评分）变成模型可调用的工具 |

两者都在 **preset 层**，不在 host 层 —— 见下面的「为什么必须是 preset 层」。

---

## 快速开始

```bash
git clone https://github.com/lcxie9710-lang/DSH-wiktenauer-literature-survey.git
cd DSH-wiktenauer-literature-survey

# 1. 给 JEV 配 key（JEV 走 Vercel AI Gateway）
echo "AI_GATEWAY_API_KEY=vck_..." > .env     # 见 .env.example

# 2. 一条命令接进本机 DSH
node install.mjs

# 3. 重启 DSH Host，然后开新会话，在 preset 选择器里选「HEMA v2 研究链路」
```

细节、排错、以及"为什么改了代码要重启"都写在 **[QUICKSTART.md](./QUICKSTART.md)**。

---

## 一条链路，三个角色，四道闸门

```
leader 把研究题目分解为方向集中的子题目
   ↓  闸门 ①  JEV A 组：分解是不是围绕题目、够不够聚焦
   │           ≤3 轮；仍不过 → 悬置，把问题交回给你（不假装通过）
   │           ★ 你自己编辑过的分解**不再重新检查**
   ↓
每条子题一条链（researcher 是 continuable 子代理，保留自己的对话）：
   researcher 自己检索取证 → 产出「断言 + 证据定位符」包
      ↓  闸门 ②  确定性 precheck：定位符解不出来 = 证据不成立，硬拦，连 JEV 都不问
      ↓  闸门 ③  JEV B+C 组：证据是否支持 / 与命题是什么关系 / 是否够具体（阈值 0.7）
      │          「关系」是三选项：直接回答 / 提供证据 / 无关 —— **只有"无关"不通过**
      │          判否 → 逐条证据诊断（指出是哪个来源不支持）
      │               → send_message 回同一对话改证据或改断言；≤3 轮
      │          仍不过 → 证据悬置
   ↓
报告撰写者只依据**已通过**的证据-断言写报告
   ↓  闸门 ④  确定性后置检查 + 代码兜底**强制**补齐「证据悬置」节
```

**没有** Skeptic、没有全局反证搜索、没有 Synthesizer、**没有跳转器** —— 后三者的删除
都有实测数据支撑，见 [`packages/dsh-hema-v2/README.md`](./packages/dsh-hema-v2/README.md#按实测删掉改掉的东西都有数据不是拍脑袋)。

### 证据只有一种形态

```
断言 = 一段文本
证据 = { page, anchor, revid }      ← 指向 wiki 某页某节某版本
```

**不摘录任何原文。** 证据在全系统里始终以定位符传递；只有需要 JEV / LLM 处理时，
才由程序去定位符指向的位置提取、拼装成 `state` 发出去。这不是洁癖 —— JEV 是
evaluation model，**没有 context、没有 memory**，要判的东西必须整个塞进 `state`，
所以"何时把指针变成文本"必须是一个显式动作，否则证据会以自由文本形式漂流，
既无法审计也无法钉版本。

### 硬规则在代码里，不在 prompt 里

轮数封顶、冻结、悬置、定位符硬拦、报告兜底、角色能力边界 —— 全部是代码。
`hema_verify` 想做第 4 轮会直接拒。

原因很实在：DSH 的 `sendMessage` 只确认送达、**不返回子代理的答案**，
subagent service 上也没有 public 的 await-settlement。continuable 子代理拿得到持久化，
却无法被代码 `await`；能 await 的只有 one-shot。于是分工落回那句话 ——

> **Harness = 插件（持有状态、调 JEV、执行封顶）；Agent = 决策者与工人。**

researcher 只拿 6 个数据工具（`toolFilter.allow`），且**没有 fs / shell / web / 编排工具** ——
它不能把原文摘抄成文件，也不能绕开轮数封顶自己再开子代理。

### 为什么必须是 preset 层

Web 会话是**按 agent preset 逐代理组合工具**的，host 层的 `insert` 行
**不会进到会话里的 agent**。host 层那套在 `dsh-headless` 下能用
（headless 不挂 agent-presets roster），但在真正使用的 GUI 会话里工具根本不会出现。
所以两个包都**不声明 `dsh.bundle`**，也不提供 `cordis.patch.yml`：
它们是普通 profile 依赖，只有 preset 里那一行能让工具可见。

---

## 仓库结构

```
.
├─ package.json                 pnpm workspace 根（脚本入口）
├─ pnpm-workspace.yaml
├─ install.mjs                  一条命令装进本机 DSH_HOME（两个包 + 清理 v1 遗留）
├─ QUICKSTART.md
├─ .dsh-home/                   CLI 路径用的隔离 DSH_HOME（gitignore，可删）
└─ packages/
   ├─ dsh-hema-v2/              研究链路
   │  ├─ index.js               preset 层插件：12 个工具
   │  ├─ lib/                   wiki 客户端 / JEV 契约 / 证据包 / 链环 / 分解环 / 报告检查
   │  ├─ preset/                preset 生成、安装、结构校验、挂载校验
   │  ├─ harness/               无头 CLI 路径（隔离 DSH_HOME + 三角色 profile，测试与对照用）
   │  ├─ probes/                离线回归套件 + 实测探针
   │  └─ data/glossary.md       术语表
   └─ dsh-jev/                  JEV 工具
      ├─ index.js
      ├─ preset/                conditioned-reflex preset
      ├─ references/            AI Gateway 与 JEV 的协议笔记
      └─ verify*.mjs            三组验证脚本（含真网关调用）
```

## 验证

```bash
pnpm test          # 或 node packages/dsh-hema-v2/probes/run-all.mjs
```

**499 项断言，0 失败，0 条套件异常。** 分套件明细见
[`packages/dsh-hema-v2/README.md`](./packages/dsh-hema-v2/README.md#已验证--未验证)。

`run-all.mjs` 的统计不是只数 `ok`/`FAIL` 行：脚本中途抛异常会让输出**截断**，
于是 ok 变少、fail 仍为 0，和"全部通过"长得一模一样（实测被这个坑过一次）。
所以判据是**退出码 0 + 打印了终止行 + FAIL 为 0**，外加 ok 数不低于写死的基线。

单独验 JEV 插件（**会真调网关**，一次全跑约 $0.00005）：

```bash
pnpm jev:verify        # node packages/dsh-jev/verify.mjs
```

## 本地环境要求

- Node ≥ 20（`spawn` `.cmd` 的限制、以及 ESM 行为都按 20+ 写的）
- pnpm
- 本机已装 DSH（`npx @deepseek-ai/dsh` 或全局 `dsh`）
- `AI_GATEWAY_API_KEY`（JEV 走 Vercel AI Gateway）

> **密钥**：`.env` 已在 `.gitignore` 里。JEV 的 key 解析顺序是
> 插件行 `config.apiKey` → `process.env[apiKeyEnv]` → DSH 凭据库 → `.env`，
> 每次调用重新解析，所以轮换 key 下一次请求就生效。

## License

MIT
