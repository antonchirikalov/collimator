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
// Style is not a prompt here either. The author's voice lives in library/style/author-voice.md
// and travels as an input port to the writer and to the style critic; the mechanical half of
// it — bold and dead phrases — is a named preset inside tools/gate.py. Neither is written into
// this file, for the same reason nothing else is: a style description duplicated between the
// one who writes and the one who judges stops being one description after the first edit.
//
// Runtime limits respected here: meta is a pure literal; no import(); no Date.now and no
// Math.random; the script never touches the filesystem — every file is read and written by an
// agent, and every measurement is made by tools/gate.py through an agent that has Bash.

export const meta = {
  name: 'explainer-article',
  description: 'Explanatory article from a topic: find sources, reconcile them, write under critics',
  phases: [
    { title: 'Brief', detail: 'free-text order to brief.md, aspects and thresholds' },
    { title: 'Research', detail: 'source finders per aspect, in parallel' },
    { title: 'Analyse', detail: 'the analyst reconciles the sources into material' },
    { title: 'Verify', detail: 'were the claimed artifacts actually created' },
    { title: 'Write', detail: 'the writer under two critics: substance and style' },
    { title: 'Gate', detail: 'acceptance: arithmetic and bans through tools/gate.py' },
  ],
}

// --- Input -------------------------------------------------------------------------------

const run = typeof args === 'string' ? args : args && args.runDir
if (!run) {
  throw new Error('a run directory is required: args.runDir, e.g. docs-runs/attention')
}
const order = (args && args.brief) || ''
if (!order.trim()) {
  throw new Error('an order is required: args.brief — subject, length and wishes in one line')
}

// Every path is named here, by the script, and nowhere else. Agents receive paths and never
// report them back: a `path` field in a schema turns "say where it is" into a substitute for
// "put it there".
const BRIEF_PATH = `${run}/brief.md`
const MATERIAL_PATH = `${run}/material.md`
const ARTICLE_PATH = `${run}/article.md`
const UNRESOLVED_PATH = `${run}/UNRESOLVED.md`
const sourcePathOf = (slug) => `${run}/sources/${slug}.md`

// The author's voice profile, checked into the repository rather than written into a
// prompt. It goes to the writer and to the style critic unchanged, so the register the
// article is written in and the register it is judged by are one file — two copies of a
// style description drift inside a single round.
const VOICE_PATH = 'library/style/author-voice.md'

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

// A critic produces no file, and until this branch existed it was handed both descriptions
// of its own output at once: "OUTPUT (no file)" immediately followed by "the file is your
// result, write it". That is the same contradiction that made the analyst produce neither
// artifact, in the same script, one stage later.
const NO_FILE_RULE =
  `You write no file in this step and you edit nothing. The fields you return through the ` +
  `schema ARE your result — everything you found has to fit in them.`

function task({ inputs, output, extra, noFile }) {
  const ports = inputs.map((i) => `${i.port}: ${i.path}`).join('\n')
  return (
    `INPUT\n${ports}\n\n` +
    (noFile ? NO_FILE_RULE : `OUTPUT\n${output}\n\n` + OUTPUT_RULE) +
    (extra ? `\n\n${extra}` : '')
  )
}

// agent() yields null when a subagent dies on a terminal error after retries, or when the
// person running this skips it. Every dereference below assumed an object, and the most
// expensive of those assumptions sat in the last quarter of the script: `verdict.remarks`,
// reached only after both writing rounds had already been paid for.
function must(value, what) {
  if (!value) throw new Error(`the agent returned nothing: ${what}`)
  return value
}

// A critic that died is not a critic that approved. Silent passes are the failure this
// pipeline exists to prevent, so a missing verdict becomes `revise` plus an open item.
//
// English, like every other string in this file that an agent can read. Russian in this
// script is reserved for what only the person running it sees: log() lines, thrown errors,
// and the meta block the interface renders.
function noVerdict(who) {
  return {
    verdict: 'revise',
    remarks: [`${who} returned no verdict — that is an open item, not silent agreement`],
  }
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
    tool_used: { type: 'string', description: 'exact name of the search tool, as called' },
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
      description: 'what you changed in response to the remarks; empty on the first round',
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

// The style critic's verdict carries its evidence. A previous run in this project taught
// the shape: an inspecting agent stamped `ok` with an empty defect list on three pictures,
// two of which carried English captions in a Russian article. What fixed it was not a
// sterner wording but a schema field that cannot be filled without doing the work — write
// out every bold span you found, verbatim. An empty list is then a real answer, because
// producing it required looking.
const STYLE_VERDICT = {
  type: 'object',
  required: ['verdict', 'counters', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['ok', 'revise'] },
    counters: {
      type: 'object',
      required: ['bold_spans', 'dead_phrases', 'hyphen_for_dash'],
      properties: {
        bold_spans: {
          type: 'array',
          items: { type: 'string' },
          description: 'every bold span in the prose, verbatim, asterisks included',
        },
        dead_phrases: {
          type: 'array',
          items: { type: 'string' },
          description: 'every dead phrase found, verbatim as it stands in the text',
        },
        hyphen_for_dash: { type: 'number', description: 'hyphens standing in for a dash, exact' },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['quote', 'reason', 'after'],
        properties: {
          quote: { type: 'string', description: 'the passage from the article, VERBATIM' },
          reason: { type: 'string', description: 'which criterion is violated and why' },
          after: { type: 'string', description: 'how it should read instead' },
        },
      },
    },
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
// The presets are named, not spelled out. Their patterns are Cyrillic and they live in
// gate.py; putting them on this command line would push Russian through argv on Windows,
// where the shell is whichever one the carrying agent picked and the codepage is whatever
// it happens to be. A name keeps the command pure ASCII.
//
// `no_bold` and `ru_slop` are here rather than in a critic's remarks because both are
// decidable by a regex, and a rule a regex can settle should never cost a revision round.
// The style critic then spends its rounds on rhythm and voice, which no regex reaches.
function gateCommand(path, min, max) {
  const bounds = []
  if (min) bounds.push(`--min-prose ${min}`)
  if (max) bounds.push(`--max-prose ${max}`)
  bounds.push('--forbid-preset ru_slop --forbid-preset no_bold')
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

log(`[start] dir=${run}`)
log(`[start] order: ${order.replace(/\s+/g, ' ').slice(0, 200)}`)

phase('Brief')
const brief = must(
  await agent(BRIEF_TASK, {
    model: 'haiku',
    label: 'brief',
    phase: 'Brief',
    schema: BRIEF_OUT,
  }),
  'brief — without aspects and a language there is nowhere to go',
)
const minProse = brief.min_prose
const maxProse = brief.max_prose
const hasBounds = Boolean(minProse || maxProse)
log(
  `[brief] file=${BRIEF_PATH} language=${brief.language} ` +
    `length=${hasBounds ? `${minProse || '?'}–${maxProse || '?'}` : 'not set by the order, the gate passes no verdict on it'} ` +
    `aspects=${brief.aspects.length}`,
)
for (const a of brief.aspects) log(`[brief/aspect] ${a.slug}: ${a.question}`)

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
    log(`[research/${aspect.slug}] the agent returned nothing`)
    continue
  }
  found.push({ aspect, path: sourcePathOf(aspect.slug), sources: result.sources })
  log(
    `[research/${aspect.slug}] sources=${result.sources.length} ` +
      `tool=${result.tool_used}`,
  )
  for (const s of result.sources) log(`[research/source] ${s.title} — ${s.url}`)
}
if (found.length === 0) throw new Error('not one source finder returned anything')

const sourcePorts = found.map((f) => ({ port: `sources:${f.aspect.slug}`, path: f.path }))
const totalSources = found.reduce((sum, f) => sum + f.sources.length, 0)
log(`[research] aspects_covered=${found.length}/${brief.aspects.length} sources=${totalSources}`)

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
// The analysis object is read here for the log only — the artifact the writer consumes is
// the file. A dead analyst therefore does not stop the run, but it must be visible: the
// verification stage below is what decides whether the material actually exists.
if (analysis) {
  log(
    `[analyse] agreements=${analysis.agreements.length} disagreements=${analysis.disagreements.length} ` +
      `gaps=${analysis.gaps.length}`,
  )
  for (const d of analysis.disagreements) log(`[analyse/disagreement] ${d}`)
  for (const g of analysis.gaps) log(`[analyse/gap] ${g}`)
} else {
  log('[analyse] THE ANALYST RETURNED NOTHING — the disk check decides whether material exists')
}

// --- Verify: a claimed path is not an artifact until something looks at the disk --------------

phase('Verify')
let existence = must(
  await agent(existenceCommand([...found.map((f) => f.path), MATERIAL_PATH]), {
    model: 'haiku',
    label: 'verify:1',
    phase: 'Verify',
    schema: EXISTENCE,
  }),
  'verify:1 — without the disk check this stage means nothing',
)
for (const c of existence.checks) {
  log(`[verify] ok=${c.ok} ${c.path}${c.problems.length ? ' | ' + c.problems.join('; ') : ''}`)
}

const materialCheck = existence.checks.find((c) => c.path.includes('material'))
if (materialCheck && !materialCheck.ok) {
  log(`[verify] MATERIAL NOT CREATED, retrying: ${materialCheck.problems.join('; ')}`)
  analysis = await agent(
    `The previous attempt left no file on disk: ${materialCheck.problems.join('; ')}\n\n` +
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
  const rechecked = existence ? existence.checks : []
  for (const c of rechecked) {
    log(`[verify/2] ok=${c.ok} ${c.path}${c.problems.length ? ' | ' + c.problems.join('; ') : ''}`)
  }
  if (!rechecked.length || rechecked.some((c) => !c.ok)) {
    log('[verify/2] STILL NO MATERIAL — the writer goes without it, and that is in the report')
  }
}

// --- Write: loop under two critics ------------------------------------------------------------
//
// Three judgements per round, and they are deliberately separate. The gate settles what a
// regex settles — length, bold, dead phrases — so no round is ever spent arguing about it.
// The mechanism critic owns whether the explanation is right. The style critic owns whether
// it sounds like the author rather than like a machine. One agent asked for all three does
// the easiest of them and calls it a review.
//
// The two critics run in parallel: neither reads the other's output, and a round costs the
// slower of them instead of their sum.

phase('Write')
let verdict = null
let styleVerdict = null
let gateProblems = []
let styleRemarks = []
let rounds = 0

for (let round = 1; round <= MAX_ROUNDS; round++) {
  rounds = round
  const writeInputs = [
    { port: 'brief', path: BRIEF_PATH },
    { port: 'material', path: MATERIAL_PATH },
    { port: 'voice', path: VOICE_PATH },
    ...sourcePorts,
  ]
  // Order of the revision block is the order of authority: what a regex measured, then what
  // the mechanism critic found, then style. A writer that runs out of attention runs out of
  // it on the last section, so the section that cannot be argued with goes first.
  const revision =
    round === 1
      ? null
      : (gateProblems.length
          ? `THE GATE (a deterministic check, not an opinion — act on all of it):\n` +
            gateProblems.map((p, i) => `${i + 1}. ${p}`).join('\n') +
            '\n\n'
          : '') +
        `THE CRITIC ON SUBSTANCE:\n` +
        verdict.remarks.map((r, i) => `${i + 1}. ${r}`).join('\n') +
        (styleRemarks.length
          ? `\n\nTHE STYLE CRITIC (the author's voice, machine patterns):\n` +
            styleRemarks.map((r, i) => `${i + 1}. ${r}`).join('\n')
          : '')

  const article = must(
    await agent(task({ inputs: writeInputs, output: ARTICLE_PATH, extra: revision }), {
      agentType: 'article-writer',
      model: 'sonnet',
      label: `write:${round}`,
      phase: 'Write',
      schema: ARTICLE,
    }),
    `write:${round} — without a draft the round is empty`,
  )
  log(`[write/${round}] changes=${article.changes.length}`)
  for (const c of article.changes) log(`[write/${round}/change] ${c}`)

  // Measure before judging, so neither critic spends a remark on something already counted.
  const sized = await agent(carry(gateCommand(ARTICLE_PATH, minProse, maxProse)), {
    model: 'haiku',
    label: `gate:${round}`,
    phase: 'Write',
    schema: GATE,
  })
  const sizedReport = sized
    ? sized.report
    : { ok: false, problems: ['the gate did not run — no measurements for this round'], measures: {} }
  gateProblems = sizedReport.problems
  log(
    `[gate/${round}] ok=${sizedReport.ok} problems=${gateProblems.length} ` +
      `measures=${JSON.stringify(sizedReport.measures)}`,
  )
  for (const p of gateProblems) log(`[gate/${round}/problem] ${p}`)

  const lastRound = round === MAX_ROUNDS
  const criticInputs = [
    { port: 'brief', path: BRIEF_PATH },
    { port: 'draft', path: ARTICLE_PATH },
    { port: 'material', path: MATERIAL_PATH },
    ...sourcePorts,
  ]

  const [judged, styled] = await parallel([
    () =>
      agent(
        task({
          inputs: criticInputs,
          noFile: true,
          extra:
            (hasBounds
              ? `Length has already been measured arithmetically: ` +
                `${gateProblems.length ? gateProblems.join('; ') : 'within the brief'}. ` +
                `Do not spend a remark on length.`
              : `The order set no length, so length is not a defect here.`) +
            ` Typography, rhythm and the author's voice belong to a style critic running` +
            ` beside you in this same round — leave them to it.` +
            (lastRound ? ' This is the last revision round; there are no more.' : ''),
        }),
        {
          agentType: 'article-critic',
          model: 'sonnet',
          label: `critic:${round}`,
          phase: 'Write',
          schema: VERDICT,
        },
      ),
    () =>
      agent(
        task({
          inputs: [
            { port: 'draft', path: ARTICLE_PATH },
            { port: 'brief', path: BRIEF_PATH },
            { port: 'voice', path: VOICE_PATH },
          ],
          noFile: true,
          extra:
            `A deterministic gate has already run over this draft with the presets` +
            ` ru_slop and no_bold, and reported: ` +
            `${gateProblems.length ? gateProblems.join('; ') : 'nothing found'}.` +
            ` Confirm what it found by quoting it, and spend your own rounds on what a` +
            ` regex cannot reach — rhythm, address, terminology, the author's voice.` +
            (lastRound ? ' This is the last revision round; there are no more.' : ''),
        }),
        {
          agentType: 'style-critic-ru',
          model: 'sonnet',
          label: `style:${round}`,
          phase: 'Write',
          schema: STYLE_VERDICT,
        },
      ),
  ])

  verdict = judged || noVerdict('the critic on substance')
  log(`[critic/${round}] verdict=${verdict.verdict} remarks=${verdict.remarks.length}`)
  for (const r of verdict.remarks) log(`[critic/${round}/remark] ${r}`)

  styleVerdict = styled || null
  if (styled) {
    // A finding is stored as one line the writer can act on: quote, why, and what it should
    // say instead. The critic's own wording is kept verbatim and the joiners are punctuation
    // rather than words — the findings are Russian, this file is not, and a paraphrase here
    // would hand the writer an edit nobody checked.
    styleRemarks = styled.findings.map((f) => `«${f.quote}» — ${f.reason} → ${f.after}`)
    const c = styled.counters
    log(
      `[style/${round}] verdict=${styled.verdict} findings=${styleRemarks.length} ` +
        `bold=${c.bold_spans.length} dead_phrases=${c.dead_phrases.length} ` +
        `hyphen_for_dash=${c.hyphen_for_dash}`,
    )
    for (const span of c.bold_spans) log(`[style/${round}/bold] ${span}`)
    for (const phrase of c.dead_phrases) log(`[style/${round}/dead_phrase] ${phrase}`)
    for (const r of styleRemarks) log(`[style/${round}/finding] ${r}`)
  } else {
    styleRemarks = noVerdict('the style critic').remarks
    log(`[style/${round}] THE STYLE CRITIC RETURNED NO VERDICT — the round counts as open`)
  }

  // All three conditions. An article the mechanism critic likes but written in machine
  // prose, one in the author's voice that explains the mechanism wrongly, and one both
  // critics like that overruns the brief are equally unfinished.
  const styleOk = Boolean(styled) && styled.verdict === 'ok'
  if (verdict.verdict === 'ok' && styleOk && sizedReport.ok) break
}

// A silent pass is forbidden. Remarks are recorded whether or not the verdict is `ok`: a critic
// that says "publishable, but this is wrong" has still found something. Style findings are on
// the same list — the stage that used to park a run for a human to accept them finding by
// finding does not exist here, because a workflow run has no human in the middle.
let unresolvedPath = null
const stylePassed = Boolean(styleVerdict) && styleVerdict.verdict === 'ok'
const openItems = [
  ...verdict.remarks,
  ...styleRemarks.map((r) => `Style: ${r}`),
  ...gateProblems.map((p) => `Gate: ${p}`),
]
if (openItems.length) {
  const passed = verdict.verdict === 'ok' && stylePassed && !gateProblems.length
  log(
    `[unresolved] rounds=${rounds} verdict=${verdict.verdict} ` +
      `style=${styleVerdict ? styleVerdict.verdict : 'no verdict'} ` +
      `${passed ? 'accepted with remarks' : 'NOT accepted'}: items=${openItems.length}`,
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
  unresolvedPath = wrote && wrote.written ? UNRESOLVED_PATH : null
  if (unresolvedPath) {
    log(`[unresolved] file=${unresolvedPath}`)
  } else {
    log(`[unresolved] FILE NOT WRITTEN, open items remain: ${openItems.length}`)
    for (const item of openItems) log(`[unresolved/item] ${item}`)
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
const report = gate
  ? gate.report
  : { ok: false, problems: ['the final gate did not run'], measures: {} }
log(`[gate] ok=${report.ok} measures=${JSON.stringify(report.measures)}`)
for (const p of report.problems) log(`[gate/problem] ${p}`)

// The agent in this chain is a link that can alter the data, and in one run it did: check that
// the verdict it returned matches the problems it returned, and that the raw output is there.
if (report.ok !== (report.problems.length === 0)) {
  log(`[gate] MISMATCH: ok=${report.ok} but ${report.problems.length} problems`)
}
if (!gate || !gate.stdout.includes('"ok"')) {
  log('[gate] MISMATCH: no gate JSON in the raw output — the command may not have run')
}

log(
  `[summary] aspects=${brief.aspects.length} sources=${totalSources} rounds=${rounds} ` +
    `verdict=${verdict.verdict} style=${styleVerdict ? styleVerdict.verdict : 'no verdict'} ` +
    `gate_ok=${report.ok} open_items=${openItems.length}`,
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
  style_verdict: styleVerdict ? styleVerdict.verdict : null,
  open_items: openItems.length,
  gate_ok: report.ok,
  gate_measures: report.measures,
}
