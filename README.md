# 维脑 Agent (Weinao) — dsh-weinao

维脑 Agent 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 **HEMA（历史欧洲武术）文献研究插件**。

它把任何 dsh agent 变成一个 **Wiktenauer 文献研究助手**：搜索并阅读 [Wiktenauer](https://wiktenauer.com) 武术古籍文库、维护本地双语（中↔德/英）术语表、教会模型"先检索、再引用"的研究工作流。

一切运行在**你的 dsh 进程本地**——没有服务器、没有额外 API key（除了 dsh 本身的模型凭据）、没有第三方服务。插件直接对接 Wiktenauer 公共 MediaWiki API。

## 安装

```sh
dsh plugin --profile web add @ghogiel/dsh-weinao
```

或者不通过 plugin 命令，把下面这几行加进你的 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-weinao
      name: '@ghogiel/dsh-weinao'
```

## 功能

### 四个工具

| 工具 | 作用 | 什么时候用 |
|---|---|---|
| `wiki_search` | Wiktenauer 全文搜索，返回标题 + 摘要 | 每个问题的第一步 |
| `wiki_get_page` | 读取某页完整纯文本（精确标题匹配） | 搜索后，读最佳命中页 |
| `wiki_prefix_search` | 前缀标题搜索 | 术语消歧、拼写变体、空搜索结果兜底 |
| `wiki_get_links` | 获取某页的内部链接 | 发现关联古籍/概念 |

每个工具返回**结构化规范值**（不是散文），模型看到的是渲染后的文本，程序化调用方拿到的是干净数据。

### 领域工作流（prompt 分区）

插件注册 `hema-workflow` prompt 分区，它：

- 强制"搜索 → 读页 → 综合 → 引用"的流程
- 要求每条事实声明后带 `[Page Title]` 引用
- 非 HEMA 问题直接礼貌拒绝（不调用工具）
- 注入当前术语表上下文（已确认映射标为可信，推断映射标为待确认）

### 本地术语表

双语术语映射存储（如 交击 → Zwerchhau），以纯 JSON 文件持久化在 `$DSH_HOME/wiktenauer/glossary.json`（或 `~/.dsh/wiktenauer/`）。

- 模型推断出新翻译时自动追加（`llm_inferred`）
- 用户确认的映射 `confidence +0.3` 并标记可信
- 用户拒绝的映射扣置信度；累计 3 次拒绝后移除
- prompt 上下文把已确认映射显示为「已确认术语映射（可信）」，推断映射显示为「LLM 推断映射（待确认，可用但必须告知用户）」

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `glossaryDir` | `$DSH_HOME/wiktenauer` | 术语表 JSON 文件所在目录 |
| `sectionOrder` | `1000` | prompt 分区顺序（越小越靠前；persona 是 0） |

示例：

```yaml
- insert:
    - id: dsh-weinao
      name: '@ghogiel/dsh-weinao'
      config:
        glossaryDir: /data/hema
        sectionOrder: 900
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

已对 Wiktenauer 真实 API 验证（搜索 / 读页 / 前缀搜索 / 链接 / 缺失页错误），并对照已发布的
`@deepseek-ai/dsh-tools@0.1.0-rc.7` / `@deepseek-ai/dsh-session@0.1.0-rc.7` /
`@deepseek-ai/cordis@4.0.1` 类型定义做过类型检查（即 `@deepseek-ai/dsh` 随附的版本）。
注意：全文搜索只匹配 Wiktenauer 上的精确拼写——历史变体（如 `Zwerchhau` 对应 Wiktenauer 的 `Zwerchhaw`）会返回空，这正是模型应该回退到 `wiki_prefix_search` 的时刻（工作流 prompt 已教给模型）。

## 许可

MIT
