# @ghogiel/dsh-jev

JEV (`typesafe-ai/jev`) as a model-callable tool for DeepSeek Harness: one tool, `jev_evaluate`.

JEV is an **evaluation** model, not a language model. A call takes a `state` and a map of typed `questions`, and returns structured verdicts — a probability, a chosen option, or an ordered score — never prose. It has no context and no memory, so everything it must judge has to travel inside `state`.

```
JEV judgement (typesafe-ai/jev)
- refunded [boolean] p(true) = 0.98
- department [choice] → billing (p 0.88); others: technical 0.01, other 0.11 · confidence 0.83
- frustration [score] → 1.39 = "mildly annoyed" (p 0.49); levels: 0 0.06, 1 0.49, 2 0.45
(cost $0.00001722; 410 in / 71 out tokens)
```

## Install

```sh
# 从仓库根执行
dsh plugin --profile web add ./packages/dsh-jev
```

The package declares no `dsh.bundle`, so `dsh plugin` installs it as a plain profile dependency and warns that it activates no layer. That warning is expected: this plugin has nothing to contribute to the host composition.

Being installed grants no tool. A session sees `jev_evaluate` only when its **agent preset** names the package. `preset/conditioned-reflex/` in this directory is that preset — copy it to `<DSH_HOME>/.agent-presets/conditioned-reflex/` and restart the host:

```yaml
# agent.cordis.yml, appended to the standard preset's rows
- id: jev-evaluate
  name: '@ghogiel/dsh-jev'
```

Then create a session with the **conditioned reflex** preset.

## The tool

| Parameter | Required | Meaning |
|---|---|---|
| `state` | yes | Everything to be judged: a string, or structured JSON (chat log, record, object, array). |
| `questions` | yes | Map of question id → question. Ids are yours and come back unchanged. |
| `timeoutSeconds` | no | Per-call deadline. Default 120. |

A question is `{ type, instructions, criteria }`:

| `type` | `criteria` | Answer |
|---|---|---|
| `boolean` | optional `{ "true": "...", "false": "..." }` | `probability` — the probability of true |
| `choice` | required map of ≥ 2 option id → description | `choice` plus every probability |
| `score` | required ordered array of ≥ 2 grade labels, index 0 lowest | `score` plus every probability, and a `scoreLabel` |

Ask several questions in one call: they share the same state and cost.

The tool never throws and never returns an error result. A rejected question, a missing key, or a gateway failure comes back as `{ ok: false, error }` with the reason, so the model can correct itself rather than retry blindly. `noul` — the direct TypeSafe API's name for the yes/no question — is accepted as a synonym for `boolean` and reported in `warnings`.

## Where the API key comes from

Resolved once per call, in this order, so a rotated key takes effect on the next request:

1. the preset row's `config.apiKey`
2. `process.env[config.apiKeyEnv]`, default `AI_GATEWAY_API_KEY`
3. the DSH credential store (`ctx.credentials`), which itself covers the launch environment, the stored credential file, the project `.env`, and `<DSH_HOME>/.env`
4. `<DSH_HOME>/.env`, then `$HERMES_HOME/.env` when `HERMES_HOME` is set

Save the key with `dsh`'s own settings UI, or add a line to `<DSH_HOME>/.env`:

```
AI_GATEWAY_API_KEY=vck_...
```

## Configuration

Every field is optional; a preset row supplies them under `config:`.

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | — | The key itself. Prefer the store or an environment variable. |
| `apiKeyEnv` | `AI_GATEWAY_API_KEY` | The variable name to read. |
| `baseUrl` | `https://ai-gateway.vercel.sh/v4/ai` | Gateway root; `/evaluation-model` is appended. |
| `model` | `typesafe-ai/jev` | The gateway's only JEV id. |
| `timeoutMs` | `120000` | Cooperative per-call deadline. |

## Wire protocol

`POST <baseUrl>/evaluation-model` — the model id travels in the `ai-model-id` header, never in the body, and four protocol headers are mandatory. See [references/jev-vercel-ai-gateway.md](./references/jev-vercel-ai-gateway.md) for the endpoint, the header table, the three question types, the response fields, the error table, and the differences from TypeSafe's direct API.

## Verify

Three scripts, each with one job. They read the installed harness's own code rather than a copy of it, and they leave the profile alone.

```sh
node verify.mjs           # 29 checks: the tool body, incl. live gateway calls
node verify-registry.mjs  # 12 checks: mounted through the real tool registry
node verify-key.mjs       #  6 checks: which layer supplies the API key
node preset/verify-preset.mjs  # 12 checks: the generated preset files
```

- `verify.mjs` compiles the parameter and output schemas with the harness's `assertSupportedJsonSchema`, validates model-style arguments, exercises every rejection path without a network call, then makes real calls covering boolean + choice + score in one request, the `noul` synonym, score labels, cost, and usage. It reads the key through the plugin's own fallback chain, so it also proves that chain works.
- `verify-registry.mjs` composes `SystemPrompt` + `ToolRuntime` + this plugin exactly as a preset mount does, then dispatches through `ctx.tools.execute`, so registration, visibility, canonical-value validation, and content materialization are the harness's code paths rather than a stub.
- `verify-key.mjs` deletes `HERMES_HOME` and the process variable, expects the call to still succeed, then points `DSH_HOME` at an empty directory and expects it to refuse. That pair proves the configured layer works and that no other layer is quietly substituting for it.
- `preset/verify-preset.mjs` parses both preset files the way the roster does (including the `!!js` tag), and proves the composition is the shipped `standard` preset plus exactly one row.

Roughly $0.00005 of gateway spend per full run.

## Why a tool and not a model

A chat loop needs `messages → text + tool_calls`. JEV answers closed questions about a state. Making it the model position would mean translating every conversational turn into a closed judgement — a different system, not a provider swap. As a tool, the agent decides when a calibrated probability beats a sentence.
