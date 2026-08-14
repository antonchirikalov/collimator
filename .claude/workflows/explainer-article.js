// Explanatory article from a topic: find sources, reconcile them, write under a critic.
//
// This script is an orchestrator and nothing else. It does not tell the library agents how to
// do their work — they already know, from their own definitions in .claude/agents/, generated
// from library/agents/<name>/prompt.md. What the script does is wire artifacts to ports, check
// that every artifact was actually produced, fan out, loop, and branch on verdicts.
//
// That rule was learned expensively. The previous version carried 9 902 characters of prompt
// text — 39% of the file — and one of those hand-written passages contradicted the analyst's
// own instructions: its prompt.md says the output is "one file conforming to analysis@v1"
// while the script demanded a specific path. The agent sat between two descriptions of its
// own output and produced neither. Invariant I5 exists for exactly this: I/O instructions are
// never hand-written.
//
// One prompt remains, marked below: the brief node. It turns the caller's free text into a
// brief@v1 artifact, and no agent in the library does that — in refract it was `builtin/brief`,
// engine code rather than an agent.
//
// Runtime limits respected here: meta is a pure literal; no import(); no Date.now and no
// Math.random; the script never touches the filesystem — every file is read and written by an
// agent, and every measurement is made by tools/gate.py through an agent that has Bash.

export const meta = {
  name: 'explainer-article',
  description: 'Объяснительная статья по теме: поиск источников, разбор, письмо под критиком',
  phases: [
    { title: 'Brief', detail: 'вольный текст заказа → brief.md, аспекты и пороги' },
    { title: 'Research', detail: 'источниковеды по аспектам, параллельно' },
    { title: 'Analyse', detail: 'аналитик сводит источники в материал' },
    { title: 'Verify', detail: 'созданы ли заявленные артефакты' },
    { title: 'Write', detail: 'писатель под критиком, гейт измеряет объём' },
    { title: 'Gate', detail: 'приёмка: арифметика через tools/gate.py' },
  ],
}

// --- Input -------------------------------------------------------------------------------

const run = typeof args === 'string' ? args : args && args.runDir
if (!run) {
  throw new Error('нужен каталог прогона: args.runDir, например docs-runs/attention')
}
const order = (args && args.brief) || ''
if (!order.trim()) {
  throw new Error('нужен заказ: args.brief — тема, объём и пожелания одной строкой')
}

// Every path is named here, by the script, and nowhere else. Agents receive paths and never
// report them back: a `path` field in a schema turns "say where it is" into a substitute for
// "put it there".
const BRIEF_PATH = `${run}/brief.md`
const MATERIAL_PATH = `${run}/material.md`
const ARTICLE_PATH = `${run}/article.md`
const UNRESOLVED_PATH = `${run}/UNRESOLVED.md`
const sourcePathOf = (slug) => `${run}/sources/${slug}.md`

const MAX_ROUNDS = 2
const MAX_ASPECTS = 4
// Length is not defaulted. When the order says nothing about size, the gate still measures
// the article and reports the numbers but passes no verdict on them: inventing a ceiling
// would hold the text to a figure nobody asked for, and the writer would be revised to it.

// --- The one prompt in this file ----------------------------------------------------------
//
// The brief node. Not an agent from the library — a builtin: it turns the caller's free text
// into the brief@v1 artifact every downstream agent consumes. Its output is also the only
// place the run's numbers come from, so nothing about length is hardcoded below.

const BRIEF_TASK =
  `The order for an article, as a person wrote it:

${order}

` +
  `Turn it into a brief and write that brief to ${BRIEF_PATH}. State: the subject; who the ` +
  `reader is and what they already know; the language of the article; the length in ` +
  `characters of readable text; what must be covered; what must stay out. Invent nothing ` +
  `the order does not contain — leave a field out rather than fill it with a guess.

` +
  `Return separately: the language; the length bounds in characters, but ONLY if the order ` +
  `states them — if it says nothing about length, omit both fields rather than pick a ` +
  `number; and between two and ${MAX_ASPECTS} aspects of the subject worth researching IN ` +
  `PARALLEL, meaning genuinely different questions rather than one question reworded. Each ` +
  `aspect carries a short latin slug for a filename and one sentence saying what to look for.`

// --- The I/O tail, generated the same way for every agent -----------------------------------
//
// A hand-written stand-in for refract's prompt.py, which builds this section from the agent's
// port contract. Until that is ported, this function is the single place where an agent is
// told what it gets and where it puts the result — one wording for all of them, instead of
// nine hand-written variants that drift apart.

const OUTPUT_RULE =
  `The file is your result. Write it with the Write tool before you finish; the fields you ` +
  `return through the schema describe it, they do not replace it and are saved nowhere. If ` +
  `the file already exists and needs changing, edit it rather than write it again.`

function task({ inputs, output, extra }) {
  const ports = inputs.map((i) => `${i.port}: ${i.path}`).join('\n')
  return (
    `INPUT\n${ports}\n\n` +
    `OUTPUT\n${output}\n\n` +
    OUTPUT_RULE +
    (extra ? `\n\n${extra}` : '')
  )
}

// --- Schemas: only what the script cannot know on its own ------------------------------------

const BRIEF_OUT = {
  type: 'object',
  // Only what the order cannot fail to imply. The bounds are absent when the order says
  // nothing about length, and absent is a meaningful answer here, not a missing one.
  required: ['language', 'aspects'],
  properties: {
    language: { type: 'string', description: 'language of the article, one word' },
    min_prose: { type: 'number', description: 'lower bound in characters, only if the order gives one' },
    max_prose: { type: 'number', description: 'upper bound in characters, only if the order gives one' },
    aspects: {
      type: 'array',
      minItems: 2,
      maxItems: MAX_ASPECTS,
      items: {
        type: 'object',
        required: ['slug', 'question'],
        properties: {
          slug: { type: 'string', description: 'latin, hyphenated, used as a filename' },
          question: { type: 'string', description: 'what to look for under this aspect' },
        },
      },
    },
  },
}

const FOUND = {
  type: 'object',
  required: ['sources', 'tool_used'],
  properties: {
    // The floor is 2 while the task asks for more: a schema guards against nothing at all,
    // the ambition belongs in the text. A live run failed a node that had everything it
    // needed because the floor was set to an ambition.
    sources: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        required: ['title', 'url'],
        properties: { title: { type: 'string' }, url: { type: 'string' } },
      },
    },
    tool_used: { type: 'string', description: 'точное имя инструмента поиска, как в вызове' },
  },
}

const ANALYSIS = {
  type: 'object',
  required: ['agreements', 'disagreements', 'gaps'],
  properties: {
    agreements: { type: 'array', items: { type: 'string' } },
    disagreements: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
}

const ARTICLE = {
  type: 'object',
  required: ['changes'],
  properties: {
    // No counts from the writer: measuring characters is the gate's job, not a model's.
    changes: {
      type: 'array',
      items: { type: 'string' },
      description: 'что изменено по замечаниям; на первом круге пустой список',
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['verdict', 'remarks'],
  properties: {
    verdict: { type: 'string', enum: ['ok', 'revise'] },
    remarks: { type: 'array', items: { type: 'string' } },
  },
}

const WROTE = {
  type: 'object',
  required: ['written'],
  properties: { written: { type: 'boolean' } },
}

const REPORT = {
  type: 'object',
  required: ['ok', 'problems', 'measures'],
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
    measures: { type: 'object' },
  },
}

const GATE = {
  type: 'object',
  required: ['report', 'stdout'],
  // Not named `measures`: the gate's own JSON has a `measures` key, and the collision made one
  // and the same contract come back in two different shapes across two runs.
  properties: { report: REPORT, stdout: { type: 'string' } },
}

const EXISTENCE = {
  type: 'object',
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'ok', 'problems'],
        properties: {
          path: { type: 'string' },
          ok: { type: 'boolean' },
          problems: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

// --- Measurement: python counts, an agent carries, the script decides -------------------------
//
// The script has no shell, so it cannot run the gate itself; the agent exists only to carry the
// command and bring the JSON back. Python does the counting because a model cannot: asked to
// judge length by eye, two critics said 10 500-11 500 where the answer was 10 033.

// The bounds are optional on purpose: a run whose order said nothing about length gets a
// measurement and no verdict. gate.py with no rule still reports chars and prose_chars.
function gateCommand(path, min, max) {
  const bounds = []
  if (min) bounds.push(`--min-prose ${min}`)
  if (max) bounds.push(`--max-prose ${max}`)
  return `python -X utf8 tools/gate.py --file ${path} ${bounds.join(' ')}`.trim()
}

function carry(command) {
  return (
    `Run exactly this command from the repository root and return its result unchanged — ` +
    `add nothing, correct nothing, repackage nothing:\n\n${command}\n\n` +
    `Return the parsed report in the report field and the raw output in stdout. If the ` +
    `command did not run, say so in stdout and do not invent a report.`
  )
}

function existenceCommand(paths) {
  return (
    `For EACH path in the list, run exactly this command from the repository root with the ` +
    `path substituted, and return one element per path:\n\n` +
    `python -X utf8 tools/gate.py --file <path> --min-length 200\n\n` +
    paths.map((p, i) => `${i + 1}. ${p}`).join('\n') +
    `\n\nCreate nothing and fix nothing — only measure.`
  )
}

// --- Brief -------------------------------------------------------------------------------

log(`[start] каталог=${run}`)
log(`[start] заказ: ${order.replace(/\s+/g, ' ').slice(0, 200)}`)

phase('Brief')
const brief = await agent(BRIEF_TASK, {
  model: 'haiku',
  label: 'brief',
  phase: 'Brief',
  schema: BRIEF_OUT,
})
const minProse = brief.min_prose
const maxProse = brief.max_prose
const hasBounds = Boolean(minProse || maxProse)
log(
  `[brief] файл=${BRIEF_PATH} язык=${brief.language} ` +
    `объём=${hasBounds ? `${minProse || '?'}–${maxProse || '?'}` : 'заказом не задан, гейт его не проверяет'} ` +
    `аспектов=${brief.aspects.length}`,
)
for (const a of brief.aspects) log(`[brief/аспект] ${a.slug}: ${a.question}`)

// --- Research: the fan-out lives in the script; an agent never produces a collection ---------

phase('Research')
const findings = await parallel(
  brief.aspects.map((aspect) => () =>
    agent(
      task({
        inputs: [{ port: 'brief', path: BRIEF_PATH }],
        output: sourcePathOf(aspect.slug),
        extra: `Your aspect: ${aspect.question}`,
      }),
      {
        agentType: 'source-finder',
        model: 'sonnet',
        label: `find:${aspect.slug}`,
        phase: 'Research',
        schema: FOUND,
      },
    ),
  ),
)

// parallel() keeps order and yields null where a call failed, so the index still names the
// aspect. Pairing before filtering matters: filtering first would shift results onto the
// wrong paths.
const found = []
for (let i = 0; i < brief.aspects.length; i++) {
  const result = findings[i]
  const aspect = brief.aspects[i]
  if (!result) {
    log(`[research/${aspect.slug}] агент не вернул результат`)
    continue
  }
  found.push({ aspect, path: sourcePathOf(aspect.slug), sources: result.sources })
  log(
    `[research/${aspect.slug}] источников=${result.sources.length} ` +
      `инструмент=${result.tool_used}`,
  )
  for (const s of result.sources) log(`[research/источник] ${s.title} — ${s.url}`)
}
if (found.length === 0) throw new Error('ни один источниковед не вернул результат')

const sourcePorts = found.map((f) => ({ port: `sources:${f.aspect.slug}`, path: f.path }))
const totalSources = found.reduce((sum, f) => sum + f.sources.length, 0)
log(`[research] аспектов_закрыто=${found.length}/${brief.aspects.length} источников=${totalSources}`)

// --- Analyse: between reading and writing, or the writer paraphrases its last source ---------

const analyseTask = task({
  inputs: [{ port: 'brief', path: BRIEF_PATH }, ...sourcePorts],
  output: MATERIAL_PATH,
})

phase('Analyse')
let analysis = await agent(analyseTask, {
  agentType: 'domain-analyst',
  model: 'sonnet',
  label: 'analyse',
  phase: 'Analyse',
  schema: ANALYSIS,
})
log(
  `[analyse] согласий=${analysis.agreements.length} расхождений=${analysis.disagreements.length} ` +
    `пробелов=${analysis.gaps.length}`,
)
for (const d of analysis.disagreements) log(`[analyse/расхождение] ${d}`)
for (const g of analysis.gaps) log(`[analyse/пробел] ${g}`)

// --- Verify: a claimed path is not an artifact until something looks at the disk --------------

phase('Verify')
let existence = await agent(existenceCommand([...found.map((f) => f.path), MATERIAL_PATH]), {
  model: 'haiku',
  label: 'verify:1',
  phase: 'Verify',
  schema: EXISTENCE,
})
for (const c of existence.checks) {
  log(`[verify] ok=${c.ok} ${c.path}${c.problems.length ? ' | ' + c.problems.join('; ') : ''}`)
}

const materialCheck = existence.checks.find((c) => c.path.includes('material'))
if (materialCheck && !materialCheck.ok) {
  log(`[verify] МАТЕРИАЛ НЕ СОЗДАН, круг повтора: ${materialCheck.problems.join('; ')}`)
  analysis = await agent(
    `Предыдущая попытка не оставила файла на диске: ${materialCheck.problems.join('; ')}\n\n` +
      analyseTask,
    {
      agentType: 'domain-analyst',
      model: 'sonnet',
      label: 'analyse:2',
      phase: 'Verify',
      schema: ANALYSIS,
    },
  )
  existence = await agent(existenceCommand([MATERIAL_PATH]), {
    model: 'haiku',
    label: 'verify:2',
    phase: 'Verify',
    schema: EXISTENCE,
  })
  for (const c of existence.checks) {
    log(`[verify/2] ok=${c.ok} ${c.path}${c.problems.length ? ' | ' + c.problems.join('; ') : ''}`)
  }
  if (existence.checks.some((c) => !c.ok)) {
    log('[verify/2] МАТЕРИАЛА ТАК И НЕТ — писатель пойдёт без него, это в отчёте')
  }
}

// --- Write: loop under a critic; the gate measures, the critic judges the mechanism -----------

phase('Write')
let verdict = null
let sizeProblems = []
let rounds = 0

for (let round = 1; round <= MAX_ROUNDS; round++) {
  rounds = round
  const writeInputs = [
    { port: 'brief', path: BRIEF_PATH },
    { port: 'material', path: MATERIAL_PATH },
    ...sourcePorts,
  ]
  const revision =
    round === 1
      ? null
      : `Замечания критика:\n` +
        verdict.remarks.map((r, i) => `${i + 1}. ${r}`).join('\n') +
        (sizeProblems.length
          ? `\nИзмерено гейтом (арифметика, не мнение — выполнить обязательно):\n` +
            sizeProblems.map((p, i) => `${i + 1}. ${p}`).join('\n')
          : '')

  const article = await agent(
    task({ inputs: writeInputs, output: ARTICLE_PATH, extra: revision }),
    {
      agentType: 'article-writer',
      model: 'sonnet',
      label: `write:${round}`,
      phase: 'Write',
      schema: ARTICLE,
    },
  )
  log(`[write/${round}] изменений=${article.changes.length}`)
  for (const c of article.changes) log(`[write/${round}/правка] ${c}`)

  // Measure before judging, so the critic spends its remarks on the mechanism instead of
  // estimating length by eye.
  const sized = await agent(carry(gateCommand(ARTICLE_PATH, minProse, maxProse)), {
    model: 'haiku',
    label: `gate:${round}`,
    phase: 'Write',
    schema: GATE,
  })
  sizeProblems = sized.report.problems
  log(
    `[gate/${round}] ok=${sized.report.ok} проблем=${sizeProblems.length} ` +
      `измерения=${JSON.stringify(sized.report.measures)}`,
  )
  for (const p of sizeProblems) log(`[gate/${round}/проблема] ${p}`)

  verdict = await agent(
    task({
      inputs: [
        { port: 'brief', path: BRIEF_PATH },
        { port: 'draft', path: ARTICLE_PATH },
        { port: 'material', path: MATERIAL_PATH },
        ...sourcePorts,
      ],
      output: '(no file — return the verdict through the schema)',
      extra:
        (hasBounds
          ? `Length has already been measured arithmetically: ` +
            `${sizeProblems.length ? sizeProblems.join('; ') : 'within the brief'}. ` +
            `Do not spend a remark on length.`
          : `The order set no length, so length is not a defect here.`) +
        (round < MAX_ROUNDS ? '' : ' This is the last revision round; there are no more.'),
    }),
    {
      agentType: 'article-critic',
      model: 'sonnet',
      label: `critic:${round}`,
      phase: 'Write',
      schema: VERDICT,
    },
  )
  log(`[critic/${round}] вердикт=${verdict.verdict} замечаний=${verdict.remarks.length}`)
  for (const r of verdict.remarks) log(`[critic/${round}/замечание] ${r}`)

  // Both conditions: an article inside the brief's length with an unaddressed remark and one
  // the critic likes that overruns are equally unfinished.
  if (verdict.verdict === 'ok' && sized.report.ok) break
}

// A silent pass is forbidden. Remarks are recorded whether or not the verdict is `ok`: a critic
// that says "publishable, but this is wrong" has still found something.
let unresolvedPath = null
const openItems = [...verdict.remarks, ...sizeProblems.map((p) => `Гейт: ${p}`)]
if (openItems.length) {
  const passed = verdict.verdict === 'ok' && !sizeProblems.length
  log(
    `[unresolved] раундов=${rounds} вердикт=${verdict.verdict} ` +
      `${passed ? 'принято с замечаниями' : 'НЕ принято'}: пунктов=${openItems.length}`,
  )
  const wrote = await agent(
    (passed
      ? 'The article was accepted, but these remarks were left unactioned. '
      : 'The revision rounds ran out and these remarks were left open. ') +
      `Write the file ${UNRESOLVED_PATH} and do nothing else: do not touch the article and ` +
      `do not add judgements of your own. The file holds a heading and the items verbatim, ` +
      `one per line, in the language they are written in:\n\n` +
      openItems.map((r, i) => `${i + 1}. ${r}`).join('\n'),
    { model: 'haiku', label: 'unresolved', phase: 'Write', schema: WROTE },
  )
  unresolvedPath = wrote.written ? UNRESOLVED_PATH : null
  if (unresolvedPath) {
    log(`[unresolved] файл=${unresolvedPath}`)
  } else {
    log(`[unresolved] ФАЙЛ НЕ ЗАПИСАН, незакрытые пункты остаются: ${openItems.length}`)
    for (const item of openItems) log(`[unresolved/пункт] ${item}`)
  }
}

// --- Gate: the acceptance record ---------------------------------------------------------

phase('Gate')
const gate = await agent(carry(gateCommand(ARTICLE_PATH, minProse, maxProse)), {
  model: 'haiku',
  label: 'gate:final',
  phase: 'Gate',
  schema: GATE,
})
const report = gate.report
log(`[gate] ok=${report.ok} измерения=${JSON.stringify(report.measures)}`)
for (const p of report.problems) log(`[gate/проблема] ${p}`)

// The agent in this chain is a link that can alter the data, and in one run it did: check that
// the verdict it returned matches the problems it returned, and that the raw output is there.
if (report.ok !== (report.problems.length === 0)) {
  log(`[gate] РАСХОЖДЕНИЕ: ok=${report.ok}, а проблем ${report.problems.length}`)
}
if (!gate.stdout.includes('"ok"')) {
  log('[gate] РАСХОЖДЕНИЕ: в сыром выводе нет JSON гейта — возможно, команда не запускалась')
}

log(
  `[итог] аспектов=${brief.aspects.length} источников=${totalSources} кругов=${rounds} ` +
    `вердикт=${verdict.verdict} гейт_ok=${report.ok} незакрытых=${openItems.length}`,
)

return {
  brief: BRIEF_PATH,
  sources: found.map((f) => f.path),
  material: MATERIAL_PATH,
  article: ARTICLE_PATH,
  unresolved: unresolvedPath,
  aspects: brief.aspects.map((a) => a.slug),
  sources_total: totalSources,
  rounds,
  verdict: verdict.verdict,
  open_items: openItems.length,
  gate_ok: report.ok,
  gate_measures: report.measures,
}
