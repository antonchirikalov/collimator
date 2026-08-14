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
// No prompt remains. Nine call sites, nine library agents, and what leaves this file is only
// what the script alone knows: paths, commands, items, round numbers. The brief node was the
// last holdout — justified as "a builtin, engine code rather than an agent", which was true in
// refract and stopped being true here, where nothing executes anything.
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

// --- Configuration: everything a caller can change without editing this file ---------------
//
// The hardcode that stays is the SHAPE of the pipeline: which stages exist, which agent runs
// each one, which artifact each one leaves, and which of them may fail without stopping the
// run. That is the thing this file is for.
//
// Everything that is a number, a threshold, a model or a language policy is a default here
// and an override in `args.config`. The test is whether two legitimate runs of this same
// pipeline would want different values: two do want different models, different round
// budgets and a different voice, and none of them want a different stage order. A value you
// have to edit the script to change is a value nobody changes.
const cfg = (args && args.config) || {}

const MAX_ROUNDS = cfg.maxRounds || 2
const MAX_ASPECTS = cfg.maxAspects || 4

// A file that exists and holds 200 characters is a file an agent created and walked away
// from. Existence is therefore measured, not tested.
const MIN_ARTIFACT_CHARS = cfg.minArtifactChars || 200

// Language policy, not pipeline shape. `ru_slop` only matches Russian, so a pipeline writing
// in English gains nothing from it and pays nothing for it; `no_bold` applies to any
// language. A caller writing for a publication that wants bold passes ['ru_slop'].
const GATE_PRESETS = cfg.gatePresets || ['ru_slop', 'no_bold']

// The author's voice profile. `null` is a real answer, not a missing one: a pipeline writing
// under someone else's byline supplies no voice and the writer falls back to the general
// anti-slop rules that hold regardless of author.
const VOICE_PATH =
  cfg.voicePath === undefined ? 'library/style/author-voice.md' : cfg.voicePath
const voicePort = VOICE_PATH ? [{ port: 'voice', path: VOICE_PATH }] : []

// Per stage, not per run. The judgement stages carry the article's quality and the carrying
// stages run a command and parse JSON; one model for both wastes money at one end and
// quality at the other.
const MODELS = Object.assign(
  {
    brief: 'opus',
    find: 'sonnet',
    analyse: 'opus',
    write: 'opus',
    critic: 'opus',
    style: 'opus',
    gate: 'haiku',
    record: 'haiku',
  },
  cfg.models || {},
)

// The gate is this repository's own script, so the invocation is a default rather than a
// constant: a pipeline vendored elsewhere keeps the stage and changes the path.
const GATE_TOOL = cfg.gateTool || 'python -X utf8 tools/gate.py'

// Length is not defaulted, and that is deliberate rather than an omission. When the order
// says nothing about size, the gate still measures the article and reports the numbers but
// passes no verdict on them: inventing a ceiling would hold the text to a figure nobody
// asked for, and the writer would be revised to it.

// --- No prompts in this file ----------------------------------------------------------------
//
// There are none left. Every agent this script calls is a library agent that already knows its
// job, and what travels from here is only what the script alone can know: which paths, which
// commands, which items, which round. The last three inline prompts became brief_writer,
// gate_runner and verbatim_writer — the brief node in particular used to be justified as "a
// builtin, engine code rather than an agent", which was true in refract and stopped being a
// reason once nothing here executes anything.
//
// The test is simple: a string in this file that would still make sense if the pipeline were
// about invoices instead of articles is orchestration. Anything else belongs in a prompt.md.

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
  const ports = (inputs || []).map((i) => `${i.port}: ${i.path}`).join('\n')
  return (
    (ports ? `INPUT\n${ports}\n\n` : '') +
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
  for (const preset of GATE_PRESETS) bounds.push(`--forbid-preset ${preset}`)
  return `${GATE_TOOL} --file ${path} ${bounds.join(' ')}`.trim()
}

// What gate_runner receives is a list of commands and nothing else. How to run them, what not
// to do to the output, and what to do when a command does not run at all are in its prompt.md,
// where they are written once for every pipeline instead of once per script.
function commands(list) {
  return `COMMANDS\n` + list.map((c, i) => `${i + 1}. ${c}`).join('\n')
}

// A file that exists but holds 200 characters is a file an agent created and abandoned, which
// is why existence is measured rather than tested: `--min-length` turns "is it there" and "is
// there anything in it" into one number the script can branch on.
function existenceCommands(paths) {
  return commands(
    paths.map((p) => `${GATE_TOOL} --file ${p} --min-length ${MIN_ARTIFACT_CHARS}`),
  )
}

// Same for verbatim_writer: a destination, a heading, and the items. Everything about not
// rephrasing them and not touching the article lives in its prompt.
function record(path, heading, items) {
  return (
    `FILE\n${path}\n\nHEADING\n${heading}\n\nITEMS\n` +
    items.map((r, i) => `${i + 1}. ${r}`).join('\n')
  )
}

// --- Brief -------------------------------------------------------------------------------

log(`[start] dir=${run}`)
log(`[start] order: ${order.replace(/\s+/g, ' ').slice(0, 200)}`)

phase('Brief')
const brief = must(
  await agent(
    task({
      output: BRIEF_PATH,
      extra: `THE ORDER, as the person wrote it:\n\n${order}`,
    }),
    {
      agentType: 'brief-writer',
      // Opus for the cheapest-looking stage in the run. What it decides is the research
      // agenda: aspects that pull apart send four finders at four different bodies of
      // material, aspects that are one question reworded send them all at the same page and
      // no later stage recovers from that.
      model: MODELS.brief,
      label: 'brief',
      phase: 'Brief',
      schema: BRIEF_OUT,
    },
  ),
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

// --- Resume: the artifacts on disk are the checkpoint -----------------------------------------
//
// A dynamic workflow lives inside the CLI process. When that process goes — a restart, a
// session moved to a background job — the run goes with it, and `resumeFromRunId` does not
// help because its cache is same-session only. A live run lost forty minutes exactly that way:
// the second attempt started from the brief, the brief invented new aspect slugs, and eleven
// source files already on disk became orphans nobody would ever read.
//
// So the checkpoint is not the cache, it is the disk. Before spending anything, ask what is
// already there and skip those stages loudly. Two things make this safe: brief_writer keeps an
// existing brief instead of re-inventing its slugs, so the filenames below stay the same
// across attempts; and every skip is logged by name, because a stage silently not running is
// indistinguishable from a stage that ran badly.
//
// `config.fresh` forces the whole thing to be rebuilt — for when the order changed and the
// artifacts on disk were written for a different one.
const sourcePaths = brief.aspects.map((a) => sourcePathOf(a.slug))
let present = new Set()
if (cfg.fresh) {
  log('[resume] config.fresh — всё пересобирается с нуля, ничего не переиспользуется')
} else {
  phase('Resume')
  const onDisk = await agent(existenceCommands([...sourcePaths, MATERIAL_PATH, ARTICLE_PATH]), {
    agentType: 'gate-runner',
    model: MODELS.gate,
    label: 'resume',
    phase: 'Resume',
    schema: EXISTENCE,
  })
  for (const c of (onDisk && onDisk.checks) || []) {
    if (c.ok) present.add(c.path)
  }
  log(
    `[resume] найдено готового: источников ${sourcePaths.filter((p) => present.has(p)).length}` +
      `/${sourcePaths.length}, материал=${present.has(MATERIAL_PATH)} ` +
      `черновик=${present.has(ARTICLE_PATH)}`,
  )
}

// --- Research: the fan-out lives in the script; an agent never produces a collection ---------

phase('Research')
const findings = await parallel(
  brief.aspects.map((aspect) => () => {
    if (present.has(sourcePathOf(aspect.slug))) return Promise.resolve('reused')
    return agent(
      task({
        inputs: [{ port: 'brief', path: BRIEF_PATH }],
        output: sourcePathOf(aspect.slug),
        extra: `Your aspect: ${aspect.question}`,
      }),
      {
        agentType: 'source-finder',
        model: MODELS.find,
        label: `find:${aspect.slug}`,
        phase: 'Research',
        schema: FOUND,
      },
    )
  }),
)

// parallel() keeps order and yields null where a call failed, so the index still names the
// aspect. Pairing before filtering matters: filtering first would shift results onto the
// wrong paths.
const found = []
for (let i = 0; i < brief.aspects.length; i++) {
  const result = findings[i]
  const aspect = brief.aspects[i]
  const path = sourcePathOf(aspect.slug)
  if (!result) {
    log(`[research/${aspect.slug}] the agent returned nothing`)
    continue
  }
  // A reused file has no list of titles to report: that list lived in the return value of an
  // agent from a run that no longer exists. The file is what the analyst reads, so the aspect
  // counts as covered — and the log says the count came from disk rather than from a search,
  // because "sources=0" next to a covered aspect is otherwise a mystery.
  if (result === 'reused') {
    found.push({ aspect, path, sources: [], reused: true })
    log(`[research/${aspect.slug}] переиспользован с диска, поиск не запускался`)
    continue
  }
  found.push({ aspect, path, sources: result.sources, reused: false })
  log(
    `[research/${aspect.slug}] sources=${result.sources.length} ` +
      `tool=${result.tool_used}`,
  )
  for (const s of result.sources) log(`[research/source] ${s.title} — ${s.url}`)
}
if (found.length === 0) throw new Error('not one source finder returned anything')

const sourcePorts = found.map((f) => ({ port: `sources:${f.aspect.slug}`, path: f.path }))
const totalSources = found.reduce((sum, f) => sum + f.sources.length, 0)
const reusedCount = found.filter((f) => f.reused).length
log(
  `[research] aspects_covered=${found.length}/${brief.aspects.length} sources=${totalSources}` +
    (reusedCount ? ` (переиспользовано с диска: ${reusedCount})` : ''),
)

// --- Analyse: between reading and writing, or the writer paraphrases its last source ---------

const analyseTask = task({
  inputs: [{ port: 'brief', path: BRIEF_PATH }, ...sourcePorts],
  output: MATERIAL_PATH,
})

phase('Analyse')
let analysis = null
if (present.has(MATERIAL_PATH)) {
  log('[analyse] материал уже на диске, аналитик не запускается')
} else {
  analysis = await agent(analyseTask, {
    agentType: 'domain-analyst',
    model: MODELS.analyse,
    label: 'analyse',
    phase: 'Analyse',
    schema: ANALYSIS,
  })
}
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
} else if (!present.has(MATERIAL_PATH)) {
  log('[analyse] THE ANALYST RETURNED NOTHING — the disk check decides whether material exists')
}

// --- Verify: a claimed path is not an artifact until something looks at the disk --------------

phase('Verify')
let existence = must(
  await agent(existenceCommands([...found.map((f) => f.path), MATERIAL_PATH]), {
    agentType: 'gate-runner',
    model: MODELS.gate,
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
      model: MODELS.analyse,
      label: 'analyse:2',
      phase: 'Verify',
      schema: ANALYSIS,
    },
  )
  existence = await agent(existenceCommands([MATERIAL_PATH]), {
    agentType: 'gate-runner',
    model: MODELS.gate,
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
    ...voicePort,
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

  // A draft already on disk is a draft nobody has judged yet, and rewriting it from scratch
  // throws away the most expensive agent in the run. So the first round skips the writer and
  // goes straight to the gate and the critics; from the second round on the writer always
  // runs, because by then there are remarks to act on.
  const skipWriter = round === 1 && present.has(ARTICLE_PATH)
  if (skipWriter) {
    log('[write/1] черновик уже на диске, писатель не запускается — сразу гейт и критики')
  } else {
    const article = must(
      await agent(task({ inputs: writeInputs, output: ARTICLE_PATH, extra: revision }), {
        agentType: 'article-writer',
        model: MODELS.write,
        label: `write:${round}`,
        phase: 'Write',
        schema: ARTICLE,
      }),
      `write:${round} — without a draft the round is empty`,
    )
    log(`[write/${round}] changes=${article.changes.length}`)
    for (const c of article.changes) log(`[write/${round}/change] ${c}`)
  }

  // Measure before judging, so neither critic spends a remark on something already counted.
  const sized = await agent(commands([gateCommand(ARTICLE_PATH, minProse, maxProse)]), {
    agentType: 'gate-runner',
    model: MODELS.gate,
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
          model: MODELS.critic,
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
            ...voicePort,
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
          model: MODELS.style,
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
    record(
      UNRESOLVED_PATH,
      passed
        ? 'The article was accepted, but these remarks were left unactioned'
        : 'The revision rounds ran out and these remarks were left open',
      openItems,
    ),
    { agentType: 'verbatim-writer', model: MODELS.record, label: 'unresolved', phase: 'Write', schema: WROTE },
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
const gate = await agent(commands([gateCommand(ARTICLE_PATH, minProse, maxProse)]), {
  agentType: 'gate-runner',
  model: MODELS.gate,
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
