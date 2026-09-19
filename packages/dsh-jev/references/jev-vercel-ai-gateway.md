> 来源：用户在 2026-09-19 于 Hermes 上完成的 JEV 接入实测记录，此处按原文保存（`dsh-jev` 的协议实现以本文为准）。
> 相关实现：`dsh-jev/`（DSH 侧插件）、`dsh-jev/README.md`。

# 通过 Vercel AI Gateway 调用 `typesafe-ai/jev`
> 状态：2026-09-19 全部实测通过（用 `$HERMES_HOME/.env` 里现成的 `AI_GATEWAY_API_KEY`，HTTP 200）。
> 端点与 header 不是从文档抄的，是从 `@ai-sdk/gateway` 4.0.86 的 dist 源码里挖出来的
> （默认 `baseURL = https://ai-gateway.vercel.sh/v4/ai`，`GatewayEvaluationModel.getUrl()` 返回 `/evaluation-model`）。
## 1. 它不是 LLM，所以不走 `/v1/chat/completions`
Vercel 模型页把 `typesafe-ai/jev` 标成 **type: evaluation**（System One 评估模型）。它接收一段
共享状态（state）和一组**带类型的提问**（questions），返回结构化的判定结果（概率、选项、评分），
不生成文本。因此：
- 不能作为 Hermes 的模型/provider 选中（picker 只列 language 模型，Hermes 的 `ai-gateway` profile 也一样）；
- 调用端点是**另一条路径**，OpenAI 兼容层里没有它。
## 2. 端点与必需 header
```
POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
```
| Header | 值 | 缺了/写错的后果（实测） |
|---|---|---|
| `Authorization` | `Bearer $AI_GATEWAY_API_KEY` | 401 |
| `Content-Type` | `application/json` | — |
| `ai-gateway-protocol-version` | `0.0.1` | `400 Unsupported gateway protocol version` |
| `ai-gateway-auth-method` | `api-key`（OIDC 登录时是 `oidc`） | 网关无法判定鉴权方式 |
| `ai-evaluation-model-specification-version` | `4` | 协议协商失败 |
| `ai-model-id` | `typesafe-ai/jev` | 404 model not found |
| `HTTP-Referer` / `X-Title` | 归因用，可选 | — |
**模型 id 走 header，body 里没有 `model` 字段**（这和 TypeSafe 直连 API 相反）。
路径别写错：`/v1/evaluation-model`、`/v1/evaluate`、`/v1/ai/evaluate` 全是 404；
`/evaluate` 会撞到 Vercel 前端页面。
## 3. 请求体
```json
{
  "state": "The support agent issued a full refund to the customer.",
  "questions": {
    "refunded": {
      "type": "boolean",
      "instructions": "Was a refund issued?",
      "criteria": { "true": "An amount was refunded", "false": "No refund mentioned" }
    }
  }
}
```
- `state`：`string | object | array`。纯文本，或结构化数据——chat log（`[{"role","content"}]`）、
  记录、系统当前状态都实测可用。**它没有自己的上下文，所有要它判断的材料都必须放进 state。**
- `questions`：`map<question id, Question>`。id 自己起，答案按同样的 id 回来（id 不会送给底层模型）。
### 三种题型（经网关的名字）
| type | 语义 | `criteria` 形状 | 答案字段 |
|---|---|---|---|
| `boolean` | 是非题，返回“是”的概率 | 可选：`{"true": "...", "false": "..."}` | `probability` |
| `choice` | 从封闭集合里选一个 | 必填：`{"option": "描述或 null", ...}`（≥2 项） | `choice` + `probabilities` |
| `score` | 按有序等级打分 | 必填：`["最低", "中", "最高"]`（≥2 项，index 0 最低） | `score` + `probabilities` |
⚠️ **`noul` 会被拒**：429/400 里明确报
`Invalid discriminator value. Expected 'choice' | 'score' | 'boolean'`。TypeSafe 文档里的
`noul` 是**直连 API** 的名字，经网关要写 `boolean`。
`instructions` 除了字符串，也接受结构化 JSON（object/array），实测通过。
## 4. 响应体
真实响应（一次请求问了三题，boolean + choice + score）：
```json
{
  "answers": {
    "urgent":     {"type": "boolean", "probability": 0.98},
    "department": {"type": "choice", "choice": "technical", "probabilities": {"billing": 0.3, "technical": 0.7}},
    "frustration":{"type": "score",  "score": 1.05, "probabilities": {"0": 0, "1": 0.95, "2": 0.05}}
  },
  "rounding": {"probabilityDecimals": 2, "scoreDecimals": 2},
  "usage": {"inputTokens": 395, "outputTokens": 63},
  "warnings": [],
  "providerMetadata": {
    "typesafe": {"confidence": {"department": 0.41, "frustration": 0.93}},
    "gateway": {"routing": {...}, "cost": "0.00001659"}
  }
}
```
要点：
- **概率默认四舍五入到两位小数**，并在 `rounding` 里声明（直连 API 返回完整浮点）。
- **confidence 不在 answer 里**，在 `providerMetadata.typesafe.confidence.<questionId>`；
  boolean 题没有 confidence（只有 choice/score 有）。
- `providerMetadata.gateway.cost` 是本次美元成本（字符串）。
- `rounding` / `confidence` / `cost` 都是网关加的，属 Vercel 特有字段。
## 5. 经网关 vs TypeSafe 直连
| | TypeSafe 直连 | 经 Vercel AI Gateway |
|---|---|---|
| 端点 | `POST https://api.typesafe.ai/v1/systemone` | `POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model` |
| 认证 | `Authorization: Bearer $TYPESAFE_API_KEY` | `Authorization: Bearer $AI_GATEWAY_API_KEY` + 5 个协议 header |
| 指定模型 | body `"model": "jev-latest"` | header `ai-model-id: typesafe-ai/jev` |
| 是非题类型 | `noul` → `{noul: 0.92}` | `boolean` → `{probability: 0.99}` |
| 概率精度 | 完整浮点 | 两位小数（`rounding`） |
| confidence | 在 answer 里 | 在 `providerMetadata.typesafe.confidence` |
| usage | `input_tokens` / `output_tokens`（snake） | `inputTokens` / `outputTokens`（camel） |
| 计费 | 向 TypeSafe 付 | 向 Vercel 付（AI Gateway 零加价，$0.042/1M input token） |
| 有效模型 id | `jev-latest` 等 TypeSafe 别名 | **只有 `typesafe-ai/jev`**（`typesafe-ai/jev-1.13` → 404 model not found） |
## 6. 可用性与限额（实测）
- `AI_GATEWAY_API_KEY` = Vercel **free tier**：jev 属于免费层可调用范围，连续十来次请求全部 200，
  单次成本约 `$0.000012–$0.000017`（约 300 输入 token + 20–60 输出 token）。
- 免费层对**语言模型**限制很紧（多数 429 限流、少数 403 无权限），但对 jev 实测无碍。
- 想批量跑或在长会话里频繁调用，仍建议买 AI Gateway Credits（转 paid tier，提高限流）。
## 7. 调用示例
### curl
```bash
curl -s -X POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" -H 'Content-Type: application/json' \
  -H 'ai-gateway-protocol-version: 0.0.1' \
  -H 'ai-gateway-auth-method: api-key' \
  -H 'ai-evaluation-model-specification-version: 4' \
  -H 'ai-model-id: typesafe-ai/jev' \
  -d '{"state":"The support agent issued a full refund to the customer.",
       "questions":{"refunded":{"type":"boolean","instructions":"Was a refund issued?"}}}'
```
### Python（纯 stdlib）
```python
import json, os, urllib.request
def jev(state, questions, model="typesafe-ai/jev"):
    req = urllib.request.Request(
        "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
        data=json.dumps({"state": state, "questions": questions}).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {os.environ['AI_GATEWAY_API_KEY']}",
            "Content-Type": "application/json",
            "ai-gateway-protocol-version": "0.0.1",
            "ai-gateway-auth-method": "api-key",
            "ai-evaluation-model-specification-version": "4",
            "ai-model-id": model,
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())
print(jev("Payout failed three days in a row.",
          {"urgent": {"type": "boolean", "instructions": "Does this express urgency?"}}))
```
## 8. 错误对照表
| 现象 | 原因 |
|---|---|
| `400 Unsupported gateway protocol version` | 少了 `ai-gateway-protocol-version`（或值不是 `0.0.1`） |
| `400 Invalid discriminator value. Expected 'choice' \| 'score' \| 'boolean'` | 用了 `noul`；经网关叫 `boolean` |
| `400 Invalid input: expected array, received undefined ... param: messages` | 打到了 `/v1/chat/completions`（那是语言模型的端点） |
| `404 The requested resource was not found: /v1/evaluation-model` | 端点版本错，应是 `/v4/ai/evaluation-model` |
| `404 Model 'typesafe-ai/jev-1.13' not found` | 网关上只有 `typesafe-ai/jev` 这个 id |
| `403 Free tier users do not have access to this model` | 免费层不含该模型（jev 不在此列） |
| `429 Free tier requests on this model are rate-limited` | 限流，退避重试或买 credits |
| `422 Unprocessable Entity` | 请求体校验失败（直连 API 的报法，网关上是 400） |
## 9. Hermes 集成方式
同目录的 `jev-evaluate` 插件把上面这套封装成了模型可调用的工具 `jev_evaluate`
（JSON-Schema 参数、handler 只回 JSON 字符串、永不抛异常）：
- 插件位置：`$HERMES_HOME/plugins/jev-evaluate/`（`plugin.yaml` + `__init__.py` + `schemas.py` + `tools.py` + 本文档）
- 工具名 `jev_evaluate`，toolset `jev`；参数 `state` / `questions` / `model` / `timeout_s`，
  返回值把 `answers`、`usage`、`rounding`、`cost_usd` 打平，并把 `providerMetadata.typesafe.confidence`
  合并进对应的 answer（网关把它藏在 metadata 里，不方便直接用）。
- 启用：`hermes plugins enable jev-evaluate`（用户插件默认关闭，必须显式 enable）。
- 自检：`hermes plugins doctor $HERMES_HOME/plugins/jev-evaluate --ci`。
- 密钥：读进程环境里的 `AI_GATEWAY_API_KEY`，没有则回退读 `$HERMES_HOME/.env`。
为什么不写成 provider：jev 是 evaluation 模型，Hermes 的对话循环需要的是 chat/completions
（messages → text + tool_calls）。要把它塞进"模型"位置，得写一个把 chat 请求翻译成 evaluation
请求的 shim——那会让 agent 的每轮对话都变成一次封闭式判定，属于另一种系统设计，不是这里的默认路径。

---

## 10. DSH 侧实现（本次新增）

同一套协议在 DeepSeek Harness 上的落地方式与 Hermes 不同，因为 DSH 的模型可见工具由 **agent preset** 决定，而不是全局 toolset：

- 插件包：`dsh-jev/`（`@ghogiel/dsh-jev`），零依赖单文件 ESM，导出 `name` / `inject` / `apply`，
  在 `apply` 里用 `ctx.tools.register({...})` 注册手写 `ToolDefinition`（不引入 `@deepseek-ai/dsh-tools`：
  `register()` 只要求 `output.schema` 通过 `assertSupportedJsonSchema`，参数直接以原始 JSON Schema 下发）。
- 安装：`dsh plugin --profile web add ./dsh-jev` —— 因为包**不声明 `dsh.bundle`**，它只作为 profile 的普通依赖装上，
  `dsh plugin` 会警告"不激活任何层"，这是预期行为。
- 可见性：preset `conditioned-reflex`（`dsh-jev/preset/conditioned-reflex/`，复制官方 standard 后追加一行
  `name: '@ghogiel/dsh-jev'`）→ 复制到 `<DSH_HOME>/.agent-presets/conditioned-reflex/`，重启 host 后在预设选择器里选它。
- 与 Hermes 版的差异：`noul` 被接受为 `boolean` 的同义词（记入 `warnings`）；`score` 额外补 `scoreLabel`；
  密钥解析多了 DSH credential store 一层。
- 密钥载入（本机已落地在 DSH 自己这层，不再依赖 Hermes）：
  插件每次调用按 `config.apiKey` → `process.env[apiKeyEnv]` → DSH credential store → `$DSH_HOME/.env` → `$HERMES_HOME/.env` 解析。
  其中 DSH credential store 内部又有自己的优先级：启动环境（只读，启动时快照）> `.credentials.yaml` > 项目 `.env` > `$DSH_HOME/.env`。
  注意 GUI 的 Models 设置页只给 provider 路由存 `<ROUTE>_API_KEY`，**没有**通用"任意变量名"输入框，所以 `AI_GATEWAY_API_KEY` 存不进去——
  要么写 `$DSH_HOME/.env`（本机做法，`AI_GATEWAY_API_KEY=vck_...`，UTF-8 无 BOM），要么编辑 `.credentials.yaml` 的 `refs:`，
  要么在启动 dsh 的同一个 shell 里 `$env:AI_GATEWAY_API_KEY='vck_...'`（优先级最高但不落盘，且启动后才 export 的变量看不到）。
- 自检（四个脚本，各管一件事，都直接读本机已安装的 DSH 代码）：
  - `node dsh-jev/verify.mjs` —— 29 项：用 `assertSupportedJsonSchema` 验收参数/输出 schema、参数校验与全部拒绝路径（不发网络请求）、
    真实调用覆盖 boolean+choice+score 同请求、`noul` 同义词、scoreLabel、cost、usage。
  - `node dsh-jev/verify-registry.mjs` —— 12 项：按 preset 挂载的方式组合 `SystemPrompt` + `ToolRuntime` + 本插件，
    再经 `ctx.tools.execute` 走完整注册/可见性/输出 schema 校验/内容物化管线。
  - `node dsh-jev/verify-key.mjs` —— 6 项：删掉 `HERMES_HOME` 与进程变量后真实调用仍成功，再把 `DSH_HOME` 指到空目录则必须拒绝，
    证明生效的是配置的那一层、且没有别的层在偷偷供密钥。
  - `node dsh-jev/preset/verify-preset.mjs` —— 12 项：按 roster 的读法解析两个 preset 文件（含 `!!js` 标签），
    并证明组合就是官方 standard 加且仅加一行 JEV。
  - 全量跑一次约 $0.00006 网关开销。
