/**
 * Stage 5 · 角色提示词与结构化输出提取
 *
 * 三个角色都通过 **headless 一次性调用** 驱动（`dsh --profile <role> "<prompt>"`）。
 * 也就是说每一轮都是全新进程、没有对话记忆 —— 这不是缺陷，正是本架构要的：
 * 轮次之间传递的唯一状态就是**证据-断言包**本身，它由 harness 显式拼进下一轮 prompt。
 * 于是"打回重来"不依赖任何隐藏上下文，审计日志也就是完整的重放记录。
 *
 * 结构化输出走「围栏 JSON + 容错提取」而不是自定义工具：
 * 少一个插件、少一层依赖。代价是模型可能吐坏 JSON —— 而这恰好已被 chain.mjs 的
 * EMPTY_SUBMISSION / 形状校验 / 轮数封顶处理掉了（打回重试，不会静默成功）。
 * 升级路径：给 researcher 加一个 `evidence_submit` 工具直接落盘，即可去掉文本解析。
 *
 * ★ 已知集成缺口（有意选择，不是遗漏）：
 *   v1 的 weinao 工具 `wiki_get_page` 返回**不带 anchor 的纯文本**，
 *   而定位符格式是 {page, anchor, revid}。所以：
 *     · 跳转收集来的页面 —— 带精确 anchor，直接用
 *     · researcher 自行搜索到的新页面 —— 用 anchor: null（整页定位符）
 *   整页定位符不损失精度：`selectParagraphs` 会在拼 state 时自己挑最相关的 2–3 段，
 *   "选段"本来就是 harness 的职责。只是整页抓取更慢。
 *   升级路径：新增一个按 prop=sections 暴露 anchor 的 v2 工具，让自行搜索也能精确到节。
 */

// ─────────────────────────────────────────────────────────────
// 结构化输出提取
// ─────────────────────────────────────────────────────────────

/**
 * 从模型输出里捞出 JSON。三级策略，从最可信到最宽松：
 *   1. 最后一个 ```json 围栏
 *   2. 最后一个 ``` 围栏（模型常忘写语言标签）
 *   3. 扫描所有平衡的 {...} 并尝试 JSON.parse（取最后一个能解析的）
 * 返回 {value, how}；全部失败返回 {value:null, how:'none'}。
 */
export function extractJson(text) {
  const s = String(text ?? '')

  const fences = [...s.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)]
  for (let i = fences.length - 1; i >= 0; i--) {
    const v = tryParse(fences[i][1])
    if (v !== undefined) return { value: v, how: 'fence' }
  }

  // 平衡花括号扫描：从每个 '{' 起匹配到配对的 '}'
  const candidates = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue
    let depth = 0, inStr = false, esc = false
    for (let j = i; j < s.length; j++) {
      const c = s[j]
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { candidates.push(s.slice(i, j + 1)); i = j; break }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const v = tryParse(candidates[i])
    if (v !== undefined) return { value: v, how: 'balanced' }
  }
  return { value: null, how: 'none' }
}

function tryParse(t) {
  try {
    const v = JSON.parse(String(t).trim())
    return (v && typeof v === 'object') ? v : undefined
  } catch { return undefined }
}

/** leader 输出 → 子题目数组（形状不对就交给 decompose 的形状校验去挡） */
export function parseSubQuestions(text) {
  const { value, how } = extractJson(text)
  if (!value) return { subQuestions: [], how, parsed: false }
  const list = Array.isArray(value) ? value : (value.subQuestions ?? value.sub_questions ?? [])
  return { subQuestions: Array.isArray(list) ? list : [], how, parsed: true }
}

/** researcher 输出 → 证据-断言包 */
export function parseClaims(text) {
  const { value, how } = extractJson(text)
  if (!value) return { claims: [], how, parsed: false }
  const list = Array.isArray(value) ? value : (value.claims ?? value.package ?? value.assertions ?? [])
  return { claims: Array.isArray(list) ? list : [], how, parsed: true }
}

// ─────────────────────────────────────────────────────────────
// 提示词
// ─────────────────────────────────────────────────────────────

const SHARED_RULES = [
  '你在一个受严格流程约束的 HEMA（欧洲历史武术）文献研究系统里工作。',
  '系统的硬规则由程序执行，不由你决定，违反规则会被自动打回。',
]

/** leader：把研究题目分解为方向集中的子题目 */
export function leaderPrompt({ question, round, feedback, hint }) {
  const lines = [
    ...SHARED_RULES,
    '',
    '【你的角色】leader。你只负责**分解问题**，不取证、不写报告。',
    '',
    `【研究题目】${question}`,
    '',
    '【任务】把这个研究题目分解为若干**方向集中**的子题目，要求：',
    '1. 子题目合起来覆盖原问题的主要方面，彼此尽量不重叠；',
    '2. 每个子题目都应当能用 Wiktenauer 上的历史文献（ treaties / glosses ）取证回答；',
    '3. 范围要合适：过宽（需要整本书才能回答）或过窄（几乎没有研究价值）都会被判不合格；',
    '4. 子题目应当保持原问题的语言（中文提问就用中文写子题目），但其中涉及的武术术语请',
    '   在括号里附上历史原文（德语/英语），例如「怒击（Zornhau）的起手动作」。',
    '5. 每个子题目还要给出 `terms` 字段：把该子题目涉及的**历史原文术语**列出来',
    '   （德语/英语，如 Zornhau、Zornhut、Vom Tag、Oberhau）。',
    '   程序会用这些术语去定位 Wiktenauer 上的起跳页面，所以它们越准，取证起点越好。',
    '   注意 wiki 上的页面拼写可能与常用拼写不同（如 Zornhau 页实际叫 Zornhaw），',
    '   但请照实写你确定的历史术语，程序会自行纠正拼写变体。',
  ]
  if (round > 1 && feedback) {
    lines.push('', `【上一轮被打回（第 ${round - 1} 轮）】`)
    for (const f of feedback.failed ?? []) lines.push(`- ${f.label ?? f.key}：${f.detail ?? ''}`)
    for (const s of feedback.shapeIssues ?? []) lines.push(`- 结构问题：${s.code}`)
    if (feedback.note) lines.push(`- ${feedback.note}`)
  }
  if (hint) lines.push('', `【要求】${hint}`)
  lines.push(
    '',
    '【输出格式】只输出一个 JSON 代码块，不要有任何其他文字：',
    '```json',
    '{',
    '  "subQuestions": [',
    '    { "id": "sq1", "text": "子题目文本", "terms": ["Zornhau", "Zornhut"] },',
    '    { "id": "sq2", "text": "子题目文本", "terms": ["Vom Tag"] }',
    '  ]',
    '}',
    '```',
  )
  return lines.join('\n')
}

/**
 * researcher：取证并产出证据-断言包。
 * 把跳转收集到的页面连同它们的定位符一起给出 —— 这是它最可靠、最精确的证据来源。
 */
export function researcherPrompt({ atom, round, pages, feedback, hint }) {
  const lines = [
    ...SHARED_RULES,
    '',
    '【你的角色】researcher。你负责**取证**并产出「断言 + 证据定位符」的包。',
    '',
    `【原子命题】${atom}`,
    '',
    '【已通过 JEV 快速跳转收集到的高相关页面】（这些定位符是精确的，优先使用）',
  ]
  if (!pages?.length) lines.push('（无 —— 请自己用 wiki_search / wiki_get_page / wiki_get_links 检索）')
  for (const p of pages ?? []) {
    lines.push(`- ${p.page}${p.heading ? ` ／ 节：${p.heading}` : ''}`)
    lines.push(`  定位符：${JSON.stringify(p.locator)}`)
    if (p.preview) lines.push(`  片段预览：${String(p.preview).replace(/\s+/g, ' ').slice(0, 160)}`)
  }

  lines.push(
    '',
    '【硬规则】',
    '1. **证据不是原文摘抄，而是定位符。** 绝对不要在证据字段里贴引文、段落或任何原文。',
    '   证据的形态只有一种：{"page": "页面标题", "anchor": "节锚点", "revid": 修订号}。',
    '   上面给出的定位符可直接复制使用。',
    '2. 如果跳转收集的页面不够，你可以用 wiki_search / wiki_prefix_search / wiki_get_page /',
    '   wiki_get_links 自行检索更多页面。自行找到的页面用 "anchor": null（整页定位符），',
    '   程序会在需要时自己挑最相关的段落。',
    '3. 每条断言都必须**具体、可查证**：不要写"Zornhau 很重要"这类空话或同义反复，',
    '   要写清楚动作、线路、条件、战术用途。',
    '4. 断言必须仍然在回答原子命题；不要跑题，也不要为了好通过而把断言削弱成废话。',
    '5. 断言用中文书写（术语可附原文），证据定位符指向的可以是德文/英文页面。',
  )

  if (round > 1 && feedback) {
    lines.push('', `【上一轮被打回（第 ${round - 1} 轮）】`)
    for (const f of feedback.failed ?? []) {
      lines.push(`- [${f.id}] ${f.claim}`)
      for (const r of f.reasons ?? []) lines.push(`    未通过原因：${r}`)
      if (f.locatorsTried?.length) lines.push(`    上一轮用的证据：${f.locatorsTried.join('；')}`)
      // 逐条证据诊断：直接告诉它哪一条来源不支持，避免盲改
      if (f.evidenceDiagnosis?.length) {
        const bad = f.evidenceDiagnosis.filter(d => !d.supports)
        const good = f.evidenceDiagnosis.filter(d => d.supports)
        if (good.length) lines.push(`    ✔ 支持这条断言的来源：${good.map(d => d.label).join('；')}`)
        if (bad.length) lines.push(`    ✘ **不支持**这条断言的来源（考虑换掉）：${bad.map(d => `${d.label}（p=${d.p}）`).join('；')}`)
        if (!bad.length) lines.push('    注：每条来源单独看都被判为不支持 —— 问题更可能在断言表述本身，而不是来源选择。')
      }
    }
    if (feedback.note) lines.push(`- ${feedback.note}`)
    lines.push(
      '',
      '请针对上面的原因修改：**换证据**（去找真正支持这个断言的页面）或**改断言**（改成证据真的能支持的表述）。',
      '如果某条断言在现有文献里确实找不到支持，就不要硬写它 —— 它会被判为证据悬置，这是可接受的结果。',
    )
  }
  if (hint) lines.push('', `【要求】${hint}`)

  lines.push(
    '',
    '【输出格式】只输出一个 JSON 代码块，不要有任何其他文字：',
    '```json',
    '{',
    '  "claims": [',
    '    {',
    '      "id": "c1",',
    '      "claim": "断言文本（中文，具体可查证）",',
    '      "subQuestion": "这条断言回答的原子命题",',
    '      "evidence": [ { "page": "页面标题", "anchor": "节锚点或null", "revid": 12345 } ]',
    '    }',
    '  ]',
    '}',
    '```',
  )
  return lines.join('\n')
}

/** writer：依据已通过的证据-断言写报告 */
export function writerPrompt({ question, rendered, round, issues, hint }) {
  const lines = [
    ...SHARED_RULES,
    '',
    '【你的角色】报告撰写者。你只依据下面给出的材料写报告，不自己取证、不自己下新结论。',
    '',
    rendered,
    '',
    '【硬规则】',
    '1. 报告必须覆盖**每一条**已通过验证的断言 —— 漏掉已确证的成果会被判不合格。',
    '2. 所有**未通过验证**的断言必须**逐条**写进标题含「证据悬置」的一节，',
    '   并说明未通过的原因。它们不是结论，也不是已被否定，只是当前证据不足以确证。',
    '3. **不得**把未通过验证的内容写成结论；正文里不得把它们当已确证的事实陈述。',
    '4. 可以在已确证的断言之间做归纳与组织，但不得引入材料之外的新事实。',
    '5. 用中文撰写，Markdown 格式。',
  ]
  if (round > 1 && issues?.length) {
    lines.push('', `【上一稿未通过校验（第 ${round - 1} 稿）】`)
    for (const i of issues) lines.push(`- [${i.code}] ${i.detail}`)
  }
  if (hint) lines.push('', `【要求】${hint}`)
  lines.push('', '【输出】直接输出 Markdown 报告正文，不要输出 JSON、不要写解释性前言。')
  return lines.join('\n')
}
