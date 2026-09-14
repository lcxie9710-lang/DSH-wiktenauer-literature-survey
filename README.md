# 维脑 Agent (Weinao) — dsh-weinao

维脑 Agent 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 **HEMA（历史欧洲武术）文献检索工具插件**。

它为 dsh agent 提供 **Wiktenauer 文献检索能力**：搜索并阅读 [Wiktenauer](https://wiktenauer.com) 武术古籍文库、维护本地双语（中↔德/英）术语表。安装后，任何会话仍保持原本的角色和对话策略，只是在遇到 HEMA 相关问题时多了一套可用的查询工具。

一切运行在**你的 dsh 进程本地**——没有服务器、没有额外 API key（除了 dsh 本身的模型凭据）、没有第三方服务。插件直接对接 Wiktenauer 公共 MediaWiki API。

## 安装

> dsh 0.1.2+ 按 **agent preset** 组织每个会话的模型面工具。weinao 是纯 agent
> 平面插件，**不声明 `dsh.bundle`、不提供 cordis.patch.yml**——按官方规范，
> 工具行由你复制出的 preset 挂载，而不是注册进 host 全局层（那会把工具漏给
> 每一个 preset，包括极简模式）。

### 1. 安装包（作为 profile 的普通依赖）

```sh
dsh plugin --profile web add @ghogiel/dsh-weinao
```

包不声明 `dsh.bundle`，`dsh plugin` 会提示 "activates no layer"——这是预期
且正确的：包只作为依赖存在，不参与 host 组合层叠，`dsh.profile.bundles`
保持不变。

### 2. 复制一个 preset 并挂载 weinao

shipped preset 是只读基线，复制到用户自建根再编辑：

```sh
# 复制 standard → 用户自建根（或在 GUI 预设管理里复制）
cp -r <dsh安装>/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard \
      ~/.dsh/.agent-presets/hema
```

在 `~/.dsh/.agent-presets/hema/agent.cordis.yml` 末尾追加：

```yaml
# ── 维脑 HEMA 文献工具（仅本 preset 可见）────────────
- id: weinao
  name: '@ghogiel/dsh-weinao'
  config: {}
```

新建会话时选择该 preset 即有 HEMA 工具；官方 preset（极简/标准/cordis/ptc）
保持纯净。也可在 `~/.dsh/settings.yaml` 设默认：

```yaml
agent-presets:
  default: hema
```

> **升级提示**：shipped preset 会随 dsh 版本变化。例如 0.1.5 把 `dsh-persona`
> 的 `text` 改成了必填的 `prefix`（+ 可选 `suffix`），并新增了 `present` 工具行。
> dsh 升级后自建 preset 若报 `invalid config: $.prefix missing required value`，
> 按当前 shipped `standard` 重新复制一次再追加 weinao 行即可。

## 功能

### 六个工具

| 工具 | 作用 | 什么时候用 |
|---|---|---|
| `wiki_search` | Wiktenauer 全文搜索，返回标题 + 摘要 | 每个问题的第一步 |
| `wiki_get_page` | 读取某页完整纯文本（精确标题匹配） | 搜索后，读最佳命中页 |
| `wiki_prefix_search` | 前缀标题搜索 | 术语消歧、拼写变体、空搜索结果兜底 |
| `wiki_get_links` | 获取某页的内部链接 | 发现关联古籍/概念 |
| `glossary_lookup` | 按需查询本地术语表（某词的全部映射，含置信度与状态） | 翻译 HEMA 术语前，保持既有译法一致 |
| `glossary_add` | 记录新推断的术语映射（标记为待确认） | 术语表无该词、且已推断出译法时 |

每个工具返回**结构化规范值**（不是散文），模型看到的是渲染后的文本，程序化调用方拿到的是干净数据。

### 工具使用指引

插件**不注入系统提示词分段**——工具的使用方法写在各自的 `description` 里，随
工具 schema 自动进入提示词组装。这样插件不必与内置提示词段争抢排序位置，也不会
给每次请求增加固定文本成本。

### 本地术语表

双语术语映射存储（如 交击 → Zwerchhau），以纯 JSON 文件持久化在 `$DSH_HOME/wiktenauer/glossary.json`（或 `~/.dsh/wiktenauer/`）。

**按需查询，不全量注入**：术语表通过 `glossary_lookup` 查询、`glossary_add`
记录。把整张表塞进 system prompt 会让每次请求的成本随术语表增长——这是刻意
避免的设计。

存储层支持的映射状态：

- 模型推断出的新译法记为 `llm_inferred`（置信度 0.5，待用户确认）
- 用户确认的映射 `confidence +0.3` 并标记为可信
- 用户拒绝的映射扣置信度；累计 3 次拒绝后移除
- `glossary_add` 对同一源词拒绝重复添加，返回既有映射供复用

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `glossaryDir` | `$DSH_HOME/wiktenauer` | 术语表 JSON 文件所在目录 |

示例（在 preset 的 `agent.cordis.yml` 里）：

```yaml
- id: weinao
  name: '@ghogiel/dsh-weinao'
  config:
    glossaryDir: /data/hema
```

## 项目起源

这是 **HEMA Question Agent**（原为 FastAPI + Claude Code CLI 包装）的 agent 核心移植，变成一个自包含的 dsh 插件。四个 wiki 工具和术语表逻辑直接移植自 `wiktenauer_mcp.py` / `glossary_store.py`；FastAPI / 付费 / 认证 / 限流层有意去掉——dsh 提供运行时、会话日志和工具执行管线。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

wiki 客户端和术语表零依赖（Node 内置 + 全局 `fetch`），纯逻辑部分无需完整 dsh 安装即可冒烟测试：

```sh
node --experimental-strip-types -e "import('./src/wiktenauer.ts').then(m => m.wikiSearch('Liechtenauer', 2)).then(r => console.log(r))"
```

已对 Wiktenauer 真实 API 验证（搜索 / 读页 / 前缀搜索 / 链接 / 缺失页错误），并对照
`@deepseek-ai/dsh-tools@0.1.5-rc.2` / `@deepseek-ai/dsh-session@0.1.5-rc.2` /
`@deepseek-ai/cordis@4.0.2` 类型定义做过类型检查。
注意：全文搜索只匹配 Wiktenauer 上的精确拼写——历史变体（如 `Zwerchhau` 对应 Wiktenauer 的 `Zwerchhaw`）会返回空，这正是模型应该回退到 `wiki_prefix_search` 的时刻（工具 description 已提示模型）。

## 许可

MIT
