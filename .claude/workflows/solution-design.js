// Solution design from raw input documents: extract, build requirements, design under a critic.
//
// The second archetype, and it exists to answer a question about the first: how much of
// explainer-article.js is the article, and how much is machinery that any document pipeline
// needs? The answer is in this file. Everything between the I/O tail and the audit was copied
// from there with names changed and nothing else; the wiring — what is read, who is called, in
// what order — is new.
//
// One deliberate improvement over the original, forced by this pipeline rather than invented:
// the revision loop is a function here, because this archetype runs it twice (once for the
// requirements, once for the design). In the article script the same code sits inlined once. That
// is what a second archetype is for — it shows which parts are parameters and which are constants.
//
// What this pipeline does NOT do that the article one does: no web search (the sources are given,
// not found), no style critic (an internal design document has no author's voice to protect), no
// arithmetic corrector (there is no worked example to recompute). What it adds: a fan-out whose
// width comes off the disk rather than out of the brief, a two-model contest with a selector, and
// a discovery stage that produces the questions the design could not answer by itself.
//
// Runtime limits respected here, same as the article script: meta is a pure literal; no import();
// no Date.now and no Math.random; the script never touches the filesystem — every file is read and
// written by an agent, and every measurement is made by a python tool through an agent with Bash.

export const meta = {
  name: 'solution-design',
  description: 'Solution design from input documents: extract, requirements, design under a critic',
  phases: [
    { title: 'Resume', detail: 'what is already on disk, and is anybody else working here' },
    { title: 'Extract', detail: 'one agent per input document, in parallel' },
    { title: 'Requirements', detail: 'writer, corrector, gate, critic, in rounds' },
    { title: 'Contest', detail: 'two models design in parallel, a selector picks one' },
    { title: 'Design', detail: 'the winner is refined against a critic, in rounds' },
    { title: 'Discovery', detail: 'what the design could not answer becomes questions' },
    { title: 'Gate', detail: 'records, unresolved items, audit of the run directory' },
  ],
}

// --- Input -------------------------------------------------------------------------------

const run = typeof args === 'string' ? args : args && args.runDir
if (!run) {
  throw new Error('a run directory is required: args.runDir, e.g. docs-runs/reporting')
}
// Optional, and its absence is announced rather than assumed. Without a clock the script cannot
// ask how long this directory has been quiet, which is the only way it can tell that another run
// is working here. `Date.now()` is not available: a script that calls it is refused at submission,
// because resume replays cached agent() calls and a script that branches on time cannot replay.
const now = (args && args.now) || ''
// Free text about what is wanted, if there is any. Unlike the article pipeline this one does not
// require it: the input documents ARE the order here. When present it goes to the requirements
// writer as an extra port.
const order = (args && args.order) || ''

const cfg = (args && args.config) || {}

// --- Paths: named here, by the script, and nowhere else --------------------------------------
//
// Agents receive paths and never report them back. A `path` field in a schema turns "say where it
// is" into a substitute for "put it there", and one live run had the disk check return absolute
// Windows paths where the script had passed relative posix ones — nothing matched, and five agents
// redid work that was already on disk. Results are matched to commands BY INDEX instead.
const INPUTS_DIR = `${run}/inputs`
const EXTRACTS_DIR = `${run}/extracts`
const REQ_PATH = `${run}/requirements.md`
const DESIGN_PATH = `${run}/design.md`
const DISCOVERY_PATH = `${run}/discovery-questions.md`
const UNRESOLVED_PATH = `${run}/UNRESOLVED.md`
const CANDIDATES_DIR = `${run}/design-candidates`
const candidatePathOf = (n) => `${CANDIDATES_DIR}/candidate-${n}.md`
const extractPathOf = (stem) => `${EXTRACTS_DIR}/${stem}.md`
// One directory per loop, because there are two loops and their records must not mix. `rounds.py`
// counts what it finds in one directory, so two loops sharing one would each see the other's
// rounds and continue from the wrong number.
const roundsDirOf = (loop) => `${run}/rounds/${loop}`
const roundPathOf = (loop, n) => `${roundsDirOf(loop)}/round-${n}.md`
const draftPathOf = (loop, n) => `${roundsDirOf(loop)}/draft-${n}.md`
const TOOLS_LOG = `${run}/tools.jsonl`
const HANDOFF_PATH = `${run}/handoff.md`

// --- Configuration: everything a caller can change without editing this file -----------------

const STAGES = cfg.stages || ['requirements', 'design']
const RUN_REQUIREMENTS = STAGES.includes('requirements')
const RUN_DESIGN = STAGES.includes('design')
if (!RUN_REQUIREMENTS && !RUN_DESIGN) {
  throw new Error(`config.stages must name "requirements", "design" or both; got: ${STAGES.join(', ')}`)
}
const MAX_ROUNDS = cfg.maxRounds || 3
const PLATEAU_ROUNDS = cfg.plateauRounds || 2
const MIN_ARTIFACT_CHARS = cfg.minArtifactChars || 200
const RUN_DISCOVERY = cfg.discovery !== false
// The contest. Two models rather than two temperatures: the point is a different reading of the
// same requirements, and the selector then has something to choose between. One model here is a
// legal answer and turns the contest off.
const CONTEST_MODELS = cfg.contestModels || ['opus', 'sonnet']
const MODELS = {
  extract: 'sonnet',
  reqWrite: 'opus',
  reqFix: 'sonnet',
  reqCritic: 'opus',
  design: 'opus',
  designCritic: 'opus',
  select: 'opus',
  probe: 'opus',
  discovery: 'opus',
  gate: 'sonnet',
  record: 'sonnet',
  copy: 'sonnet',
  ...(cfg.models || {}),
}
// Length bounds. Absent is a legal answer and it is the default for the ceiling: the gate then
// measures and does not judge.
//
// A ceiling nobody asked for makes acceptance unreachable, and this was measured rather than
// reasoned. An invented ceiling of 40 000 met a critic holding four blocking defects, each of
// which is closed by specifying something the design had left vague. Round 2 grew the document to
// 42 126, round 3 was told to remove 2 126 and not add — and grew it to 44 590. Neither agent was
// wrong: the critic asked for specification, the gate asked for cuts, and the loop cannot satisfy
// both. In the article pipeline the same budget block worked on the first try, because there the
// ceiling came from the order — the client's own requirement — rather than from the script.
//
// So the script states no ceiling of its own. A caller whose order names one passes it.
const REQ_BOUNDS = cfg.reqBounds || { min: 6000, max: 0 }
const DESIGN_BOUNDS = cfg.designBounds || { min: 12000, max: 0 }
// No forbidden-pattern files by default. This is an internal engineering document, not an article
// in someone's voice, and the slop list is editorial policy for published prose. A caller who
// wants it passes paths.
const FORBID_FILES = cfg.forbidFiles || []

// Which directories belong to which stage, so the audit can tell a loss from somebody else's
// business. A launch that only designs never opens `inputs/` or `extracts/`, and never should.
const STAGE_OWNED = [
  { prefix: `${INPUTS_DIR}/`, mine: RUN_REQUIREMENTS },
  { prefix: `${EXTRACTS_DIR}/`, mine: RUN_REQUIREMENTS },
  { prefix: `${roundsDirOf('req')}/`, mine: RUN_REQUIREMENTS },
  { prefix: `${CANDIDATES_DIR}/`, mine: RUN_DESIGN },
  { prefix: `${roundsDirOf('design')}/`, mine: RUN_DESIGN },
]

const GATE_TOOL = cfg.gateTool || 'python -X utf8 tools/gate.py'
const ROUNDS_TOOL = cfg.roundsTool || 'python -X utf8 tools/rounds.py'
const LISTING_TOOL = cfg.listingTool || 'python -X utf8 tools/listing.py'
const SNAPSHOT_TOOL = cfg.snapshotTool || 'python -X utf8 tools/snapshot.py'
const BUSY_TOOL = cfg.busyTool || 'python -X utf8 tools/busy.py'

// --- No prompts in this file ------------------------------------------------------------------
//
// Every agent called here is a library agent that already knows its job from its own prompt.md.
// What travels from this file is only what the script alone can know: which paths, which commands,
// which items, which round, which model. The test: a string here that would still make sense if
// the pipeline produced a marketing plan instead of a design is orchestration; anything else
// belongs in a prompt.

// --- The I/O tail, generated the same way for every agent -------------------------------------

const OUTPUT_RULE =
  `The file is your result. Write it with the Write tool before you finish; the fields you ` +
  `return through the schema describe it, they do not replace it and are saved nowhere. If ` +
  `the file already exists and needs changing, edit it rather than write it again.`

// A critic produces no file. Until this branch existed, a critic was handed both descriptions of
// its own output at once — "OUTPUT (no file)" followed by "the file is your result, write it" —
// and that contradiction is what made an analyst produce neither artifact.
const NO_FILE_RULE =
  `You write no file in this step and you edit nothing. The fields you return through the ` +
  `schema ARE your result — everything you found has to fit in them.`

// Every path that ever reaches an agent, recorded as it goes. Not bookkeeping anyone has to
// remember: a path becomes consumed by the only act that can consume it — appearing in a task —
// so there is no way to hand a file to an agent without this seeing it. The audit at the end
// subtracts this set from what is on disk, because every loss this project has had was the same
// shape: a file produced and never read.
const touched = new Set()
touched.add(TOOLS_LOG)

const handoff = []
let lastPorts = null

// Things that did not stop the run but change how its result must be read. `log()` is not enough
// for these: it lives in the run transcript, and the transcript is exactly what is gone by the
// time someone asks why a section is thin. They go on disk with the handoff record.
const warnings = []

// A remark without the number the critic put in front of it. The ledger is one list per round
// precisely because several lists each numbered from one make a number meaningless, and a critic
// numbering its own items rebuilds that by hand. Only a leading ordinal goes.
const unnumbered = (text) => String(text).replace(/^\s*\d{1,2}[.)]\s+/, '')

// A file name from a path, without directory and without suffix. The listing reports what is on
// disk; this turns each reported name into the name of the file the script will write next to it,
// so the correspondence between an input and its extract is visible in the directory.
const stemOf = (path) =>
  String(path)
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '')

async function call(taskText, opts) {
  handoff.push({
    label: opts.label,
    agent: opts.agentType || '(встроенный)',
    model: opts.model,
    inputs: (lastPorts && lastPorts.inputs) || [],
    output: (lastPorts && lastPorts.output) || null,
  })
  lastPorts = null
  return agent(taskText, opts)
}

function task({ inputs, output, extra, noFile }) {
  for (const i of inputs || []) touched.add(i.path)
  if (!noFile && output) touched.add(output)
  lastPorts = {
    inputs: (inputs || []).map((i) => `${i.port} → ${i.path}`),
    output: noFile ? null : output,
  }
  const ports = (inputs || []).map((i) => `${i.port}: ${i.path}`).join('\n')
  return (
    (ports ? `INPUT\n${ports}\n\n` : '') +
    (noFile ? NO_FILE_RULE : `OUTPUT\n${output}\n\n` + OUTPUT_RULE) +
    (extra ? `\n\n${extra}` : '')
  )
}

// agent() yields null when a subagent dies on a terminal error after retries, or when the person
// running this skips it. The most expensive of those assumptions used to sit in the last quarter
// of a script, reached only after both writing rounds had been paid for.
function must(value, what) {
  if (!value) throw new Error(`the agent returned nothing: ${what}`)
  return value
}

// A critic that died is not a critic that approved. Silent passes are the failure this pipeline
// exists to prevent, so a missing verdict becomes `revise` plus an open item.
function noVerdict(who) {
  return {
    verdict: 'revise',
    remarks: [`${who} returned no verdict — that is an open item, not silent agreement`],
  }
}

// --- Schemas: only what the script cannot know on its own -------------------------------------

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
  properties: { report: REPORT, stdout: { type: 'string' } },
}

const LISTING = {
  type: 'object',
  required: ['files', 'count'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    // Required so the carrier can be checked against itself: a live audit had the tool print 37
    // paths and the agent return one. A carrier that drops the list also drops the count, and
    // then the two disagree and say so. Carrying a number is the one thing a summarising agent
    // does not shorten.
    count: { type: 'integer', description: 'the files number from the report measures, verbatim' },
  },
}

const EXISTENCE = {
  type: 'object',
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ok', 'problems'],
        properties: {
          ok: { type: 'boolean' },
          problems: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const BUSY = {
  type: 'object',
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['busy', 'problems'],
        properties: {
          busy: { type: 'boolean', description: 'the busy field of the report, verbatim' },
          problems: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const ROUNDS = {
  type: 'object',
  required: ['report', 'rounds', 'counts'],
  properties: {
    // Asked for by name rather than left inside the free-form `measures`, because a free-form
    // object is precisely what a summarising carrier trims. One number per round, for every
    // round: the plateau detector needs the whole history, and `rounds` carries only the newest.
    counts: {
      type: 'array',
      description: 'the counts array from the report measures, verbatim, one entry per round',
      items: {
        type: 'object',
        required: ['round', 'items'],
        properties: { round: { type: 'number' }, items: { type: 'number' } },
      },
    },
    report: REPORT,
    rounds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['round', 'verdict', 'style_verdict', 'remarks', 'style', 'gate'],
        properties: {
          round: { type: 'number' },
          verdict: { type: 'string' },
          style_verdict: { type: 'string' },
          remarks: { type: 'array', items: { type: 'string' } },
          style: { type: 'array', items: { type: 'string' } },
          gate: { type: 'array', items: { type: 'string' } },
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

const EXTRACT = {
  type: 'object',
  required: ['facts', 'open_questions'],
  properties: {
    facts: {
      type: 'array',
      items: { type: 'string' },
      description: 'what this document establishes, in its own terms',
    },
    open_questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'what it raises and does not answer',
    },
  },
}

// The writer of either document answers the ledger. `changes` is what it did beyond the numbered
// remarks; `addressed` is one entry per number it was given, and its absence is what let five
// remarks come back word for word in two consecutive rounds of a live run.
const DRAFT = {
  type: 'object',
  required: ['changes', 'addressed'],
  properties: {
    changes: {
      type: 'array',
      items: { type: 'string' },
      description: 'what you changed beyond the numbered remarks; empty is a fine answer',
    },
    addressed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'status', 'note'],
        properties: {
          item: { type: 'number', description: 'the number of the remark, as it was given' },
          status: { type: 'string', enum: ['fixed', 'declined'] },
          note: {
            type: 'string',
            description: 'what you did, or — for declined — why you deliberately did not',
          },
        },
      },
      description: 'one entry per numbered remark; empty only on the first round, which has none',
    },
  },
}

// The verdict literal is `approved`, quoted from the critics' own instructions rather than chosen
// here. A prompt that says `approved` against a schema that allows only `ok` leaves the agent
// between two descriptions of its own output: at best that costs a retry, at worst the model
// picks `revise` and a round is spent for nothing.
const VERDICT = {
  type: 'object',
  required: ['verdict', 'remarks'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['approved', 'revise'],
      description: 'exactly `approved` or exactly `revise`; no synonyms',
    },
    remarks: { type: 'array', items: { type: 'string' } },
  },
}

// The selector returns which candidate won, by number, and never a path. The script named the
// candidates and knows where they are; what it cannot know is which one is better.
const SELECTION = {
  type: 'object',
  required: ['winner', 'reason'],
  properties: {
    winner: {
      type: 'integer',
      description: 'the number of the winning candidate, as given in the task',
    },
    reason: { type: 'string', description: 'why this one and not the others, in a few sentences' },
    borrow: {
      type: 'array',
      items: { type: 'string' },
      description: 'what the losing candidates did better and the winner should take from them',
    },
  },
}

const PROBE = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'the discovery questions you produced, one per entry',
    },
  },
}

// --- Measurement: python counts, an agent carries, the script decides -------------------------

const LOG_FLAG = `--log ${TOOLS_LOG}`
// The same command means different things at different points, and the log has to say which.
// `output missing` while asking what already exists is the expected answer on a fresh run; the
// same words while checking that an agent left its file behind are a defect. English, because the
// note travels through argv to a python tool via whichever shell the carrying agent picked, and
// Cyrillic through argv on Windows depends on the codepage.
const noted = (purpose) => `${LOG_FLAG} --log-note "${purpose}"`

function gateCommand(path, bounds, purpose) {
  const parts = []
  if (bounds && bounds.min) parts.push(`--min-prose ${bounds.min}`)
  if (bounds && bounds.max) parts.push(`--max-prose ${bounds.max}`)
  for (const file of FORBID_FILES) parts.push(`--forbid-file ${file}`)
  // Every structured document gets this check. A floor on length answers "did the agent write
  // anything" and misses what actually happens: the agent writes the SHAPE of the document —
  // every heading the contract asks for, in order — and fills it pass by pass. Caught live at
  // 1 748 bytes of headings alone, and again at 68 KB with three of six sections still hollow.
  parts.push('--no-empty-sections')
  return `${GATE_TOOL} --file ${path} ${parts.join(' ')} ${noted(purpose)}`.trim()
}

function commands(list) {
  return `COMMANDS\n` + list.map((c, i) => `${i + 1}. ${c}`).join('\n')
}

// A file that exists but holds 200 characters is a file an agent created and abandoned, which is
// why existence is measured rather than tested: `--min-length` turns "is it there" and "is there
// anything in it" into one number the script can branch on.
function existenceCommands(paths, purpose = 'file is where it should be') {
  return commands(
    paths.map((p) => `${GATE_TOOL} --file ${p} --min-length ${MIN_ARTIFACT_CHARS} ${noted(purpose)}`),
  )
}

function record(path, heading, items) {
  touched.add(path)
  return (
    `FILE\n${path}\n\nHEADING\n${heading}\n\nITEMS\n` +
    items.map((r, i) => `${i + 1}. ${r}`).join('\n')
  )
}

async function recordHandoff() {
  const lines = handoff.map((h) => {
    const ins = h.inputs.length ? h.inputs.join(' | ') : '(нет входов)'
    const out = h.output || '(файла нет, только схема)'
    return `${h.label} [${h.agent}, ${h.model}] ВХОД: ${ins} ВЫХОД: ${out}`
  })
  for (const w of warnings) lines.push(`ПРЕДУПРЕЖДЕНИЕ: ${w}`)
  touched.add(HANDOFF_PATH)
  const wrote = await call(record(HANDOFF_PATH, `Передачи между агентами, вызовов: ${lines.length}`, lines), {
    agentType: 'verbatim-writer',
    model: MODELS.record,
    label: 'handoff',
    phase: 'Gate',
    schema: WROTE,
  })
  log(
    wrote && wrote.written
      ? `[handoff] записано передач: ${lines.length} → ${HANDOFF_PATH}`
      : `[handoff] НЕ ЗАПИСАНО — что кому передавалось, останется только в логе прогона`,
  )
}

// What no round managed to close, on disk. A function rather than a block at the end, because
// this pipeline has two exits — a launch that only builds the requirements returns early — and the
// first version wrote the record on one of them. A live run then ended with eight open remarks and
// no file naming them: exactly the silent pass this project treats as its worst failure mode.
//
// Written even when the document was accepted. A critic that says `approved` and attaches remarks
// has accepted the document and left work behind; those remarks are for a person, not for the next
// round, and a report nobody wrote is a report nobody reads.
async function recordUnresolved(items, accepted) {
  if (!items.length) {
    log('[unresolved] незакрытых замечаний нет')
    return
  }
  const wrote = await call(
    record(
      UNRESOLVED_PATH,
      accepted
        ? 'Документ принят, но эти замечания остались незакрытыми'
        : 'Круги правки кончились, эти замечания остались открытыми',
      items,
    ),
    { agentType: 'verbatim-writer', model: MODELS.record, label: 'unresolved', phase: 'Gate', schema: WROTE },
  )
  log(
    wrote && wrote.written
      ? `[unresolved] незакрытых пунктов ${items.length} → ${UNRESOLVED_PATH}`
      : `[unresolved] ФАЙЛ НЕ ЗАПИСАН, а незакрытых пунктов ${items.length}`,
  )
  if (!(wrote && wrote.written)) {
    warnings.push(`незакрытые замечания (${items.length}) не записаны в файл`)
  }
  for (const item of items) log(`[unresolved/пункт] ${item}`)
}

async function auditRun() {
  const audit = await call(
    commands([`${LISTING_TOOL} --dir ${run} --ext "" --recursive ${noted('audit: anything produced and never read')}`]),
    { agentType: 'gate-runner', model: MODELS.gate, label: 'audit', phase: 'Gate', schema: LISTING },
  )
  const onDisk = (audit && audit.files) || []
  if (!onDisk.length) {
    log('[audit] перечислить каталог прогона не удалось — ревизия не проведена')
    warnings.push('ревизия каталога не проведена: перечисление не вернулось')
    return { onDisk, orphans: [] }
  }
  // The carrier checked against itself. Subtraction only means anything on the whole list: paths
  // that did not arrive look exactly like files that were never read.
  const counted = audit && typeof audit.count === 'number' ? audit.count : null
  if (counted !== null && counted !== onDisk.length) {
    log(
      `[audit] инструмент насчитал ${counted} файлов, доехало ${onDisk.length} — ` +
        `ревизия НЕ проведена: на неполном списке вычитание врёт в обе стороны`,
    )
    warnings.push(
      `ревизия не проведена: перечисление насчитало ${counted} файлов, а через агента доехало ${onDisk.length}`,
    )
    return { onDisk, orphans: [] }
  }
  const unread = onDisk.filter((f) => !touched.has(f))
  // Files a stage this launch did not run produced and consumed. A design-only launch never opens
  // the input documents or the extracts, and it is right not to — the requirements document is
  // what it reads. Counting them as losses is how the audit cries wolf: a live design run reported
  // six orphans, every one of them correct and none of them a loss, which is exactly the thing
  // that teaches a reader to skip the audit line.
  //
  // Named by prefix rather than by listing them, because this launch has no reason to know what is
  // in a directory it does not use, and asking would cost an agent call to learn nothing.
  const elsewhere = STAGE_OWNED.filter((p) => !p.mine).map((p) => p.prefix)
  const foreign = unread.filter((f) => elsewhere.some((prefix) => f.startsWith(prefix)))
  const orphans = unread.filter((f) => !foreign.includes(f))
  log(
    `[audit] файлов в каталоге ${onDisk.length}, прочитано агентами ${touched.size}, ` +
      `чужого этапа ${foreign.length}, никем не прочитано ${orphans.length}`,
  )
  for (const f of foreign) log(`[audit/чужой-этап] ${f}`)
  for (const f of orphans) log(`[audit/сирота] ${f}`)
  if (!orphans.length) log('[audit] потерь нет: всё, что произвёл этот запуск, кем-то прочитано')
  return { onDisk, orphans, foreign }
}

// --- Is anybody else working here ------------------------------------------------------------
//
// Asked before anything is spent, and asked of the disk rather than of memory. Two runs pointed
// at one directory is the most expensive mistake this project has made: one rewrote the other's
// analysis while the first's writer was reading it, and which version reached the document can no
// longer be established. A quiet tool log looks exactly like a finished one, so the question has
// to be measured, not judged.
if (!now) {
  warnings.push(
    'не проверено, идёт ли по каталогу другой прогон: args.now не передан — ' +
      'два прогона на одном каталоге делают провенанс документа недоказуемым',
  )
  log('[busy] args.now не передан — занятость каталога НЕ проверялась')
} else {
  phase('Resume')
  const occupied = await call(
    commands([
      `${BUSY_TOOL} --file ${TOOLS_LOG} --now ${now} --idle-seconds ${cfg.idleSeconds || 600} ` +
        `${noted('is another run working here')}`,
    ]),
    { agentType: 'gate-runner', model: MODELS.gate, label: 'busy', phase: 'Resume', schema: BUSY },
  )
  const verdict = occupied && occupied.checks && occupied.checks[0]
  if (!verdict) {
    log('[busy] проверка не вернулась — занятость каталога осталась невыясненной')
    warnings.push('проверка занятости каталога не вернулась: ответ неизвестен')
  } else if (verdict.busy && !cfg.ignoreBusy) {
    throw new Error(
      `по каталогу ${run} похоже идёт другой прогон: ${verdict.problems.join('; ')}. ` +
        `Новый прогон — новый каталог: python -X utf8 tools/newrun.py --base docs-runs --label <о чём>. ` +
        `Если тот прогон точно мёртв — config.ignoreBusy=true.`,
    )
  } else if (verdict.busy) {
    log(`[busy] каталог занят, но config.ignoreBusy — идём дальше: ${verdict.problems.join('; ')}`)
    warnings.push('каталог был занят, прогон начат поверх по config.ignoreBusy')
  } else {
    log('[busy] каталог свободен')
  }
}

// --- Resume: the artifacts on disk are the checkpoint ----------------------------------------
//
// A dynamic workflow lives inside the CLI process, and that process restarts routinely. The cache
// that makes `resumeFromRunId` work does not outlive the session, so the checkpoint is the disk:
// before spending anything, the script asks what is already there.
const present = new Set()
{
  phase('Resume')
  const resumePaths = [REQ_PATH, DESIGN_PATH]
  const onDisk = await call(existenceCommands(resumePaths, 'resume: what is already on disk'), {
    agentType: 'gate-runner',
    model: MODELS.gate,
    label: 'resume',
    phase: 'Resume',
    schema: EXISTENCE,
  })
  const checks = (onDisk && onDisk.checks) || []
  if (checks.length !== resumePaths.length) {
    // One result per command is the contract. A different count means the results cannot be
    // matched to paths at all, and guessing which is which would reuse the wrong file.
    log(
      `[resume] проверок ${checks.length} на ${resumePaths.length} путей — ` +
        `сопоставить нельзя, ничего не переиспользуем`,
    )
  } else {
    resumePaths.forEach((path, i) => {
      if (checks[i].ok) present.add(path)
    })
  }
  log(
    `[resume] найдено готового: требования=${present.has(REQ_PATH)} дизайн=${present.has(DESIGN_PATH)}`,
  )

  // Starting the requirements over on top of somebody's finished run is the one ambiguous act
  // here, and it used to pass silently. Three intents, three different acts, none of them guessed
  // on the caller's behalf: the wrong guess is expensive in one direction and invisible in the
  // other.
  if (RUN_REQUIREMENTS && present.has(REQ_PATH) && !cfg.continue && !cfg.fresh) {
    throw new Error(
      `в каталоге ${run} уже лежит ${REQ_PATH} от прошлого прогона. ` +
        `Новый прогон — новый каталог: python -X utf8 tools/newrun.py --base docs-runs --label <о чём>. ` +
        `Продолжить прерванный — config.continue=true. Пересобрать здесь же с нуля — config.fresh=true.`,
    )
  }
}

// --- The revision loop, as a function --------------------------------------------------------
//
// The whole shape of a revision round, parameterised. In the article pipeline this sits inlined
// once; here it runs twice, on two different documents with two different critics, and writing it
// twice would have meant two copies drifting apart after the first fix.
//
// What varies between the two uses is exactly the argument list: which file, which writer, which
// correctors, which critics, which bounds, which records directory. What does NOT vary is
// everything the loop was expensive to learn:
//
//   the ledger — one numbered list per round, one answer per number, verified against the numbers
//     the script handed over, because a writer with no place to say "I did not do this" silently
//     drops remarks and they come back word for word;
//   the length budget as arithmetic — a round told "you are 616 over" as item sixteen of sixteen
//     answered with nine thousand characters of good material, so the script says how much to
//     remove and forbids adding;
//   declined items travelling to the critics with the reason — a critic that does not know why a
//     remark was declined raises it again and the pair burns a round agreeing to disagree;
//   the stall detector — a round whose item set equals the previous round's will produce it again;
//   the plateau detector — two rounds that fail to beat the best result end the loop, and the best
//     result is recovered from disk so it is a property of the document, not of the launch.
async function reviseLoop({
  loop,
  artifact,
  bounds,
  phaseName,
  writer,
  correctors = [],
  critics,
  maxRounds = MAX_ROUNDS,
}) {
  const roundsDir = roundsDirOf(loop)

  let startRound = 1
  let carried = []
  let declinedNotes = []
  let previousItems = null
  let bestOpen = Infinity
  let bestRound = 0
  let sinceBest = 0
  // Per-critic state, in the order the critics were declared. A round's verdicts are what the
  // next round's item list is built from, so they have to survive a restart — and they do,
  // because each round is written to disk and read back here.
  let verdicts = critics.map((c) => null)
  let gateProblems = []
  let measured = 0

  // The rounds already judged, recovered from disk rather than from the process cache, for the
  // same reason as everything else here: the cache does not outlive the process. Without this,
  // `maxRounds` is a limit per launch instead of per document, and three restarts give nine
  // rounds where the caller allowed three.
  const recorded = await call(
    commands([`${ROUNDS_TOOL} --dir ${roundsDir} --last-only ${noted(`how many ${loop} rounds are already done`)}`]),
    { agentType: 'gate-runner', model: MODELS.gate, label: `${loop}:resume-rounds`, phase: phaseName, schema: ROUNDS },
  )
  if (recorded && recorded.report && !recorded.report.ok) {
    // A record that does not parse is not trusted into the loop: continuing from a guessed round
    // number would skip a revision the caller paid for.
    for (const problem of recorded.report.problems) {
      log(`[${loop}/resume] ЗАПИСЬ КРУГОВ ИСПОРЧЕНА, не доверяем: ${problem}`)
    }
    warnings.push(`записи кругов ${loop} испорчены: ${recorded.report.problems.join('; ')}`)
  } else if (recorded && recorded.rounds && recorded.rounds.length) {
    const last = recorded.rounds[recorded.rounds.length - 1]
    startRound = last.round + 1
    // A critic that numbers its own list is not wrong to; the ledger is what must stay single.
    // A live round recorded `1. 1. …` and from the first item of the second critic the two
    // numbers disagreed — while the writer answers by number.
    verdicts = critics.map((c, i) =>
      i === 0
        ? { verdict: last.verdict, remarks: (last.remarks || []).map(unnumbered) }
        : { verdict: last.style_verdict, remarks: (last.style || []).map(unnumbered) },
    )
    gateProblems = last.gate || []
    carried = [...(last.remarks || []), ...(last.style || [])].map(unnumbered)
    log(
      `[${loop}/resume] кругов пройдено ${recorded.rounds.length}, продолжаем с ${startRound}: ` +
        `вердикты=${verdicts.map((v) => (v && v.verdict) || 'unknown').join('/')}`,
    )

    // Records and snapshots of rounds a previous launch judged: declared as writing, the same
    // exception the audit makes for a draft snapshot. They were written for a person, this launch
    // does not open them, and without the declaration a resumed run reports correct files as
    // losses. An audit that cries wolf is an audit nobody reads.
    for (let n = 1; n < startRound; n++) {
      touched.add(roundPathOf(loop, n))
      touched.add(draftPathOf(loop, n))
    }

    // The plateau counts from the document, not from the launch. Measured live as 16, 12, 16, 12,
    // 16 where the detector should have stopped at the second 12: the first two rounds had been
    // judged in a previous process and their counts never reached the new one.
    for (const c of recorded.counts || []) {
      if (c.items < bestOpen) {
        bestOpen = c.items
        bestRound = c.round
        sinceBest = 0
      } else {
        sinceBest += 1
      }
    }
    if ((recorded.counts || []).length) {
      log(
        `[${loop}/resume] лучший результат ${bestOpen} пунктов на круге ${bestRound}, ` +
          `подряд без улучшения: ${sinceBest}`,
      )
    }
  } else {
    log(`[${loop}/resume] записей о кругах нет, начинаем с первого`)
  }

  // Measure a draft a previous launch left behind. Otherwise the first round of a resumed run
  // builds its revision block with no measurement — the gate of the round before it died with
  // that process — and the length budget goes missing exactly when the run is being continued
  // because the length was wrong.
  if (present.has(artifact) && startRound > 1) {
    const sized = await call(
      commands([gateCommand(artifact, bounds, `resume: size of the ${loop} draft found`)]),
      { agentType: 'gate-runner', model: MODELS.gate, label: `${loop}:resume-size`, phase: phaseName, schema: GATE },
    )
    if (sized && sized.report) {
      measured = (sized.report.measures && sized.report.measures.prose_chars) || 0
      gateProblems = sized.report.problems || []
      log(`[${loop}/resume] черновик на диске: ${measured} знаков прозы, проблем ${gateProblems.length}`)
    }
  }

  if (startRound > maxRounds) {
    log(`[${loop}] круги исчерпаны прошлыми запусками (${startRound - 1} из ${maxRounds})`)
  }
  // A run that comes back onto a plateau should not buy one more round to rediscover it. The
  // detector inside the loop fires only after a round has been paid for; here the same verdict is
  // available before anything is spent, because the counts came off disk.
  const plateauAlready = startRound > 1 && sinceBest >= PLATEAU_ROUNDS
  if (plateauAlready) {
    log(
      `[${loop}] ПОЛКА уже достигнута прошлыми запусками: лучший результат ${bestOpen} пунктов ` +
        `на круге ${bestRound}. Круги не покупаются.`,
    )
  }

  let rounds = startRound - 1
  let accepted = false

  for (let round = plateauAlready ? maxRounds + 1 : startRound; round <= maxRounds; round++) {
    rounds = round
    phase(phaseName)

    // Order of the revision block is the order of authority: the length budget, then what a regex
    // measured, then the critics. A writer that runs out of attention runs out of it on the last
    // section, so what cannot be argued with goes first.
    const overBy = bounds.max && measured ? measured - bounds.max : 0
    const underBy = bounds.min && measured ? bounds.min - measured : 0
    const budget =
      overBy > 0
        ? `LENGTH BUDGET. The draft measures ${measured} characters of readable prose against a ` +
          `ceiling of ${bounds.max}: it is ${overBy} over. This round must END SHORTER than it ` +
          `started — remove at least ${overBy} characters. Every other item below has to be ` +
          `satisfied by cutting, or by replacing text with something no longer. Adding a section ` +
          `is not available this round; if a remark cannot be honoured inside the budget, leave ` +
          `it and say which one.\n\n`
        : underBy > 0
          ? `LENGTH BUDGET. The draft measures ${measured} characters of readable prose against a ` +
            `floor of ${bounds.min}: it is ${underBy} short. Close the gap with substance the ` +
            `sources carry, not by restating what the document already says.\n\n`
          : ''

    const isFirstPass = round === 1 && startRound === 1
    const items = isFirstPass
      ? []
      : [
          ...carried.map((text) => ({ source: 'CARRIED', text })),
          ...gateProblems.map((text) => ({ source: 'GATE', text })),
          ...critics.flatMap((c, i) =>
            ((verdicts[i] && verdicts[i].remarks) || []).map((text) => ({ source: c.tag, text })),
          ),
        ]

    const ledgerRule = items.length
      ? `\n\nHOW TO ANSWER. Return one entry per numbered item above, and account for every ` +
        `number from 1 to ${items.length}. Status \`fixed\` when the draft now satisfies it, ` +
        `\`declined\` when you deliberately did not act — and then the note says why, in one ` +
        `sentence. Do not answer an item you did not act on with \`fixed\`: the next round is ` +
        `given whatever you leave open, and the run reports it.`
      : ''

    const approved = critics.filter((c, i) => verdicts[i] && verdicts[i].verdict === 'approved')
    const approvedBlock = approved.length
      ? `ALREADY APPROVED, and it has to stay approved: ${approved.map((c) => c.tag).join(' and ')}. ` +
        `Whatever you change now must leave it passing — make the smallest edit that answers the ` +
        `items below, and where a fix would disturb an approved axis, prefer the version that ` +
        `does not.\n\n`
      : ''

    const declinedBlock = declinedNotes.length
      ? `\n\nDECLINED LAST ROUND, with the reason given. Do not raise these again unless the ` +
        `reason is wrong; if it is wrong, say why.\n` +
        declinedNotes.map((d, i) => `${i + 1}. ${d}`).join('\n')
      : ''

    const revision = !items.length
      ? null
      : budget +
        approvedBlock +
        `REMARKS ON THE PREVIOUS DRAFT. GATE items are arithmetic and are not open to argument; ` +
        `everything else is a judgement you may decline with a reason.\n\n` +
        items.map((it, i) => `${i + 1}. [${it.source}] ${it.text}`).join('\n') +
        ledgerRule

    // A draft already on disk is a draft nobody has judged yet, and rewriting it from scratch
    // throws away the most expensive agent in the run. So the first round skips the writer and
    // goes straight to the gate and the critics.
    const skipWriter = isFirstPass && present.has(artifact)
    if (skipWriter) {
      log(`[${loop}/1] черновик уже на диске, писатель не запускается — сразу гейт и критики`)
    } else {
      const drafted = must(
        await call(task({ inputs: writer.inputs, output: artifact, extra: revision }), {
          agentType: writer.agentType,
          model: writer.model,
          label: `${loop}:write:${round}`,
          phase: phaseName,
          schema: DRAFT,
        }),
        `${loop}:write:${round} — without a draft the round is empty`,
      )
      log(`[${loop}/${round}] changes=${drafted.changes.length}`)
      for (const c of drafted.changes) log(`[${loop}/${round}/change] ${c}`)

      // The ledger, checked against the numbers the script itself handed over.
      const answered = new Map()
      for (const a of drafted.addressed || []) {
        if (a.item >= 1 && a.item <= items.length) answered.set(a.item, a)
      }
      const declined = []
      const unanswered = []
      for (let n = 1; n <= items.length; n++) {
        const entry = answered.get(n)
        if (!entry) {
          unanswered.push(items[n - 1])
          continue
        }
        log(`[${loop}/${round}/${entry.status}] ${n}. [${items[n - 1].source}] ${entry.note}`)
        if (entry.status === 'declined') declined.push(items[n - 1])
      }
      if (unanswered.length) {
        log(
          `[${loop}/${round}] БЕЗ ОТВЕТА ${unanswered.length} из ${items.length} замечаний — ` +
            `они уходят в следующий круг и в отчёт`,
        )
        for (const it of unanswered) log(`[${loop}/${round}/без-ответа] [${it.source}] ${it.text}`)
      }
      declinedNotes = declined.map((it) => {
        const entry = [...answered.values()].find((a) => items[a.item - 1] === it)
        return `[${it.source}] ${it.text}\n    → отклонено: ${entry ? entry.note : '(без причины)'}`
      })
      carried = [...unanswered, ...declined].map((it) => it.text)
    }

    // Correctors: a chain, not a fan-out. They edit the same file in turn, and turn is what makes
    // it safe — two agents writing one document concurrently already produced a draft whose
    // provenance could not be established. They run before the gate, so the measurement the
    // critics are told about is the measurement of the text that exists.
    if (!skipWriter) {
      for (const corrector of correctors) {
        const fixed = await call(task({ inputs: corrector.inputs, output: artifact }), {
          agentType: corrector.agentType,
          model: corrector.model,
          label: `${loop}:${corrector.tag}:${round}`,
          phase: phaseName,
          schema: corrector.schema || DRAFT,
        })
        log(
          fixed
            ? `[${loop}/${round}/${corrector.tag}] правок: ${(fixed.changes || []).length}`
            : `[${loop}/${round}/${corrector.tag}] НЕ ОТРАБОТАЛ — этот слой проверки пропущен`,
        )
        if (!fixed) warnings.push(`${corrector.tag} не отработал на круге ${round} (${loop})`)
        for (const c of (fixed && fixed.changes) || []) {
          log(`[${loop}/${round}/${corrector.tag}/правка] ${c}`)
        }
      }
    }

    // The gate before the critics, always. What a regex settles must never cost a critic's round,
    // and the critics have to be judging the text that is actually on disk.
    const gated = await call(commands([gateCommand(artifact, bounds, `${loop} round ${round}`)]), {
      agentType: 'gate-runner',
      model: MODELS.gate,
      label: `${loop}:gate:${round}`,
      phase: phaseName,
      schema: GATE,
    })
    const gateReport = (gated && gated.report) || {
      ok: false,
      problems: ['the gate returned nothing — the draft was not measured'],
      measures: {},
    }
    measured = (gateReport.measures && gateReport.measures.prose_chars) || 0
    gateProblems = gateReport.problems || []
    log(
      `[${loop}/${round}/gate] ok=${gateReport.ok} знаков прозы=${measured}` +
        (gateProblems.length ? ` | ${gateProblems.join('; ')}` : ''),
    )

    // Acceptance looks at the file, not at whether an agent came back. A writer that died on the
    // session limit had written the file and not answered: the artifact exists, the result does
    // not.
    const onDisk = await call(existenceCommands([artifact], `${loop}: is the draft on disk`), {
      agentType: 'gate-runner',
      model: MODELS.gate,
      label: `${loop}:exists:${round}`,
      phase: phaseName,
      schema: EXISTENCE,
    })
    const exists = onDisk && onDisk.checks && onDisk.checks[0] && onDisk.checks[0].ok
    if (!exists) {
      log(`[${loop}/${round}] ЧЕРНОВИКА НА ДИСКЕ НЕТ — круг не может быть засчитан`)
      warnings.push(`на круге ${round} (${loop}) черновик не оказался на диске`)
    }

    // The critics in parallel: neither reads the other's output, and a round costs the slower of
    // them instead of their sum.
    const judged = await parallel(
      critics.map((c) => () =>
        call(task({ inputs: c.inputs, noFile: true, extra: declinedBlock || undefined }), {
          agentType: c.agentType,
          model: c.model,
          label: `${loop}:${c.tag}:${round}`,
          phase: phaseName,
          schema: VERDICT,
        }),
      ),
    )
    verdicts = critics.map((c, i) => {
      const v = judged[i] || noVerdict(`${c.tag} (${c.agentType})`)
      v.remarks = (v.remarks || []).map(unnumbered)
      log(`[${loop}/${round}/${c.tag}] verdict=${v.verdict} замечаний=${v.remarks.length}`)
      for (const r of v.remarks) log(`[${loop}/${round}/${c.tag}/замечание] ${r}`)
      return v
    })

    // The round goes on the record before anything decides what to do with it. Written here
    // rather than at the end of the run on purpose: the point is to survive a process that dies
    // mid-loop, and a record written after the loop would die with it.
    //
    // The first critic's remarks go in the plain numbered list and the rest under `Style:`,
    // because that is the shape `rounds.py` reads back. Two buckets, not because these are
    // stylistic, but because the reader of the record needs to know which critic said what.
    const roundItems = [
      ...(verdicts[0] ? verdicts[0].remarks : []),
      ...critics.slice(1).flatMap((c, i) =>
        ((verdicts[i + 1] && verdicts[i + 1].remarks) || []).map((r) => `Style: ${r}`),
      ),
      ...gateProblems.map((p) => `Gate: ${p}`),
      ...carried.map((c) => `Carried: ${c}`),
    ]
    const secondVerdict = critics.length > 1 && verdicts[1] ? verdicts[1].verdict : 'approved'
    const wroteRound = await call(
      record(
        roundPathOf(loop, round),
        `Round ${round} — verdict=${verdicts[0] ? verdicts[0].verdict : 'unknown'} style=${secondVerdict}`,
        roundItems,
      ),
      { agentType: 'verbatim-writer', model: MODELS.record, label: `${loop}:record:${round}`, phase: phaseName, schema: WROTE },
    )
    log(
      wroteRound && wroteRound.written
        ? `[${loop}/${round}] круг записан: ${roundPathOf(loop, round)} пунктов=${roundItems.length}`
        : `[${loop}/${round}] КРУГ НЕ ЗАПИСАН — перезапуск будет судить документ заново`,
    )

    // The draft as it stood when this round judged it. The record keeps what the critics said;
    // this keeps what they said it about. Without it, "what actually changed between round 2 and
    // round 3" — the question worth asking when a loop stops converging — has no answer.
    touched.add(draftPathOf(loop, round))
    const copied = await call(
      commands([`${SNAPSHOT_TOOL} --file ${artifact} --to ${draftPathOf(loop, round)} ${noted(`draft snapshot of ${loop} round ${round}`)}`]),
      { agentType: 'file-copier', model: MODELS.copy, label: `${loop}:snapshot:${round}`, phase: phaseName, schema: GATE },
    )
    if (!(copied && copied.report && copied.report.ok)) {
      log(`[${loop}/${round}] снимок черновика не сделан — сравнить круги потом будет нечем`)
    }

    // Counted before the acceptance check, not after. With the accounting below the break, the
    // accepted round never became the best one, and `best_round` is exactly what a person reads
    // to find the draft snapshot worth keeping.
    if (roundItems.length < bestOpen) {
      bestOpen = roundItems.length
      bestRound = round
      sinceBest = 0
    } else {
      sinceBest += 1
      log(
        `[${loop}/${round}] не лучше достигнутого: ${roundItems.length} пунктов против ` +
          `${bestOpen} на круге ${bestRound} (подряд без улучшения: ${sinceBest})`,
      )
    }

    // All conditions at once. A document every critic likes but that overruns its budget, and one
    // inside its budget that a critic rejects, are equally unfinished.
    const allApproved = verdicts.every((v) => v && v.verdict === 'approved')
    if (allApproved && gateReport.ok && exists) {
      accepted = true
      log(`[${loop}/${round}] ПРИНЯТО: все критики approved, гейт чист, файл на диске`)
      break
    }

    if (sinceBest >= PLATEAU_ROUNDS) {
      log(
        `[${loop}/${round}] ПОЛКА: ${sinceBest} круга подряд не улучшили результат. Петля своё ` +
          `отработала — остальное решает автор, и оно в отчёте.`,
      )
      break
    }

    const signature = JSON.stringify(roundItems.slice().sort())
    if (previousItems === signature) {
      log(
        `[${loop}/${round}] ПЕТЛЯ НЕ ДВИЖЕТСЯ: набор замечаний совпал с предыдущим кругом ` +
          `(${roundItems.length} пунктов). Дальше круги не помогут.`,
      )
      break
    }
    previousItems = signature
  }

  const open = [
    ...(verdicts[0] ? verdicts[0].remarks : []),
    ...critics.slice(1).flatMap((c, i) => (verdicts[i + 1] && verdicts[i + 1].remarks) || []),
    ...gateProblems,
    ...carried,
  ]
  log(
    `[${loop}] кругов сделано ${rounds}, принято=${accepted}, ` +
      `лучший круг ${bestRound} с ${bestOpen === Infinity ? '?' : bestOpen} пунктами, открыто ${open.length}`,
  )
  return { rounds, accepted, open, bestRound, bestOpen: bestOpen === Infinity ? null : bestOpen, measured, verdicts }
}

// --- Extract: the fan-out width comes off the disk -------------------------------------------
//
// The archetype's first real difference from the article pipeline. There, the fan-out width was
// known before anything ran, because the aspects came out of the brief. Here the sources are files
// somebody put in a directory, and the script cannot read a directory — so the first thing that
// happens is a listing, and everything downstream is shaped by its answer.
//
// This is also why the listing carries a count: the width of everything below depends on a list
// that arrives through an agent, and a carrier that silently returns three of five documents would
// cost two extracts nobody notices are missing.
let sources = []
let extractPorts = []
let requirements = null

if (RUN_REQUIREMENTS) {
  phase('Extract')
  const listed = await call(
    commands([`${LISTING_TOOL} --dir ${INPUTS_DIR} --ext "" ${noted('what input documents are there')}`]),
    { agentType: 'gate-runner', model: MODELS.gate, label: 'inputs:list', phase: 'Extract', schema: LISTING },
  )
  sources = (listed && listed.files) || []
  const counted = listed && typeof listed.count === 'number' ? listed.count : null
  if (counted !== null && counted !== sources.length) {
    throw new Error(
      `перечисление входных документов насчитало ${counted}, а через агента доехало ${sources.length}. ` +
        `Строить конвейер на неполном списке нельзя: пропавший документ — это требование, ` +
        `которого не будет в результате, и заметить это потом невозможно.`,
    )
  }
  if (!sources.length) {
    throw new Error(
      `в ${INPUTS_DIR} нет входных документов. Этому конвейеру их не из чего искать — ` +
        `положите заявку, стенограмму, переписку, RFP, и запускайте снова.`,
    )
  }
  log(`[extract] входных документов: ${sources.length}`)
  for (const s of sources) log(`[extract/вход] ${s}`)

  // One agent per document, in parallel, each writing one extract. `pipeline` rather than
  // `parallel` because there is nothing to synchronise: a document that finishes early has no
  // reason to wait for the slowest one.
  const extracted = await pipeline(sources, (source) => {
    const stem = stemOf(source)
    return call(
      task({ inputs: [{ port: 'source', path: source }], output: extractPathOf(stem) }),
      {
        agentType: 'source-processor',
        model: MODELS.extract,
        label: `extract:${stem}`,
        phase: 'Extract',
        schema: EXTRACT,
      },
    ).then((res) => ({ stem, source, res }))
  })

  // Matched by index, never by a path the agent chose how to spell.
  const extractPaths = sources.map((s) => extractPathOf(stemOf(s)))
  const checks = await call(existenceCommands(extractPaths, 'was the extract actually written'), {
    agentType: 'gate-runner',
    model: MODELS.gate,
    label: 'extract:verify',
    phase: 'Extract',
    schema: EXISTENCE,
  })
  const results = (checks && checks.checks) || []
  if (results.length !== extractPaths.length) {
    log(`[extract] проверок ${results.length} на ${extractPaths.length} путей — сопоставить нельзя`)
    warnings.push('извлечения не сверены с диском: число проверок не совпало с числом путей')
    extractPorts = extractPaths.map((p, i) => ({ port: `extract:${stemOf(sources[i])}`, path: p }))
  } else {
    extractPorts = []
    extractPaths.forEach((p, i) => {
      if (results[i].ok) {
        extractPorts.push({ port: `extract:${stemOf(sources[i])}`, path: p })
      } else {
        // A document whose extract never appeared is a document that will not be in the
        // requirements, and that has to be visible while the run is watched rather than
        // discovered in the result. The run continues: one lost extract out of five is worth
        // less than throwing away the four that worked.
        log(`[extract] НЕТ ИЗВЛЕЧЕНИЯ для ${sources[i]}: ${results[i].problems.join('; ')}`)
        warnings.push(`документ ${sources[i]} не дал извлечения — его содержимое в требования не попало`)
      }
    })
  }
  for (const e of extracted) {
    if (!e || !e.res) continue
    log(`[extract/${e.stem}] факты=${(e.res.facts || []).length} вопросы=${(e.res.open_questions || []).length}`)
  }
  log(`[extract] извлечений на диске: ${extractPorts.length} из ${sources.length}`)

  // One extract lost out of five is worth less than throwing away the four that worked. All of
  // them lost is a different thing: the writer would be handed no material at all, and it would
  // either invent a requirements document or die — and in a live run it died three stages later,
  // after the run had already paid for the resume, the listing and two rounds of setup.
  //
  // The likely cause is named because it recurs and looks like nothing else: the registry of agent
  // types is snapshotted once per human turn, so an agent generated in the same turn as the launch
  // is not callable yet, however correct its file is.
  if (!extractPorts.length) {
    const died = extracted.filter((e) => !e || !e.res).length
    throw new Error(
      `ни одного извлечения из ${sources.length} входных документов — писателю требований ` +
        `нечего читать, дальше идти незачем. Агентов не ответило: ${died}. ` +
        `Если агенты собраны в этом же ходе, они станут видны реестру только со следующего ` +
        `сообщения человека: соберите, дождитесь следующего сообщения, запускайте.`,
    )
  }

  // --- Requirements: the first revision loop -------------------------------------------------
  const orderPort = order ? [{ port: 'order', path: `${run}/inputs` }] : []
  requirements = await reviseLoop({
    loop: 'req',
    artifact: REQ_PATH,
    bounds: REQ_BOUNDS,
    phaseName: 'Requirements',
    writer: {
      agentType: 'requirements-writer',
      model: MODELS.reqWrite,
      inputs: [...extractPorts],
    },
    correctors: [
      {
        // Between the writer and the critic, so a figure that drifted from its source is fixed
        // before the critic ever judges the draft. Anything a corrector can settle should never
        // become a remark: a critic can only report it, and reporting costs a round.
        tag: 'factcheck',
        agentType: 'requirements-fact-checker',
        model: MODELS.reqFix,
        inputs: [{ port: 'draft', path: REQ_PATH }, ...extractPorts],
      },
    ],
    critics: [
      {
        tag: 'REQUIREMENTS',
        agentType: 'requirements-critic',
        model: MODELS.reqCritic,
        inputs: [{ port: 'draft', path: REQ_PATH }, ...extractPorts],
      },
    ],
  })

  if (!RUN_DESIGN) {
    // Before the handoff record, so the record carries the warning if the file was not written.
    await recordUnresolved(
      requirements.open.map((o) => `Требования: ${o}`),
      requirements.accepted,
    )
  }
  await recordHandoff()
  const { orphans: reqOrphans, foreign: reqForeign } = await auditRun()
  if (!RUN_DESIGN) {
    log(`[итог/requirements] дальше: тот же каталог с config.stages=["design"]`)
    return {
      stages: STAGES,
      inputs: sources,
      extracts: extractPorts.map((e) => e.path),
      requirements: REQ_PATH,
      rounds: requirements.rounds,
      accepted: requirements.accepted,
      open_items: requirements.open.length,
      unresolved: requirements.open.length ? UNRESOLVED_PATH : null,
      orphans: reqOrphans,
      other_stage: reqForeign,
      warnings,
    }
  }
}

// --- The requirements exist, whoever produced them --------------------------------------------
//
// A launch that runs only the design stage never saw the loop above, so it asks the disk instead
// of assuming. Same rule as everywhere: acceptance looks at the file.
if (!RUN_REQUIREMENTS) {
  const checks = await call(existenceCommands([REQ_PATH], 'design stage: are there requirements'), {
    agentType: 'gate-runner',
    model: MODELS.gate,
    label: 'design:requirements-exist',
    phase: 'Contest',
    schema: EXISTENCE,
  })
  const ok = checks && checks.checks && checks.checks[0] && checks.checks[0].ok
  if (!ok) {
    throw new Error(
      `для этапа design нужен ${REQ_PATH}, а его нет. Сначала config.stages=["requirements"] ` +
        `в этом же каталоге.`,
    )
  }
  touched.add(REQ_PATH)
  log('[design] требования на диске найдены')
}

// --- Contest: two models design the same requirements ----------------------------------------
//
// The archetype's second difference. One design from one model is one reading of the requirements,
// and there is no way to tell a strong reading from a weak one without a second to compare it to.
// So both are produced, a selector picks, and what the losers did better travels to the winner
// rather than being thrown away.
phase('Contest')
const candidates = await parallel(
  CONTEST_MODELS.map((model, i) => () =>
    call(task({ inputs: [{ port: 'requirements', path: REQ_PATH }], output: candidatePathOf(i + 1) }), {
      agentType: 'solution-designer',
      model,
      label: `design:candidate:${i + 1}`,
      phase: 'Contest',
      schema: DRAFT,
    }),
  ),
)
const candidatePaths = CONTEST_MODELS.map((m, i) => candidatePathOf(i + 1))
const candidateChecks = await call(
  existenceCommands(candidatePaths, 'was the candidate design written'),
  { agentType: 'gate-runner', model: MODELS.gate, label: 'design:candidates-verify', phase: 'Contest', schema: EXISTENCE },
)
const candidateResults = (candidateChecks && candidateChecks.checks) || []
const alive = []
if (candidateResults.length !== candidatePaths.length) {
  log(`[contest] проверок ${candidateResults.length} на ${candidatePaths.length} — сопоставить нельзя`)
  warnings.push('кандидаты не сверены с диском: число проверок не совпало с числом путей')
  candidatePaths.forEach((p, i) => alive.push({ n: i + 1, path: p, model: CONTEST_MODELS[i] }))
} else {
  candidatePaths.forEach((p, i) => {
    if (candidateResults[i].ok) {
      alive.push({ n: i + 1, path: p, model: CONTEST_MODELS[i] })
    } else {
      log(`[contest] кандидат ${i + 1} (${CONTEST_MODELS[i]}) не записан: ${candidateResults[i].problems.join('; ')}`)
      warnings.push(`кандидат ${i + 1} от модели ${CONTEST_MODELS[i]} не дошёл до диска`)
    }
  })
}
log(`[contest] кандидатов на диске: ${alive.length} из ${CONTEST_MODELS.length}`)
if (!alive.length) {
  throw new Error('ни один кандидат не записан — выбирать нечего, дизайн этого прогона не состоялся')
}

// --- Choose: by number, never by path --------------------------------------------------------
let winner = alive[0]
let borrow = []
if (alive.length === 1) {
  log(`[choose] кандидат один (${winner.model}) — выбор не нужен`)
} else {
  const choice = await call(
    task({
      inputs: alive.map((c) => ({ port: `candidate:${c.n}`, path: c.path })),
      noFile: true,
      extra:
        `The candidates are numbered as their ports are: ${alive.map((c) => c.n).join(', ')}. ` +
        `Return the number of the one to carry forward.`,
    }),
    {
      agentType: 'solution-design-selector',
      model: MODELS.select,
      label: 'design:select',
      phase: 'Contest',
      schema: SELECTION,
    },
  )
  const picked = choice && alive.find((c) => c.n === choice.winner)
  if (!picked) {
    // The fallback the template asks for. A selector that returns a number nobody offered has not
    // chosen, and taking the first candidate is the honest default — with a warning, because
    // "nobody chose" and "the first one won" must not read the same afterwards.
    log(`[choose] выбор не получен или номер вне списка — берём первого (${winner.model})`)
    warnings.push('победитель не выбран агентом: взят первый кандидат по правилу fallback')
  } else {
    winner = picked
    borrow = choice.borrow || []
    log(`[choose] победил кандидат ${winner.n} (${winner.model}): ${choice.reason}`)
    for (const b of borrow) log(`[choose/взять-у-проигравших] ${b}`)
  }
}

// The winner becomes the design draft, copied by a tool rather than by an agent rewriting it.
// Both paths were named by the script, so this is a copy and not a question; and a rewrite here
// would mean the refinement loop starts from something no critic has seen.
const copiedWinner = await call(
  commands([`${SNAPSHOT_TOOL} --file ${winner.path} --to ${DESIGN_PATH} ${noted('the winning candidate becomes the draft')}`]),
  { agentType: 'file-copier', model: MODELS.copy, label: 'design:promote', phase: 'Contest', schema: GATE },
)
if (!(copiedWinner && copiedWinner.report && copiedWinner.report.ok)) {
  throw new Error(
    `не удалось скопировать победителя ${winner.path} в ${DESIGN_PATH}: ` +
      `${copiedWinner && copiedWinner.report ? copiedWinner.report.problems.join('; ') : 'инструмент не ответил'}`,
  )
}
touched.add(DESIGN_PATH)
present.add(DESIGN_PATH)
log(`[design] черновик дизайна готов из кандидата ${winner.n}`)

// --- Design: the second revision loop, same machinery ----------------------------------------
const borrowBlock = borrow.length
  ? `WHAT THE OTHER CANDIDATES DID BETTER. The selector kept this design and named these as the ` +
    `losing candidates' advantages. Take what applies:\n` +
    borrow.map((b, i) => `${i + 1}. ${b}`).join('\n')
  : ''

const design = await reviseLoop({
  loop: 'design',
  artifact: DESIGN_PATH,
  bounds: DESIGN_BOUNDS,
  phaseName: 'Design',
  writer: {
    agentType: 'solution-designer',
    model: MODELS.design,
    inputs: [
      { port: 'requirements', path: REQ_PATH },
      { port: 'draft', path: DESIGN_PATH },
    ],
  },
  critics: [
    {
      tag: 'DESIGN',
      agentType: 'solution-design-critic',
      model: MODELS.designCritic,
      inputs: [
        { port: 'draft', path: DESIGN_PATH },
        { port: 'requirements', path: REQ_PATH },
      ],
    },
  ],
})

if (borrowBlock) log(`[design] у проигравших взято пунктов: ${borrow.length}`)

// --- Discovery: what the design could not answer ----------------------------------------------
//
// Not a fix for anything — the archetype's own output. A design built from an internal discussion
// always rests on things nobody stated, and the useful form of that is a list of questions to put
// in front of the client rather than an assumption buried in a section. Two agents: one mines the
// requirements for gaps, the second cuts what is generic or already answered.
let discovery = null
if (RUN_DISCOVERY) {
  phase('Discovery')
  const probed = await call(
    task({ inputs: [{ port: 'requirements', path: REQ_PATH }], output: `${run}/probe-questions.md` }),
    { agentType: 'arch-probe', model: MODELS.probe, label: 'discovery:probe', phase: 'Discovery', schema: PROBE },
  )
  if (!probed) {
    log('[discovery] пробник не отработал — вопросов к заказчику не будет')
    warnings.push('стадия discovery не дала вопросов: пробник не отработал')
  } else {
    log(`[discovery] вопросов-кандидатов: ${(probed.questions || []).length}`)
    discovery = await call(
      task({
        inputs: [
          { port: 'draft', path: `${run}/probe-questions.md` },
          { port: 'requirements', path: REQ_PATH },
        ],
        output: DISCOVERY_PATH,
      }),
      { agentType: 'arch-critic', model: MODELS.discovery, label: 'discovery:curate', phase: 'Discovery', schema: PROBE },
    )
    log(
      discovery
        ? `[discovery] вопросов после отбора: ${(discovery.questions || []).length} → ${DISCOVERY_PATH}`
        : `[discovery] отбор не отработал — остались только кандидаты`,
    )
    if (!discovery) warnings.push('вопросы к заказчику не отобраны: курирующий агент не отработал')
  }
}

// --- Gate: the record of what stayed open -----------------------------------------------------
phase('Gate')
const openItems = [
  ...(requirements ? requirements.open.map((o) => `Требования: ${o}`) : []),
  ...design.open.map((o) => `Дизайн: ${o}`),
]
await recordUnresolved(openItems, design.accepted)

await recordHandoff()
const { onDisk, orphans, foreign } = await auditRun()

log(
  `[итог] требований=${Boolean(requirements || present.has(REQ_PATH))} дизайн=${design.accepted ? 'принят' : 'с замечаниями'} ` +
    `кругов дизайна=${design.rounds} открыто=${openItems.length} предупреждений=${warnings.length}`,
)

return {
  stages: STAGES,
  inputs: sources,
  extracts: extractPorts.map((e) => e.path),
  requirements: REQ_PATH,
  requirements_rounds: requirements ? requirements.rounds : null,
  requirements_accepted: requirements ? requirements.accepted : null,
  contest_models: CONTEST_MODELS,
  candidates: candidatePaths,
  winner: { candidate: winner.n, model: winner.model },
  design: DESIGN_PATH,
  design_rounds: design.rounds,
  design_accepted: design.accepted,
  design_best_round: design.bestRound,
  design_prose_chars: design.measured,
  discovery: discovery ? DISCOVERY_PATH : null,
  unresolved: openItems.length ? UNRESOLVED_PATH : null,
  open_items: openItems.length,
  files_on_disk: onDisk.length,
  files_read_by_agents: touched.size,
  orphans,
  other_stage: foreign,
  warnings,
}
