/**
 * 探针 Stage 4 —— 报告的确定性后置检查与代码兜底
 *
 * 这一层专门验证「硬规则在代码里，不在 prompt 里」：
 *   撰写者忘写悬置节 / 写个空标题 / 把悬置内容当结论讲 / 漏掉已确证的断言
 *   —— 全部能被确定性检查抓住，且最终产物**一定**带完整悬置节（代码兜底）。
 */
import {
  postcheck, enforceSuspension, buildReportBrief, renderBrief, splitSections,
  partitionBySuspension, isMentioned, runReport, SUSPENSION_HEADING, REPORT_DEFAULTS,
} from '../lib/report.mjs'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}
const head = (s) => console.log(`\n── ${s} ──`)

const QUESTION = 'Zornhau 是什么，在 Liechtenauer 体系中怎么用？'
const CLAIM_A = 'Zornhau 是一记从上方斜劈的斩击，起手自右侧。'
const CLAIM_B = 'Zornhau 在 Liechtenauer 体系中属于五大斩击之一。'
const CLAIM_X = 'Zornhau 可以用于对治下段起手的攻击。'

const brief = buildReportBrief({
  question: QUESTION,
  decomposition: { subQuestions: [{ id: 'sq1', text: 'Zornhau 的起手动作？' }], userEdited: false },
  chains: [{ id: 'sq1' }],
  accepted: [
    { atom: 'sq1', id: 'c1', claim: CLAIM_A, sources: ['Zornhaw#Meÿer @110509'], support: { p: 0.88 }, specificity: { scoreLabel: '具体可查证' } },
    { atom: 'sq1', id: 'c2', claim: CLAIM_B, sources: ['Liechtenauer @999'], support: { p: 0.8 }, specificity: { scoreLabel: '有信息量' } },
  ],
  insufficient: [
    { atom: 'sq1', id: 'cX', claim: CLAIM_X, reason: 'ROUNDS_EXHAUSTED', lastReasons: ['证据不支持（judged=NOT_IN_SOURCE, p(SUPPORTED)=0.05）'], sources: ['Zornhaw#Nachreisen @110509'], roundsAttempted: 3 },
  ],
})

const GOOD_REPORT = [
  `# ${QUESTION}`,
  '',
  '## 起手动作',
  `${CLAIM_A} 这一点在 Zornhaw 页的 Meÿer 章节中有明确记述。`,
  '',
  '## 战术地位',
  `${CLAIM_B} 该论断来自 Liechtenauer 页。`,
  '',
  `## ${SUSPENSION_HEADING}`,
  '',
  `- ${CLAIM_X} —— 未通过验证，当前证据不足以确证。`,
].join('\n')

// ══════════════════════════════════════════════════════════════
head('1) 合规报告通过检查')
const c1 = postcheck(GOOD_REPORT, brief)
ok('合规报告 pass=true', c1.pass === true, JSON.stringify(c1.issues.map(i => i.code)))
ok('章节切分找到了悬置节', splitSections(GOOD_REPORT).some(s => /悬置/.test(s.heading ?? '')))

// ══════════════════════════════════════════════════════════════
head('2) 缺少悬置节 → 被抓住')
const noSusp = GOOD_REPORT.split('## 证据悬置')[0].trim()
const c2 = postcheck(noSusp, brief)
ok('缺悬置节 → MISSING_SUSPENSION_SECTION',
  c2.issues.some(i => i.code === 'MISSING_SUSPENSION_SECTION'), JSON.stringify(c2.issues.map(i => i.code)))
ok('同时因漏掉 CLAIM_X 而不过', c2.pass === false)

head('2b) 悬置节空标题糊过去 → 被抓住')
const emptySusp = [
  '# 报告', '', CLAIM_A, '', CLAIM_B, '', '## 证据悬置', '', '（无）',
].join('\n')
const c2b = postcheck(emptySusp, brief)
ok('空悬置节 → INSUFFICIENT_CLAIM_NOT_SUSPENDED',
  c2b.issues.some(i => i.code === 'INSUFFICIENT_CLAIM_NOT_SUSPENDED'), JSON.stringify(c2b.issues.map(i => i.code)))

// ══════════════════════════════════════════════════════════════
head('3) 漏掉已确证的断言 → 被抓住')
const dropped = [
  '# 报告', '', CLAIM_A, '', `## ${SUSPENSION_HEADING}`, '', `- ${CLAIM_X} 未确证。`,
].join('\n')
const c3 = postcheck(dropped, brief)
ok('漏掉 CLAIM_B → ACCEPTED_CLAIM_MISSING',
  c3.issues.some(i => i.code === 'ACCEPTED_CLAIM_MISSING'), JSON.stringify(c3.issues.map(i => i.code)))

// ══════════════════════════════════════════════════════════════
head('4) 把悬置来源的**定位符原样抄进正文** → 被抓住（无歧义）')
// Zornhaw#Nachreisen 只出现在悬置项里；正文原样写出定位符 = 程序生成的引用标记
const leaked = [
  '# 报告', '',
  `${CLAIM_A} 见 Zornhaw 页。`, '',
  `${CLAIM_B} 见 Liechtenauer 页。`, '',
  '证据：Zornhaw#Nachreisen @110509 支持上述说法。', '',
  `## ${SUSPENSION_HEADING}`, '', `- ${CLAIM_X} 未确证。`,
].join('\n')
const c4 = postcheck(leaked, brief)
ok('定位符原样出现 → SUSPENDED_EVIDENCE_PRESENTED_AS_SETTLED',
  c4.issues.some(i => i.code === 'SUSPENDED_EVIDENCE_PRESENTED_AS_SETTLED'), JSON.stringify(c4.issues.map(i => i.code)))

head('4a) 带版本号的引用 `Page @revid` → 也被抓住')
const leakedRev = [
  '# 报告', '',
  `${CLAIM_A} 见 Zornhaw 页。`, `${CLAIM_B} 见 Liechtenauer 页。`, '',
  '（来源：Zornhaw @110509）', '',
  `## ${SUSPENSION_HEADING}`, '', `- ${CLAIM_X} 未确证。`,
].join('\n')
ok('带版本号引用 → 判定泄漏',
  postcheck(leakedRev, brief).issues.some(i => i.code === 'SUSPENDED_EVIDENCE_PRESENTED_AS_SETTLED'))

head('4b) 正文里提到传本名/大师名 → **不算**泄漏')
/*
 * 真实误报（两轮）：悬置来源多是整页定位符，页面名就是传本名或大师名。
 * 一份 HEMA 报告正文里这类名字本来就会反复出现 ——
 * 子题目自己就写着「Ringeck、Peter von Danzig 等注释」。
 * 见名字就判泄漏会让撰写者永远无法合格，护栏退化成"兜底永远触发"。
 */
const briefBare = buildReportBrief({
  question: QUESTION,
  accepted: [{ id: 'c1', claim: CLAIM_A, sources: ['Zornhaw#Meÿer @1'] }, { id: 'c2', claim: CLAIM_B, sources: ['Liechtenauer @999'] }],
  insufficient: [
    { id: 'cX', claim: CLAIM_X, lastReasons: ['x'], sources: ['Joachim Meyer (整页) @166473', 'Jobst von Württemberg (整页) @1'] },
  ],
})
const bareMention = [
  '# 报告', '',
  `${CLAIM_A} 见 Zornhaw 页。`, '',
  `${CLAIM_B} 见 Liechtenauer 页。`, '',
  '本报告另与 Joachim Meyer、Jobst von Württemberg 及 Andre Paurenfeyndt 等传本作了对照，',
  '相关比对结果见上表；这些传本在本议题上属于旁证，不构成本报告的结论依据。', '',
  `## ${SUSPENSION_HEADING}`, '', `- ${CLAIM_X} 未确证。`,
].join('\n')
const c4b = postcheck(bareMention, briefBare)
ok('裸的传本名提及不算泄漏',
  !c4b.issues.some(i => i.code === 'SUSPENDED_EVIDENCE_PRESENTED_AS_SETTLED'), JSON.stringify(c4b.issues.map(i => i.code)))
ok('该形态整体通过检查', c4b.pass === true, JSON.stringify(c4b.issues.map(i => i.code)))

head('4d) 锚点里的**泛用词**出现在正常叙述里 → 不算泄漏')
/*
 * 第二个实测误报：锚点 `Joachim_Meÿer's_Treatise` 的显著词含泛用英文词 `treatise`，
 * 而正文里出现「Treatise 章节」是完全正常的。人名、传本名、泛用词都不能当泄漏信号。
 */
const briefGeneric = buildReportBrief({
  question: QUESTION,
  accepted: [{ id: 'c1', claim: CLAIM_A, sources: ['Zornhaw#Meÿer @1'] }],
  insufficient: [{ id: 'cX', claim: CLAIM_X, lastReasons: ['x'], sources: ["Zornhaw#Joachim_Meÿer's_Treatise @110509"] }],
})
const genericBody = [
  '# 报告', '',
  `${CLAIM_A} 见 Zornhaw 页。`, '',
  '就本议题而言，各传本的 Treatise 章节在措辞上存在差异，详见附表；',
  '这些差异属于版本传承问题，并不改变本报告已确证结论的效力，',
  '也不构成本报告对任何未确证内容的背书。读者若需核对，请循各节标注的来源自行查证。', '',
  `## ${SUSPENSION_HEADING}`, '', `- ${CLAIM_X} 未确证。`,
].join('\n')
const c4d = postcheck(genericBody, briefGeneric)
ok('锚点泛用词（treatise）不触发泄漏',
  !c4d.issues.some(i => i.code === 'SUSPENDED_EVIDENCE_PRESENTED_AS_SETTLED'), JSON.stringify(c4d.issues.map(i => i.code)))
ok('该形态整体通过检查', c4d.pass === true, JSON.stringify(c4d.issues.map(i => i.code)))

head('4c) 同一页既有已确证项也有悬置项：正常引用不受影响')
const shared = buildReportBrief({
  question: QUESTION,
  accepted: [{ id: 'c1', claim: CLAIM_A, sources: ['Zornhaw#A @1'] }],
  insufficient: [{ id: 'cX', claim: CLAIM_X, sources: ['Zornhaw#B @1'], lastReasons: ['x'] }],
})
const sharedReport = [
  '# r', '', `${CLAIM_A} 见 Zornhaw 页。`, '', `## ${SUSPENSION_HEADING}`, '', `- ${CLAIM_X} 未确证。`,
].join('\n')
const c4c = postcheck(sharedReport, shared)
ok('已确证来源的正常引用不被误判',
  !c4c.issues.some(i => i.code === 'SUSPENDED_EVIDENCE_PRESENTED_AS_SETTLED'), JSON.stringify(c4c.issues.map(i => i.code)))

// ══════════════════════════════════════════════════════════════
head('5) 代码兜底：撰写者不配合也保证有完整悬置节')
const stubReport = `# 报告\n\n${CLAIM_A}\n\n${CLAIM_B}\n`
const fixed = enforceSuspension(stubReport, brief.insufficient)
ok('兜底后出现悬置节', /## .*悬置/.test(fixed))
ok('兜底后含悬置断言的原文', fixed.includes(CLAIM_X))
ok('兜底后含未通过原因', /未通过原因/.test(fixed))
ok('兜底后含已尝试的证据', /已尝试的证据/.test(fixed))
ok('兜底后含尝试轮数', /尝试轮数/.test(fixed))
const c5 = postcheck(fixed, brief)
ok('兜底后的报告通过完整检查', c5.pass === true, JSON.stringify(c5.issues.map(i => i.code)))

head('5b) 兜底不重复：已有悬置节时只补缺的条目')
const partial = enforceSuspension(emptySusp, brief.insufficient)
ok('已有悬置节时不另起一节（仍只有 1 个二级标题）', (partial.match(/^## /gm) ?? []).length === 1,
  `headings=${(partial.match(/^## .*/gm) ?? []).join('|')}`)
ok('补进去的是缺失条目', partial.includes(CLAIM_X))
ok('明说这是程序补充的', /校验程序补充/.test(partial))

head('5c) 没有悬置项时兜底不动报告')
const noSuspNeed = buildReportBrief({ question: QUESTION, accepted: [{ id: 'c1', claim: CLAIM_A, sources: ['Z'] }], insufficient: [] })
ok('无悬置项 → 原文返回', enforceSuspension(stubReport, []) === stubReport.trim())

// ══════════════════════════════════════════════════════════════
head('6) 空/过短报告被挡')
ok('空报告 → EMPTY_REPORT', postcheck('', brief).issues.some(i => i.code === 'EMPTY_REPORT'))
ok('过短报告 → TOO_SHORT', postcheck('太短了', brief).issues.some(i => i.code === 'TOO_SHORT'))
ok('短报告不继续跑其他检查', postcheck('', brief).issues.length === 1)

// ══════════════════════════════════════════════════════════════
head('7) isMentioned 词覆盖判定')
ok('完全提到 → true', isMentioned(CLAIM_A, CLAIM_A, 0.34) === true)
ok('完全没提 → false', isMentioned(CLAIM_A, '这段文字讲的是完全不相干的内容。', 0.34) === false)
ok('部分提到 → 按阈值', isMentioned('Zornhau 起手自右侧', CLAIM_A, 0.34) === true)
ok('空断言不误判为提到', isMentioned('', '任意文本', 0.34) === false)

// ══════════════════════════════════════════════════════════════
head('7b) 层级感知切分（真实报告里的嵌套标题坑）')
/*
 * 这不是假想用例，是端到端跑出来的真实报告形态：
 *   ## 二、证据悬置（未能确证的部分）
 *   ### sq1：...
 *   ### sq2：...
 * 「在任意标题级别切分」的朴素实现会让 `## 二` 的正文停在第一个 `###`，
 * 于是逐条列出的 26 条断言被判"没点到"，同时它们又被当成正文触发泄漏误报。
 * 报告完全合规却两项不合格。
 */
// 专用夹具：1 条已确证 + 1 条悬置，与报告内容一致（否则测的是夹具不是逻辑）
const nb = buildReportBrief({
  question: QUESTION,
  accepted: [{ id: 'a1', claim: CLAIM_A, sources: ['Zornhaw#Meÿer @110509'] }],
  insufficient: [{ id: 'x1', claim: CLAIM_X, sources: ['Zornhaw#Nachreisen @110509'], lastReasons: ['证据不支持'], roundsAttempted: 2 }],
})

const NESTED = [
  '# 报告', '',
  '## 一、已确证的结论', '',
  `${CLAIM_A} 这一点见 Zornhaw 页。此外，该页的记述与 Liechtenauer 体系中的整体安排一致，`,
  '可以作为后续比较各大师传本异同的起点；本节只陈述已通过验证的内容，不引入材料之外的新事实。', '',
  `## 二、${SUSPENSION_HEADING}`, '',
  '以下断言未通过验证，不作为结论，也不表示已被否定，仅表示当前证据不足以确证。', '',
  '### 逐条明细', '',
  `- ${CLAIM_X}`, '  - 未通过原因：证据不支持', '',
  '## 三、说明', '',
  '后续需要针对上述未确证的断言补充取证，或调整断言表述后重新提交验证。', '',
  '在此之前，本报告不对这些内容作任何结论性陈述。',
].join('\n')

const secs = splitSections(NESTED)
const rootSec = secs.find(s => /悬置/.test(s.heading ?? ''))
ok('切出了悬置节', Boolean(rootSec))
ok('悬置节的 text **包含后代子节**（含逐条明细）',
  (rootSec?.text ?? '').includes('逐条明细') && (rootSec?.text ?? '').includes(CLAIM_X),
  `textLen=${rootSec?.text.length}`)
ok('子节仍被保留（供范围判断）', secs.some(s => (s.heading ?? '').includes('逐条明细')))
ok('文档标题节（level 1）确实覆盖整篇', (secs.find(s => s.level === 1)?.end ?? 0) === NESTED.split('\n').length)

const part = partitionBySuspension(NESTED)
ok('悬置文本包含全部条目', part.suspensionText.includes(CLAIM_X))
ok('正文**不含**悬置节的子节内容（高层节也被正确排除）', !part.bodyText.includes('未通过原因'),
  JSON.stringify(part.bodyText.slice(0, 80)))
ok('正文仍含真正的正文节', part.bodyText.includes('已确证的结论') && part.bodyText.includes('调整断言表述'),
  JSON.stringify(part.bodyText.slice(-60)))

const cNested = postcheck(NESTED, nb)
ok('嵌套形态的合规报告通过检查（这正是之前的误报）', cNested.pass === true,
  JSON.stringify(cNested.issues.map(i => i.code)))

head('7c) 兜底补条目要补进悬置节**内部**，不能追加到文末')
// 文末追加会让补进去的来源名在结构上属于"最后一节"，被泄漏检查当成正文引用 → 自我否决
const partialNested = [
  '# 报告', '',
  '## 一、已确证的结论', '',
  `${CLAIM_A} 见 Zornhaw 页。该页的记述与 Liechtenauer 体系中的整体安排一致，`,
  '可以作为后续比较各大师传本异同的起点；本节只陈述已通过验证的内容。', '',
  `## 二、${SUSPENSION_HEADING}`, '',
  '（撰写者只写了标题，没逐条列）', '',
  '## 三、说明', '',
  '后续需要针对上述未确证的断言补充取证，或调整断言表述后重新提交验证。',
].join('\n')
const fixedNested = enforceSuspension(partialNested, nb.insufficient)
ok('补进去了缺失条目', fixedNested.includes(CLAIM_X))
ok('没有新增二级标题（补进了已有的悬置节）', (fixedNested.match(/^## /gm) ?? []).length === 3,
  (fixedNested.match(/^## .*/gm) ?? []).join('|'))
const afterPart = partitionBySuspension(fixedNested)
ok('补入内容落在悬置节范围内（不在正文）', afterPart.suspensionText.includes(CLAIM_X))
ok('正文不含补入内容', !afterPart.bodyText.includes(CLAIM_X))
ok('补入内容仍在「三、说明」之前（节内插入而非文末追加）',
  fixedNested.indexOf(CLAIM_X) > fixedNested.indexOf('二、') &&
  fixedNested.indexOf(CLAIM_X) < fixedNested.indexOf('## 三、说明'))
const cFixed = postcheck(fixedNested, nb)
ok('兜底后通过完整检查（不会自我否决）', cFixed.pass === true, JSON.stringify(cFixed.issues.map(i => i.code)))

head('7d) 悬置节内的子节引用来源，不算泄漏')
// 悬置明细里写"已尝试的证据：Zornhaw#Nachreisen"是完全正当的
const nestedWithSource = [
  '# 报告', '',
  '## 一、已确证的结论', '',
  `${CLAIM_A} 见 Zornhaw 页。该页的记述与 Liechtenauer 体系中的整体安排一致，`,
  '可以作为后续比较各大师传本异同的起点；本节只陈述已通过验证的内容。', '',
  `## 二、${SUSPENSION_HEADING}`, '',
  '### 逐条明细', '',
  `- ${CLAIM_X}`, '  - 已尝试的证据：Zornhaw#Nachreisen @110509', '',
  '## 三、说明', '',
  '后续需要针对上述未确证的断言补充取证，或调整断言表述后重新提交验证。',
].join('\n')
const cNestedSrc = postcheck(nestedWithSource, nb)
ok('悬置节子节里的来源引用不触发泄漏',
  !cNestedSrc.issues.some(i => i.code === 'SUSPENDED_EVIDENCE_PRESENTED_AS_SETTLED'),
  JSON.stringify(cNestedSrc.issues.map(i => i.code)))
ok('该形态整体通过检查', cNestedSrc.pass === true, JSON.stringify(cNestedSrc.issues.map(i => i.code)))

head('7e) 嵌套形态下，正文原样抄定位符仍要被抓')
const leakNested = [
  '# 报告', '',
  '## 一、结论', '',
  `${CLAIM_A} 见 Zornhaw 页。`, '',
  '另据 Zornhaw#Nachreisen @110509 可以确认所述用法。', '',
  `## 二、${SUSPENSION_HEADING}`, '',
  '### 逐条明细', '', `- ${CLAIM_X}`, '  - 未通过原因：证据不支持', '',
  '## 三、说明', '', '完。',
].join('\n')
const cLeak = postcheck(leakNested, nb)
ok('嵌套形态下正文抄定位符 → 仍被抓住',
  cLeak.issues.some(i => i.code === 'SUSPENDED_EVIDENCE_PRESENTED_AS_SETTLED'),
  JSON.stringify(cLeak.issues.map(i => i.code)))

// ══════════════════════════════════════════════════════════════
head('8) 交付材料渲染（撰写者实际读到的东西）')
const rendered = renderBrief(brief)
ok('渲染含研究题目', rendered.includes('【研究题目】') && rendered.includes(QUESTION))
ok('渲染含已通过断言数', /已通过验证的断言】共 2 条/.test(rendered), rendered.split('\n').find(l => l.includes('已通过')))
ok('渲染含未通过断言数', /未通过验证的断言】共 1 条/.test(rendered))
ok('渲染含来源标注', rendered.includes('Zornhaw#Meÿer @110509'))
ok('渲染明确要求逐条列入悬置节', /必须\*\*写进|必须.*悬置/.test(rendered))
ok('渲染含未通过原因', /未通过原因/.test(rendered))

// ══════════════════════════════════════════════════════════════
head('9) runReport：打回重写 → 代码兜底')
let c9 = 0
const seen = []
const r9 = await runReport({
  question: QUESTION, brief,
  askWriter: async (ctx) => {
    c9++
    seen.push(ctx)
    if (c9 === 1) return noSusp          // 第 1 稿故意忘写悬置节
    if (c9 === 2) return emptySusp       // 第 2 稿写个空标题
    return stubReport                    // 第 3 稿干脆只写正文
  },
})
ok('恰好 3 稿（封顶）', c9 === REPORT_DEFAULTS.maxRounds, `calls=${c9}`)
ok('第 2 稿收到了具体问题清单', (seen[1].issues?.length ?? 0) > 0, JSON.stringify(seen[1].issues?.map(i => i.code)))
ok('hint 明确要求逐条列入悬置节', /悬置/.test(seen[1].hint ?? ''))
ok('撰写者三轮都没通过', r9.writerPassed === false)
ok('但最终产物被代码兜底修正', r9.appendedByCode === true)
ok('最终产物通过完整检查', r9.check.pass === true, JSON.stringify(r9.check.issues.map(i => i.code)))
ok('最终产物确实含悬置节与悬置断言', /悬置/.test(r9.report) && r9.report.includes(CLAIM_X))

head('9b) runReport：一稿就合规则不打回')
let c9b = 0
const r9b = await runReport({
  question: QUESTION, brief,
  askWriter: async () => { c9b++; return GOOD_REPORT },
})
ok('只写了 1 稿', c9b === 1)
ok('撰写者通过', r9b.writerPassed === true)
ok('无需代码兜底', r9b.appendedByCode === false)

head('9c) runReport：撰写者全程抛异常也不崩')
const r9c = await runReport({
  question: QUESTION, brief,
  askWriter: async () => { throw new Error('模拟撰写者超时') },
})
ok('全程异常不崩', typeof r9c.report === 'string' && r9c.report.length > 0)
ok('异常时仍产出带悬置节的报告', r9c.appendedByCode === true && r9c.report.includes(CLAIM_X))
ok('异常被记录', r9c.history.every(h => /撰写者调用失败/.test(h.error ?? '')), JSON.stringify(r9c.history.map(h => h.error)))
ok('异常时 check 如实报错', r9c.check.issues.some(i => i.code === 'WRITER_ERROR' || i.code === 'ACCEPTED_CLAIM_MISSING'))

console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
process.exit(fails === 0 ? 0 : 1)
