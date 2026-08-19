# 错误分析定位与修复验证报告

> 项目：`@ghogiel/dsh-weinao`（维脑 Agent）—— DeepSeek Harness (DSH) 插件
> 问题版本：`0.1.0`　修复版本：`0.1.1`
> 日期：2026-08-20

---

## 0. 追加修复（0.1.2）：User-Agent 中文字符导致全部请求本地失败

> 问题版本：`0.1.1`　修复版本：`0.1.2`　日期：2026-08-20

### 0.1 现象

工具调用全部返回：

```
Error: Unable to connect to Wiktenauer API. The service may be temporarily unavailable.
```

网络实测正常（DNS 解析成功、Node 原生 `fetch` 返回 HTTP 200）。

### 0.2 根因

`src/wiktenauer.ts` 的 User-Agent 含中文字符：

```ts
export const USER_AGENT = 'dsh-weinao/0.1.0 (维脑 Agent HEMA research plugin)'
```

undici `fetch` 强制 header 值为 Latin-1 字节串，`维脑`（码点 32500 > 255）导致 `fetch` 在**发请求前**抛出本地 `TypeError`：

```
TypeError: Cannot convert argument to a ByteString because the character
at index 18 has a value of 32500 which is greater than 255.
```

而 `makeRequest` 的 catch 块把所有 `TypeError` 一律映射为"服务不可用"，本地编码错误被误报为网络故障。

### 0.3 修复

1. UA 改为纯 ASCII：`dsh-weinao/0.1.2 (Weinao Agent HEMA research plugin)`
2. 错误分类细化：仅 `TypeError` 消息含 `fetch failed`（undici 网络失败特征）才报"服务不可用"；本地 TypeError 报 `Wiktenauer API request invalid: ...`
3. 新增回归测试：断言 `USER_AGENT` 所有字符码点 ≤ 0xff

### 0.4 验证

- typecheck / 11 项 vitest（含新回归测试）/ build 全部通过
- 修复后真实 API 冒烟：`wikiSearch('Liechtenauer')` 返回命中、`wikiPrefixSearch('Zwer')` 返回 `Zwerch / Zwerchau / Zwerchhaw`

---

## 1. 概述

`@ghogiel/dsh-weinao` 在 DSH profile 中运行时会反复出现两个报错，导致插件无法正常调用工具。排查确认两个报错是**同一个根因的上下游**：插件把 `@deepseek-ai/dsh-tools` 声明成了普通 `dependencies`，导致 profile 内出现了第二份 `dsh-tools`，破坏了 DSH 基于 `unique symbol` 的调度器查找，进而触发崩溃，崩溃留下的"悬空 tool_calls"又在下一轮被 DeepSeek API 拒收。

修复方式：将 `@deepseek-ai/dsh-tools` 从 `dependencies` 移入 `peerDependencies`（与官方 `tool-bash` 插件一致），重新发布为 `0.1.1` 并重装，验证通过。

---

## 2. 现象（Symptoms）

插件运行时反复出现两个错误：

| # | 报错 | 来源 |
|---|------|------|
| 1 | `Cannot read properties of undefined (reading 'prepare')` | harness 内部（agent-loop 调度器） |
| 2 | `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)` | DeepSeek API 侧校验 |

其中错误 2 是**结果**，错误 1 是**主因**。

---

## 3. 报错触发条件分析

### 3.1 错误 1：`Cannot read properties of undefined (reading 'prepare')`

触发条件是：`ctx.tools[TOOL_RUNTIME_SCHEDULER]` 取值为 `undefined`，随后在其上访问 `.prepare()`。

关键代码 `packages/core/agent-loop/src/tool-calls.ts`：

```ts
// 第 152-153 行（收尾阶段）
? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result)
: ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result)

// 第 169 行（崩溃点）
const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
```

`TOOL_RUNTIME_SCHEDULER` 的定义在 `packages/core/tools/src/index.ts:466`：

```ts
export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('@deepseek-ai/dsh-tools.scheduler')
```

它是用 `Symbol()` 创建的 **unique symbol**，而非 `Symbol.for()`。`Symbol()` 每次模块加载都会生成一个**全新的、仅在该模块实例内可索引**的符号身份；`Symbol.for()` 才会用字符串做全局注册表查找。

`ToolRuntime` 服务实例通过同名符号挂载调度器 `packages/core/tools/src/index.ts:787,796`：

```ts
export class ToolRuntime extends Service {
  readonly [TOOL_RUNTIME_SCHEDULER]: ToolRuntimeScheduler = {
    prepare: ..., dispatch: ..., finalize: ..., finish: ...,
  }
  // ...
}
```

因此，**当读取方与写入方各自持有不同 `dsh-tools` 模块实例时，二者 `TOOL_RUNTIME_SCHEDULER` 符号身份不一致**，跨副本的 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 查找落空，得到 `undefined`。

### 3.2 错误 2：`insufficient tool messages following tool_calls message`

这是 DeepSeek chat-completions 协议侧的校验：**wire 请求里出现带 `tool_calls` 的 assistant 消息，但后续没有为每个 `tool_call_id` 提供对应的 `role:'tool'` 消息**。

在本场景中的触发链路：

1. `packages/core/agent-loop/src/agent.ts:382` 先把带 `tool_calls` 的 `assistant/message` 写入会话；
2. `agent.ts:395` 才调用 `executeToolCalls()`；
3. `executeToolCalls` 内部在 `tool-calls.ts:169` 崩溃（错误 1），工具结果**永远不会写回**；
4. 但那条带 `tool_calls` 的 assistant 消息已经**持久化在会话里**；
5. 下一轮 `serializeMessages`（`packages/llm/llm-deepseek/src/serialize.ts:112`）把会话投影到 wire 时，输出了带 `tool_calls` 的 assistant 消息，却没有任何匹配的 `role:'tool'` 消息；
6. DeepSeek API 拒绝请求，报 `insufficient tool messages following tool_calls message`。

---

## 4. 根因定位

### 4.1 DSH 的模块解析机制（双锚点 + symlink 回退）

`packages/boot/app-boot/src/profile.ts` 定义了 profile 的模块解析规则：

- **双锚点解析**：bundle 名先按「安装目录（npx 缓存的 harness 本体）」解析，再按「profile 目录」解析（`resolveBundleDir`，安装目录优先）。
- **symlink 回退目录**：`healProfilesModuleFallback`（`profile.ts:205-255`）维护 `$DSH_HOME/profiles/node_modules`，为 harness 依赖闭包里的每个包建一个 symlink，指向 npx 缓存里的**唯一真实副本**。
- **profile 的 pnpm 配置**（`profile.ts:138-143`）：`nodeLinker: hoisted` + `autoInstallPeers: false`。

设计意图（`profile.ts:133-136` 注释原文）：让 out-of-tree 插件通过 `profiles/node_modules` 的 symlink 回退，**与安装目录共享同一份 `cordis`/`dsh-*` 实例，而不是各自一份副本**。

### 4.2 问题出在哪：`dependencies` 制造了第二份副本

`@ghogiel/dsh-weinao@0.1.0` 的 `package.json` 把 `@deepseek-ai/dsh-tools` 写进了普通 `dependencies`：

```jsonc
"dependencies": {
  "@deepseek-ai/dsh-tools": "^0.1.0-rc.7",
  "@deepseek-ai/schemastery": "^3.18.1"
}
```

于是 pnpm 在 profile 里 hoist 出一份**真实目录**：

```
~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tools   ← 第二份（真实目录）
```

而 harness 本体（npx 缓存）自己另有一份：

```
AppData\...\_npx\1e7f6d9...\node_modules\@deepseek-ai\dsh-tools  ← harness 本体
~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools             ← symlink → 上面那份
```

Node 就近解析：插件的 `import '@deepseek-ai/dsh-tools'`（`dsh-wiktenauer/src/tools.ts:9`）先命中 profile 自己 `node_modules` 里的真实目录，**遮蔽了** symlink 回退。于是插件拿到的 `dsh-tools` 与 harness 核心（`agent-loop`、`ToolRuntime`）是**两份不同的模块实例**。

### 4.3 为什么两份实例会崩：`unique symbol` 身份不一致

`TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler')` 是模块级 `unique symbol`。两份 `dsh-tools` 模块实例各自生成**互不相等的符号身份**。调度器字段（`[TOOL_RUNTIME_SCHEDULER]`）在其中一个实例的符号下挂载，而读取方持有另一个实例的符号，跨副本索引 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 返回 `undefined`，`.prepare()` 因此崩溃。

> 结论：DSH 的整套运行时依赖「`dsh-*`/`cordis` 全局仅一份」这个前提，而 `unique symbol` 是这一前提的具体体现。普通 `dependencies` 打破了它，`peerDependencies` 则维持它（`autoInstallPeers: false` 时 peer 不被本地安装，运行时靠 harness 提供）。

---

## 5. 完整因果链

```
插件把 dsh-tools 写成普通 dependencies
        ↓
pnpm 在 profile hoist 出第二份 dsh-tools（真实目录，遮蔽 symlink 回退）
        ↓
插件与 harness 核心各自加载不同 dsh-tools 模块实例
        ↓
TOOL_RUNTIME_SCHEDULER（unique symbol）身份不一致
        ↓
ctx.tools[TOOL_RUNTIME_SCHEDULER] === undefined
        ↓
tool-calls.ts:169  →  Cannot read properties of undefined (reading 'prepare')   [错误 1]
        ↓
带 tool_calls 的 assistant/message 已落库，但工具结果未写回
        ↓
下一轮序列化出"悬空 tool_calls"、无 role:'tool' 响应
        ↓
DeepSeek API 拒收  →  insufficient tool messages following tool_calls message   [错误 2]
```

---

## 6. 修复方案

`dsh-wiktenauer/package.json` 将 `@deepseek-ai/dsh-tools` 从 `dependencies` 移入 `peerDependencies`：

```jsonc
"dependencies": {
  "@deepseek-ai/schemastery": "^3.18.1"          // 保留（无跨实例 symbol，官方同款）
},
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh-session": "^0.1.0-rc.7",
  "@deepseek-ai/dsh-tools": "^0.1.0-rc.7"        // 移到这里
}
```

- `schemastery` 保持普通依赖：它不含需要跨包共享的 `unique symbol`，官方 `tool-bash` 插件同样把它作为普通依赖。
- `dsh-tools`/`cordis`/`dsh-session` 全部改为 peer：配合 `autoInstallPeers: false`，pnpm 不再本地安装，插件运行时通过 symlink 回退解析到 harness 的唯一副本。

---

## 7. 修复验证

发布 `0.1.1` 后，profile 内更新依赖并重装，验证结果如下：

| 检查项 | 修复前 | 修复后 |
|--------|--------|--------|
| `~/.dsh/profiles/web/node_modules/@deepseek-ai/` | `cosmokit` + `dsh-tools` + `schemastery`（含重复副本） | 仅 `cosmokit` + `schemastery`（**`dsh-tools` 已删除**） |
| 安装的插件版本 | `0.1.0` | `0.1.1` |
| 插件 `dependencies` | 含 `dsh-tools` | 仅 `schemastery` |
| 插件 `peerDependencies` | 缺 `dsh-tools` | `cordis` + `dsh-session` + `dsh-tools` |
| symlink 回退 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools` | 存在，但被遮蔽 | 存在，且现在生效（指向 npx 缓存唯一副本） |

重装输出关键行：

```
Packages: +1 -1          # 装 0.1.1，删掉重复的 dsh-tools
[WARN] Issues with peer dependencies found   # 预期：autoInstallPeers:false，peer 由 harness 提供
```

`+1 -1` 即"新增 0.1.1、移除重复 `dsh-tools`"。之后插件的 `import '@deepseek-ai/dsh-tools'` 沿父目录向上解析，最终命中 `~/.dsh/profiles/node_modules` 的 symlink，与 harness 核心共享同一份 `dsh-tools`。

---

## 8. 后续注意事项

1. **每次发新版都要更新 `minimumReleaseAgeExclude`**：profile 的 `pnpm-workspace.yaml` 里记录了 `@ghogiel/dsh-weinao@0.1.1` 的豁免。pnpm 默认拒绝安装「发布不满 24 小时」的包（供应链保护），下次发 `0.1.2` 时需再加一行，或改成通配 `@ghogiel/dsh-weinao@*` 一劳永逸。
2. **`dsh-*` / `cordis` 一律 peer，不写 dependencies**：这是 DSH out-of-tree 插件的硬性约定，`schemastery` 等纯库除外。可用官方 `packages/shell/tool-bash/package.json` 作为参照。
3. **残留项**：`minimumReleaseAgeExclude` 里的 `@ghogiel/dsh-weinao@0.1.0` 已无意义，可删。

---

## 9. 附录：关键文件与代码位置

| 位置 | 说明 |
|------|------|
| `dsh-wiktenauer/package.json` | 修复点：`dsh-tools` 移入 `peerDependencies` |
| `dsh-wiktenauer/src/tools.ts:9` | `import { defineTool } from '@deepseek-ai/dsh-tools'`（运行时唯一 dsh-tools 依赖） |
| `dsh-wiktenauer/src/index.ts:21` | `inject = ['tools', 'systemPrompt']` |
| `deepseek-harness/packages/core/tools/src/index.ts:466` | `TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol(...)` |
| `deepseek-harness/packages/core/tools/src/index.ts:787,796` | `ToolRuntime` 及其 `[TOOL_RUNTIME_SCHEDULER]` 实例字段 |
| `deepseek-harness/packages/core/agent-loop/src/agent.ts:382,395` | 先落 `assistant/message`，再 `executeToolCalls` |
| `deepseek-harness/packages/core/agent-loop/src/tool-calls.ts:152-153,169` | 调度器访问点（崩溃点） |
| `deepseek-harness/packages/llm/llm-deepseek/src/serialize.ts:112` | 会话 → wire 序列化 |
| `deepseek-harness/packages/boot/app-boot/src/profile.ts:205-255` | `healProfilesModuleFallback`（symlink 回退维护） |
| `deepseek-harness/packages/boot/app-boot/src/profile.ts:138-143` | profile pnpm 配置（hoisted + autoInstallPeers:false） |
| `deepseek-harness/packages/shell/tool-bash/package.json` | 官方插件的 peer 依赖范式 |
