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
// No prompt remains. Every call site is a library agent that already knows its job, and what
// leaves this file is only what the script alone knows: paths, commands, items, round numbers.
// The brief node was the last holdout — justified as "a builtin, engine code rather than an
// agent", which was true in refract and stopped being true here, where nothing executes
// anything.
//
// The round is a chain and then a fan-out: writer, then two correctors that fix what is
// decidable (the example's arithmetic, the claims against the notes), then the gate, then two
// critics in parallel on what is left. That shape was arrived at expensively. With the writer
// and two general critics alone, a live run spent six rounds and five million tokens, and the
// same five remarks came back word for word: a critic can only report a misattribution, and
// reporting it costs a round to fix. Anything a corrector can settle should never become a
// remark at all.
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
    { title: 'Write', detail: 'writer, two correctors, then two critics in parallel' },
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
// The clock, for the one question that needs one: is another run working in this directory.
// The script has no `Date.now()` — the runtime removes it, or resuming would break — so the
// time arrives from outside, the same way the run directory does. Optional: without it the
// check is skipped and said to be skipped, because "nobody looked" and "looked, all clear"
// must not read the same.
const now = (args && args.now) || ''

// Every path is named here, by the script, and nowhere else. Agents receive paths and never
// report them back: a `path` field in a schema turns "say where it is" into a substitute for
// "put it there".
const BRIEF_PATH = `${run}/brief.md`
const MATERIAL_PATH = `${run}/material.md`
const ARTICLE_PATH = `${run}/article.md`
const UNRESOLVED_PATH = `${run}/UNRESOLVED.md`
// One directory per researcher, not one shared pile. Two finders working different aspects of
// the same subject reach the same paper often, and in a shared directory they named it twice:
// `annotated-transformer-maskirovanie-kod.md` and `annotated-transformer-scaling-masking-code.md`
// are one source saved by two agents. A directory each makes a collision impossible, makes it
// obvious which aspect produced what, and lets the script enumerate per aspect rather than
// sorting one heap by guesswork.
const sourceDirOf = (slug) => `${run}/sources/${slug}`
const sourcePathOf = (slug) => `${sourceDirOf(slug)}/${slug}.md`
// One file per revision round. The article survives a restart because an agent wrote it; the
// verdicts on it did not, because they lived only in what an agent returned. So each round is
// recorded, and a run that comes back does not pay two opus critics to re-judge a draft they
// already judged — and MAX_ROUNDS becomes a property of the article rather than of the launch.
const ROUNDS_DIR = `${run}/rounds`
const roundPathOf = (n) => `${ROUNDS_DIR}/round-${n}.md`
// The draft as it stood when that round judged it. The record keeps what the critics said; this
// keeps what they said it about. Without it, "what actually changed between round 8 and round 9"
// — the question worth asking when a loop stops converging — has no answer at all.
const draftPathOf = (n) => `${ROUNDS_DIR}/draft-${n}.md`
// One line per deterministic check, written by the tool that ran it. Everything a tool measures
// otherwise lives only in `log()` — readable while the run is watched, gone once it is over.
// Reconstructing a finished run meant opening per-agent transcripts and matching them by hand,
// and the one time it mattered the evidence survived only because the tool could be re-run.
const TOOLS_LOG = `${run}/tools.jsonl`
// Who was handed what, per call. Composed by the script, written by an agent, read by a person.
const HANDOFF_PATH = `${run}/handoff.md`

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

// --- Segments: which part of the pipeline this launch runs -----------------------------------
//
// A workflow lives inside the CLI process, and the process does not survive a restart, a session
// moved to a background job, or a quota wall. A run that does everything therefore risks
// everything: forty minutes of research died once because the process that held them went away
// mid-draft.
//
// So a launch is a segment. `research` ends with material on disk; `draft` ends with an article
// and the round records. Each is small enough to lose cheaply, and the boundary between them is
// where a person would look anyway. Figures are already their own workflow.
//
// One file rather than two, deliberately. The two segments share the configuration block, the
// I/O tail, the schemas and the gate commands — about a hundred and twenty lines. Split across
// files with no `import()` available, those hundred and twenty lines become two copies that
// drift, which is the failure this project keeps paying for. The stage list selects; nothing is
// duplicated.
const ALL_STAGES = ['research', 'draft']
const STAGES = (cfg.stages && cfg.stages.length ? cfg.stages : ALL_STAGES).map((s) =>
  String(s).toLowerCase(),
)
const unknownStages = STAGES.filter((s) => !ALL_STAGES.includes(s))
if (unknownStages.length) {
  throw new Error(`неизвестные этапы: ${unknownStages.join(', ')}; есть только ${ALL_STAGES.join(', ')}`)
}
const RUN_RESEARCH = STAGES.includes('research')
const RUN_DRAFT = STAGES.includes('draft')

const MAX_ROUNDS = cfg.maxRounds || 2
// How many rounds may fail to beat the best result before the loop admits it has finished.
// Two, because one bad round is noise and two in a row is a plateau.
const PLATEAU_ROUNDS = cfg.plateauRounds || 2
// Six, not four. Four was a number I picked and never justified, and on a large subject it is
// thin: an aspect is a whole researcher, and a technical design has more than four areas worth
// a researcher each. The platform runs sixteen agents at once, so the ceiling is not the
// machinery — it is whether the aspects are genuinely different questions. Two that are one
// question reworded send two agents at the same pages.
const MAX_ASPECTS = cfg.maxAspects || 6

// A file that exists and holds 200 characters is a file an agent created and walked away
// from. Existence is therefore measured, not tested.
const MIN_ARTIFACT_CHARS = cfg.minArtifactChars || 200

// --- Language policy: the two things that DO change with the language -----------------------
//
// The shape of this pipeline does not depend on what language the article is in. Two things
// do: the style critic, which hunts the machine tells of a particular language, and the gate
// presets, which hunt its dead phrases. Both were hardcoded to Russian, which is invisible
// until someone orders an English article and gets a critic looking for «стоит отметить» and
// «ёлочки» in it — reporting nothing, approving everything, and costing a stage.
//
// So the language chooses them, and the language comes from the brief, which got it from the
// order. A language with no entry here gets `no_bold` (formatting, not vocabulary) and NO style
// critic — and the absence is recorded as an open item rather than passed off as approval,
// because "nobody checked" and "checked and fine" are the same thing only to a report nobody
// reads.
//
// `cfg.gatePresets` and `cfg.styleCritic` still win when given: a caller who knows better than
// the table says so directly.
const RU = {
  styleCritic: 'style-critic-ru',
  forbid: ['library/style/forbid/ru-slop.txt', 'library/style/forbid/no-bold.txt'],
}
const LANGUAGE_POLICY = Object.assign(
  { russian: RU, 'русский': RU },
  cfg.languagePolicy || {},
)
// A language with no entry gets the formatting rule and no vocabulary: bold is bold in any
// language, dead phrases are not.
const DEFAULT_POLICY = { styleCritic: null, forbid: ['library/style/forbid/no-bold.txt'] }

// Assigned once the brief has been read. Until then nothing measures and nothing judges.
let FORBID_FILES = []
let STYLE_CRITIC = null

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
    copy: 'haiku',
    // Arithmetic it runs rather than judges, so the shell matters more than the model.
    verify: 'sonnet',
    // Attribution against notes is reading comprehension under pressure to leave things
    // alone, which is exactly where a weaker model invents corrections.
    factcheck: 'opus',
  },
  cfg.models || {},
)

// The gate is this repository's own script, so the invocation is a default rather than a
// constant: a pipeline vendored elsewhere keeps the stage and changes the path.
const GATE_TOOL = cfg.gateTool || 'python -X utf8 tools/gate.py'
const ROUNDS_TOOL = cfg.roundsTool || 'python -X utf8 tools/rounds.py'
const LISTING_TOOL = cfg.listingTool || 'python -X utf8 tools/listing.py'
const SNAPSHOT_TOOL = cfg.snapshotTool || 'python -X utf8 tools/snapshot.py'
const BUSY_TOOL = cfg.busyTool || 'python -X utf8 tools/busy.py'

// The two correctors between the writer and the critics. On by default and switchable off,
// because a pipeline whose documents carry no arithmetic and no citations pays for them for
// nothing. What they buy is rounds: six rounds of a live run spent their remarks on exactly two
// things — an example whose numbers drifted, and attributions that did not match the notes — and
// a critic can only report those, while a corrector fixes them inside the round they appeared
// in. A remark that costs a round to fix is a remark that should not have been a remark.
const USE_CORRECTORS = cfg.correctors !== false

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

// Every path that ever reaches an agent, recorded as it goes. Not bookkeeping anyone has to
// remember: a path becomes "consumed" by the only act that can consume it — appearing in a task —
// so there is no way to hand a file to an agent without this seeing it.
//
// The audit at the end of the run subtracts this set from what is actually on disk. Every loss
// this pipeline has had was the same shape: a file produced and never read. Twenty-five source
// notes, a dead finder's directory, an agent's scratch json. None of them looked like failures;
// all of them are a difference between these two sets.
const touched = new Set()
// Every call, with what it was handed and what it was asked to leave. Not a logging agent: an
// agent is the least reliable component in this pipeline — one truncated a tool's output from
// five rounds to two and cost 1.4 million tokens, another returned absolute paths where the
// script had passed relative ones — and putting the audit trail through it would be trusting the
// record to the thing the record exists to check. The script already knows all of this; nothing
// needs to be asked.
//
// `lastPorts` works because JavaScript evaluates arguments left to right: `call(task({...}), …)`
// runs `task` first, so the ports it just formatted are still the ones this call is about.
const handoff = []
let lastPorts = null

// Things that did not stop the run but change how its result must be read: an aspect nobody
// found sources for, a listing that could not be matched. `log()` alone is not enough for these
// — it lives in the run transcript, and the run transcript is exactly what is gone by the time
// someone asks why one section of the article is thinner than the rest. They go on disk with
// the handoff record.
const warnings = []
const emptyAspects = []

// A remark as the ledger wants it: without the number the critic put in front of it. The ledger
// is one list per round precisely because three lists each numbered from one make a number
// meaningless — and a critic numbering its own items rebuilds that by hand. Only a leading
// ordinal goes; a remark that opens with a year or a measurement keeps it.
const unnumbered = (text) => String(text).replace(/^\s*\d{1,2}[.)]\s+/, '')

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
// Declared from the start: the tool log is a record for a person, so no agent will ever open it
// and the audit would otherwise report it as a loss on every single run.
touched.add(`${run}/tools.jsonl`)

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
  required: ['language', 'aspects', 'order_matches_existing_brief'],
  properties: {
    language: { type: 'string', description: 'language of the article, one word' },
    // The one thing only this agent can answer: it is the only stage that sees both the order
    // and the brief a previous run wrote from a different one. `continue` without this check is
    // a loophole — a new job wearing an old directory, inheriting research done for something
    // else, and the comparison against the old run measuring nothing.
    order_matches_existing_brief: {
      type: 'boolean',
      description:
        'true if no brief existed, or the existing one already describes THIS order; ' +
        'false if the order asks for a different subject, language or length',
    },
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

// The writer's ledger. `changes` alone let a remark disappear: five of them came back word for
// word in two consecutive rounds of a live run because the schema asked what was done and never
// what was left. `addressed` is the field that cannot be filled without going through the list,
// and the script checks the numbers against the ones it sent — a claim the caller can verify is
// worth more than an instruction the caller can only hope was followed.
const ARTICLE = {
  type: 'object',
  required: ['changes', 'addressed'],
  properties: {
    // No counts from the writer: measuring characters is the gate's job, not a model's.
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

// Both correctors hand back the article and account for what they touched. The quotation is the
// load-bearing field in each: `ran` cannot be produced without executing the computation, and
// `note_says` cannot be produced without opening the note. Without them a corrector returns
// confident corrections that are wrong in a new way, and nothing downstream can tell.
const VERIFIED = {
  type: 'object',
  required: ['ran', 'corrections'],
  properties: {
    ran: {
      type: 'string',
      description: 'the exact command you ran to recompute the example, as you ran it',
    },
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['where', 'was', 'now'],
        properties: {
          where: { type: 'string', description: 'which value, in the article own words' },
          was: { type: 'string', description: 'what the article said' },
          now: { type: 'string', description: 'what your run produced' },
        },
      },
    },
  },
}

const CHECKED = {
  type: 'object',
  required: ['corrections'],
  properties: {
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'note_says', 'action'],
        properties: {
          claim: { type: 'string', description: 'the claim as the article made it, verbatim' },
          note_says: { type: 'string', description: 'what the note actually says, verbatim' },
          action: {
            type: 'string',
            enum: ['corrected', 'weakened', 'removed', 'marked_as_own'],
          },
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

// What rounds.py prints. The envelope matches the gate's so the carrying agent sees a shape it
// already knows; `rounds` is the part the loop actually continues from.
const ROUNDS = {
  type: 'object',
  required: ['report', 'rounds', 'counts'],
  properties: {
    // Asked for by name rather than left inside the free-form `measures`, because a free-form
    // object is precisely what a summarising carrier trims. One number per round, for every
    // round: the plateau detector needs the whole history, and `rounds` deliberately carries
    // only the newest one.
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

// No `path` field, and that omission is the whole point. It used to be here and it cost a
// round: the checks came back as absolute Windows paths with backslashes while the script
// compared against the relative POSIX form it had passed in, nothing matched, and four
// finders plus the analyst re-ran on material that was already on disk. The previous run of
// the same code returned relative paths and worked — which is worse than failing, because a
// bug that only sometimes fires waits for the expensive run.
//
// The script named the paths and passed them in order; gate_runner returns one result per
// command in that same order, so the index is the identity. Asking an agent to hand a path
// back is asking it to re-derive something already known, and the project invariant says not
// to: a `path` field in a schema turns "say where it is" into a substitute for "put it there".
// What listing.py prints. The script names every path it writes; this reports the paths it
// could not have named — the per-source files the finder keeps on its own judgement.
// One listing per command, in the order the commands were given. Matched by index, like every
// other result that comes back from the carrying agent.
// `count` is the tool's own `measures.files`, and it is required so the carrier can be checked
// against itself. A live audit had the tool print 37 paths and the agent return one — the run
// directory — and the script dutifully reported 36 files as read and the directory as an orphan.
// A carrier that drops the list also drops the count, and then the two disagree and say so;
// carrying a number is the one thing a summarising agent does not shorten.
const LISTING = {
  type: 'object',
  required: ['files', 'count'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    count: { type: 'integer', description: 'the files number from the report measures, verbatim' },
  },
}

const LISTINGS = {
  type: 'object',
  required: ['listings'],
  properties: {
    listings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ok', 'files'],
        properties: {
          ok: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
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

// The occupancy answer. `busy` is its own field rather than a reading of `ok`, because the two
// differ: a log with one unreadable timestamp is not ok and says nothing about who is working.
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

// --- Measurement: python counts, an agent carries, the script decides -------------------------
//
// The script has no shell, so it cannot run the gate itself; the agent exists only to carry the
// command and bring the JSON back. Python does the counting because a model cannot: asked to
// judge length by eye, two critics said 10 500-11 500 where the answer was 10 033.

// The bounds are optional on purpose: a run whose order said nothing about length gets a
// measurement and no verdict. gate.py with no rule still reports chars and prose_chars.
// The forbidden patterns arrive as file paths, and the paths are ASCII: Cyrillic through argv
// on Windows depends on the codepage and on which shell the carrying agent picked. The patterns
// themselves are UTF-8 inside the file, read by python, and they are data a person edits —
// editorial policy for one language, not a constant inside a parser.
//
// They live here rather than in a critic's remarks because a regex settles them, and a rule a
// regex can settle should never cost a revision round. The style critic then spends its rounds
// on rhythm and voice, which no regex reaches.
// `--log` on every command, always the same file. The tool writes its own receipt: the carrying
// agent is forbidden to create files, and that rule has paid for itself twice — this is the
// measurement leaving a record, written by whoever did the measuring.
const LOG_FLAG = `--log ${TOOLS_LOG}`
// The same command means different things at different points, and the log has to say which.
// `output missing` while asking what already exists is the expected answer on a fresh run;
// the same words while checking that an agent left its file behind are a defect. Without the
// note, a clean run opens with eight lines that read as failures.
const noted = (purpose) => `${LOG_FLAG} --log-note "${purpose}"`

function gateCommand(path, min, max, purpose = 'article gate') {
  const bounds = []
  if (min) bounds.push(`--min-prose ${min}`)
  if (max) bounds.push(`--max-prose ${max}`)
  for (const file of FORBID_FILES) bounds.push(`--forbid-file ${file}`)
  return `${GATE_TOOL} --file ${path} ${bounds.join(' ')} ${noted(purpose)}`.trim()
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
function existenceCommands(paths, purpose = 'file is where it should be') {
  return commands(
    paths.map((p) => `${GATE_TOOL} --file ${p} --min-length ${MIN_ARTIFACT_CHARS} ${noted(purpose)}`),
  )
}

// Same for verbatim_writer: a destination, a heading, and the items. Everything about not
// rephrasing them and not touching the article lives in its prompt.
// The audit, as a function because both segments end and both have to answer the same question.
// The research segment is where orphans were actually born — twenty-five source notes and a dead
// finder's directory — so ending it without the check would leave the loss to be discovered a
// segment later, or not at all.
// The handoff record: every call, in order, with what it was handed and what it left. Written
// once per segment rather than once per action, because the content is composed by the script
// from what it already knows — an agent adds a transcription step and a chance to get it wrong.
//
// This is the answer to "did everything get passed correctly and did nothing change": the
// record says what was passed, `tools.jsonl` says what each measurement found, and the audit
// says whether anything on disk went unread. Three independent records, none of them a model's
// recollection of events.
async function recordHandoff() {
  const lines = handoff.map((h) => {
    const ins = h.inputs.length ? h.inputs.join(' | ') : '(нет входов)'
    const out = h.output || '(файла нет, только схема)'
    return `${h.label} [${h.agent}, ${h.model}] ВХОД: ${ins} ВЫХОД: ${out}`
  })
  for (const w of warnings) lines.push(`ПРЕДУПРЕЖДЕНИЕ: ${w}`)
  touched.add(HANDOFF_PATH)
  const wrote = await call(
    record(HANDOFF_PATH, `Передачи между агентами, вызовов: ${lines.length}`, lines),
    { agentType: 'verbatim-writer', model: MODELS.record, label: 'handoff', phase: 'Gate', schema: WROTE },
  )
  log(
    wrote && wrote.written
      ? `[handoff] записано передач: ${lines.length} → ${HANDOFF_PATH}`
      : `[handoff] НЕ ЗАПИСАНО — что кому передавалось, останется только в логе прогона`,
  )
}

async function auditRun() {
  const audit = await call(commands([`${LISTING_TOOL} --dir ${run} --ext "" --recursive ${noted('audit: anything produced and never read')}`]), {
    agentType: 'gate-runner',
    model: MODELS.gate,
    label: 'audit',
    phase: 'Gate',
    schema: LISTING,
  })
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
      `ревизия не проведена: перечисление насчитало ${counted} файлов, ` +
        `а через агента доехало ${onDisk.length}`,
    )
    return { onDisk, orphans: [] }
  }
  const orphans = onDisk.filter((f) => !touched.has(f))
  log(
    `[audit] файлов в каталоге ${onDisk.length}, прочитано агентами ${touched.size}, ` +
      `никем не прочитано ${orphans.length}`,
  )
  for (const f of orphans) log(`[audit/сирота] ${f}`)
  if (!orphans.length) log('[audit] потерь нет: всё, что произведено, кем-то прочитано')
  return { onDisk, orphans }
}

function record(path, heading, items) {
  touched.add(path)
  return (
    `FILE\n${path}\n\nHEADING\n${heading}\n\nITEMS\n` +
    items.map((r, i) => `${i + 1}. ${r}`).join('\n')
  )
}

// --- Brief -------------------------------------------------------------------------------

log(`[start] dir=${run} этапы=${STAGES.join(' + ')}`)
log(`[start] order: ${order.replace(/\s+/g, ' ').slice(0, 200)}`)

phase('Brief')
const brief = must(
  await call(
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
// A continuation is a continuation of the same job. When the order changed, the directory holds
// research done for a different question, and carrying on inside it produces an article built
// half from one brief and half from another — with nothing in the result to say so.
// `fresh` rebuilds the directory from nothing, so whatever brief used to be there is not being
// continued — it is being replaced, deliberately, and there is nothing to mismatch.
if (brief.order_matches_existing_brief === false && !cfg.fresh) {
  throw new Error(
    `заказ не совпадает с брифом, который уже лежит в ${run}. Это другая работа, а не ` +
      `продолжение: возьмите новый каталог (tools/newrun.py) или пересоберите этот с нуля ` +
      `через config.fresh=true.`,
  )
}
const minProse = brief.min_prose
const maxProse = brief.max_prose
const hasBounds = Boolean(minProse || maxProse)
log(
  `[brief] file=${BRIEF_PATH} language=${brief.language} ` +
    `length=${hasBounds ? `${minProse || '?'}–${maxProse || '?'}` : 'not set by the order, the gate passes no verdict on it'} ` +
    `aspects=${brief.aspects.length}`,
)
for (const a of brief.aspects) log(`[brief/aspect] ${a.slug}: ${a.question}`)

const policy = LANGUAGE_POLICY[String(brief.language || '').toLowerCase()] || DEFAULT_POLICY
FORBID_FILES = cfg.forbidFiles || policy.forbid || []
STYLE_CRITIC = cfg.styleCritic === undefined ? policy.styleCritic : cfg.styleCritic
log(
  `[brief/policy] язык=${brief.language} запреты=${FORBID_FILES.join(', ') || 'нет'} ` +
    `стилевой_критик=${STYLE_CRITIC || 'НЕТ ДЛЯ ЭТОГО ЯЗЫКА'}`,
)
if (!STYLE_CRITIC) {
  log(
    `[brief/policy] стиль судить некому: для языка «${brief.language}» критик не назван. ` +
      `Это попадёт в незакрытые пункты, а не будет принято молча.`,
  )
}

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
// Seeded by the Resume phase below when a previous launch got further than this one.
let startRound = 1
let priorRounds = []
let verdict = null
let styleVerdict = null
let gateProblems = []
let styleRemarks = []
// The measurement, kept past the iteration that took it: the next round is told its budget in
// characters, and only the gate knows how many there are.
let measuredProse = null
// Remarks the writer left unanswered or declined. They travel to the next round because this
// round's critics judge the NEW draft and will not repeat a remark they consider settled —
// while an item nobody answered is settled by nobody.
let carried = []
// What the writer declined, with its reason, in the words it used. The critics get this: a
// critic that never learns why a remark was declined raises it again next round, the writer
// declines it again, and the pair burns a round agreeing to disagree. Three rounds of a live
// run went exactly that way before the ledger existed to show it.
let declinedNotes = []
// The item texts of the previous round. When a round produces the same set, another round will
// produce it too — the loop has stopped moving and the budget should not be spent proving it.
let previousItems = null
// The fewest open items any round has managed, and how many rounds have failed to beat it.
//
// This exists because the obvious acceptance condition turned out to be unreachable. Requiring
// both critics to find nothing in the SAME round, on a text of forty thousand characters, asks
// two independent judges to fall silent simultaneously — and over eleven rounds of a live run
// they never did. They alternated: substance ok / style revise, then the reverse, round after
// round, while the total item count sat on a floor of eight to ten. Telling the writer which
// axis was already approved did not stop it, because the problem was never the writer.
//
// So the loop also stops when it stops improving. What remains is recorded in UNRESOLVED.md and
// handed to a person, which was always the designed outcome for remarks a round cannot close.
let bestOpen = Infinity
let bestRound = 0
let sinceBest = 0

// --- Is anybody else working here ------------------------------------------------------------
//
// Asked before anything is spent, and asked of the disk rather than of memory. Two runs pointed
// at one directory is the most expensive mistake this pipeline has made: one rewrote the other's
// analysis while the first's writer was reading it, and which version reached the article can no
// longer be established. The rake was already written down, and writing it down did not help —
// "is a run going" was not observable, and a quiet tool log looks exactly like a finished one.
// Source finders are quiet for minutes at a time and call no tools at all.
//
// The tool answers it from the log's own timestamps. Skipping is allowed and is never silent:
// a run launched without a clock says so and carries it into the record.
if (!now) {
  warnings.push(
    'не проверено, идёт ли по каталогу другой прогон: args.now не передан — ' +
      'два прогона на одном каталоге делают провенанс черновика недоказуемым',
  )
  log('[busy] args.now не передан — занятость каталога НЕ проверялась')
} else {
  phase('Resume')
  const occupied = await call(
    commands([
      `${BUSY_TOOL} --file ${TOOLS_LOG} --now ${now}` +
        ` --idle-seconds ${cfg.idleSeconds || 600} ${noted('is another run working here')}`,
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
    warnings.push(`каталог был занят, прогон начат поверх по config.ignoreBusy`)
  } else {
    log('[busy] каталог свободен')
  }
}

if (cfg.fresh) {
  log('[resume] config.fresh — всё пересобирается с нуля, ничего не переиспользуется')
} else {
  phase('Resume')
  const resumePaths = [...sourcePaths, MATERIAL_PATH, ARTICLE_PATH]
  const onDisk = await call(existenceCommands(resumePaths, 'resume: what is already on disk'), {
    agentType: 'gate-runner',
    model: MODELS.gate,
    label: 'resume',
    phase: 'Resume',
    schema: EXISTENCE,
  })
  const resumeChecks = (onDisk && onDisk.checks) || []
  if (resumeChecks.length !== resumePaths.length) {
    // One result per command is the contract. A different count means the results cannot be
    // matched to paths at all, and guessing which is which would reuse the wrong file.
    log(
      `[resume] проверок ${resumeChecks.length} на ${resumePaths.length} путей — ` +
        `сопоставить нельзя, ничего не переиспользуем`,
    )
  } else {
    resumePaths.forEach((path, i) => {
      if (resumeChecks[i].ok) present.add(path)
    })
  }
  log(
    `[resume] найдено готового: источников ${sourcePaths.filter((p) => present.has(p)).length}` +
      `/${sourcePaths.length}, материал=${present.has(MATERIAL_PATH)} ` +
      `черновик=${present.has(ARTICLE_PATH)}`,
  )

  // Starting research over somebody's finished run is the one ambiguous act here, and it used to
  // pass silently: seven launches of one article went into the same directory, each inheriting
  // the last one's material and draft, and the comparison between them measured nothing. Two
  // launches pointed at it at once did worse — one overwrote the other's article mid-round.
  //
  // The two intents are different acts and now look different. Starting fresh means a directory
  // of its own, minted by `tools/newrun.py`. Continuing an interrupted run means saying so.
  // Nothing is guessed on the caller's behalf, because the wrong guess is expensive in one
  // direction and invisible in the other.
  const hasPreviousOutput = present.has(MATERIAL_PATH) || present.has(ARTICLE_PATH)
  if (RUN_RESEARCH && hasPreviousOutput && !cfg.continue) {
    throw new Error(
      `в каталоге ${run} уже лежит результат прошлого прогона. ` +
        `Новый прогон — новый каталог: python -X utf8 tools/newrun.py --base docs-runs --label <о чём>. ` +
        `Продолжить прерванный — config.continue=true. Пересобрать здесь же с нуля — config.fresh=true.`,
    )
  }

  // The rounds already judged. Recovered from disk rather than from the process cache, for the
  // same reason as everything else here: the cache does not outlive the process.
  const recorded = await call(commands([`${ROUNDS_TOOL} --dir ${ROUNDS_DIR} --last-only ${noted('how many rounds are already done')}`]), {
    agentType: 'gate-runner',
    model: MODELS.gate,
    label: 'resume:rounds',
    phase: 'Resume',
    schema: ROUNDS,
  })
  // A record that does not parse is not trusted into the loop: continuing from a guessed round
  // number would skip a revision the brief paid for. Broken records are announced and ignored.
  if (recorded && recorded.report && !recorded.report.ok) {
    for (const problem of recorded.report.problems) {
      log(`[resume/rounds] ЗАПИСЬ КРУГОВ ИСПОРЧЕНА, не доверяем: ${problem}`)
    }
  } else if (recorded && recorded.rounds.length) {
    priorRounds = recorded.rounds
    const last = priorRounds[priorRounds.length - 1]
    startRound = last.round + 1
    // Same normalisation on the way back off disk: a record written before this rule existed
    // still carries the critic's own numbers, and a resumed round would renumber them again.
    verdict = { verdict: last.verdict, remarks: last.remarks.map(unnumbered) }
    styleVerdict = { verdict: last.style_verdict }
    styleRemarks = last.style
    gateProblems = last.gate
    log(
      `[resume/rounds] кругов уже пройдено ${priorRounds.length}, продолжаем с ${startRound}: ` +
        `вердикт=${last.verdict} стиль=${last.style_verdict} ` +
        `замечаний=${last.remarks.length}+${last.style.length} гейт=${last.gate.length}`,
    )

    // The records and snapshots of rounds a previous launch judged. Declared as writing, the
    // same one exception the audit already makes for a draft snapshot: they were written for a
    // person to read, and this launch does not open them. Without the declaration a resumed run
    // reports four perfectly correct files as losses, and an audit that cries wolf is an audit
    // nobody reads.
    for (let n = 1; n < startRound; n++) {
      touched.add(roundPathOf(n))
      touched.add(draftPathOf(n))
    }

    // The plateau detector counts from the article, not from the launch. Without this a resumed
    // run calls the first round it happens to see the best one and pays for two more to learn
    // otherwise: measured live as 16, 12, 16, 12, 16, where the detector should have stopped at
    // the second 12. Counts rather than texts — one number per round, the same discipline that
    // keeps the record itself from truncating in the carrier.
    const counts = recorded.counts || []
    for (const c of counts) {
      if (c.items < bestOpen) {
        bestOpen = c.items
        bestRound = c.round
        sinceBest = 0
      } else {
        sinceBest += 1
      }
    }
    if (counts.length) {
      log(
        `[resume/rounds] лучший результат ${bestOpen} пунктов на круге ${bestRound}, ` +
          `подряд без улучшения: ${sinceBest}`,
      )
    } else {
      log('[resume/rounds] счёта прошлых кругов нет — полка считается заново с этого запуска')
    }
  } else {
    log('[resume/rounds] записей о кругах нет, начинаем с первого')
  }

  // Measure the draft here as well when a previous launch left one. Otherwise the first round
  // of a resumed run builds its revision block with no measurement — the gate of the round
  // before it died with that process — and the length budget silently goes missing exactly
  // when the run is being continued because the length was wrong.
  if (present.has(ARTICLE_PATH) && startRound > 1) {
    const sizedNow = await call(commands([gateCommand(ARTICLE_PATH, minProse, maxProse, 'resume: size of the draft found')]), {
      agentType: 'gate-runner',
      model: MODELS.gate,
      label: 'resume:size',
      phase: 'Resume',
      schema: GATE,
    })
    if (sizedNow && sizedNow.report) {
      gateProblems = sizedNow.report.problems
      measuredProse =
        typeof sizedNow.report.measures.prose_chars === 'number'
          ? sizedNow.report.measures.prose_chars
          : null
      log(`[resume/size] черновик: прозы=${measuredProse} проблем=${gateProblems.length}`)
    } else {
      log('[resume/size] ЧЕРНОВИК НЕ ИЗМЕРЕН — круг пойдёт без бюджета по объёму')
    }
  }
}

// --- Research: the fan-out lives in the script; an agent never produces a collection ---------

phase('Research')
const findings = await parallel(
  brief.aspects.map((aspect) => () => {
    if (present.has(sourcePathOf(aspect.slug))) return Promise.resolve('reused')
    // A draft-only launch never searches. If the file is not there, the segment before this one
    // did not finish, and saying so beats quietly researching inside a stage nobody asked to run.
    if (!RUN_RESEARCH) return Promise.resolve('absent')
    return call(
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
    // A finder that died is not a finder that produced nothing. It writes as it goes — a file
    // per source it keeps, and the summary last — so an agent killed by a session limit after
    // reading five papers leaves five files on disk and no return value. Dropping the aspect
    // here dropped those files too: the enumeration below runs over `found`, so a directory
    // nobody listed is a directory nobody reads.
    //
    // So the aspect stays, marked, and the disk decides what survived. The verification stage
    // measures the summary and says loudly if it is missing.
    found.push({ aspect, path, sources: [], reused: false, failed: true })
    log(
      `[research/${aspect.slug}] АГЕНТ НЕ ВЕРНУЛ РЕЗУЛЬТАТ — ` +
        `что успел записать, подберёт перечисление, а сводку проверит диск`,
    )
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
  if (result === 'absent') {
    log(`[research/${aspect.slug}] НЕТ НА ДИСКЕ, а этап research не запрошен — аспект не закрыт`)
    continue
  }
  found.push({ aspect, path, sources: result.sources, reused: false })
  log(
    `[research/${aspect.slug}] sources=${result.sources.length} ` +
      `tool=${result.tool_used}`,
  )
  for (const s of result.sources) log(`[research/source] ${s.title} — ${s.url}`)
}
// `found` now holds failed aspects too, so counting it is no longer the question. The question
// is whether anything at all can be read, and that is answered by at least one aspect having
// either returned or been reused from disk.
if (!found.some((f) => !f.failed)) {
  throw new Error('ни один источниковед не отработал и ничего не переиспользовано')
}

// A port only for the summaries a finder actually finished. A dead finder's aspect stays in
// `found` so its directory gets enumerated below — that is where its rescued sources come from —
// but handing an agent a port to a file that was never written is handing it a question it
// cannot answer. The two lists are deliberately different: one is "what exists to read", the
// other is "everything to look inside".
const sourcePorts = found
  .filter((f) => !f.failed)
  .map((f) => ({ port: `sources:${f.aspect.slug}`, path: f.path }))

// --- Everything the finders actually kept -----------------------------------------------------
//
// The four ports above are the files the script named, one per aspect. The finder also keeps one
// file per source it read — its contract says so — and until this stage existed nobody opened
// them: a measured run had 79 KB reaching downstream agents out of 260 KB on disk. Twenty-four
// sources searched for, read, paid for, and invisible.
//
// That is the likeliest reason attribution errors survived eleven rounds. The writer quoted an
// aspect summary while the note on the specific paper sat unopened beside it, and the fact
// checker was handed the same four summaries to check attribution against.
//
// Enumerating is not asking an agent where it put something: the script still names every path
// it writes. This only reports what is there, so the stages that need primary material get it.
let allSourcePorts = sourcePorts
if (found.length) {
  // One command per aspect directory, in the order the script listed them — the same index rule
  // as everywhere else. The summary file is excluded because it is already a port above.
  const listed = await call(
    commands(
      found.map(
        (f) =>
          // Everything, not only `.md`: the index is a `.json`, and a listing filtered to
          // markdown cannot say whether it is there. Anything else the finder kept shows up
          // here too, which is the point of enumerating rather than assuming.
          `${LISTING_TOOL} --dir ${sourceDirOf(f.aspect.slug)} --ext "" ` +
          `--exclude ${f.aspect.slug}.md ${noted('what finder ' + f.aspect.slug + ' brought back')}`,
      ),
    ),
    {
      agentType: 'gate-runner',
      model: MODELS.gate,
      label: 'sources:list',
      phase: 'Research',
      schema: LISTINGS,
    },
  )
  const perAspect = (listed && listed.listings) || []
  if (perAspect.length !== found.length) {
    warnings.push(
      `перечислений ${perAspect.length} на ${found.length} каталогов: ` +
        `первичные источники до аналитика и сверяющего не дошли`,
    )
    log(
      `[sources] перечислений ${perAspect.length} на ${found.length} каталогов — ` +
        `сопоставить нельзя, дальше идут только сводки по аспектам`,
    )
  } else {
    const extra = []
    found.forEach((f, i) => {
      const files = perAspect[i].files || []
      // The finder's own index — which file came from which URL, and whether the source is
      // primary or someone's retelling of it. It was written on every run and read by nobody:
      // provenance the analyst and the fact checker both want, sitting one directory away.
      // A port is only made for what the listing actually saw, because handing an agent a path
      // to a file nobody wrote is handing it a question it cannot answer.
      const indexes = files.filter((p) => p.endsWith('.json'))
      const sources = files.filter((p) => !p.endsWith('.json'))
      if (!sources.length) {
        // The aspect stays in the pipeline — the finder's own summary is still a port — but the
        // section built on it rests on one unsourced retelling, and that has to be visible while
        // the run is watched rather than discovered in the article afterwards.
        emptyAspects.push(f.aspect.slug)
      }
      log(
        `[sources/${f.aspect.slug}] источников в каталоге: ${sources.length}` +
          (indexes.length ? '' : ', указателя нет') +
          (sources.length ? '' : ' — раздел останется на одной сводке искателя'),
      )
      for (const path of sources) {
        extra.push({ port: `source:${f.aspect.slug}/${path.split('/').pop().replace(/\.md$/, '')}`, path })
      }
      for (const path of indexes) {
        extra.push({ port: `index:${f.aspect.slug}`, path })
      }
    })
    allSourcePorts = [...sourcePorts, ...extra]
    log(
      `[sources] всего ${sourcePorts.length} сводок и ${extra.length} источников — ` +
        `все уходят аналитику и сверяющему`,
    )
  }
}
if (emptyAspects.length) {
  warnings.push(
    `аспекты без единого источника: ${emptyAspects.join(', ')} — ` +
      `эти разделы стоят на сводке искателя и ничем не подтверждены`,
  )
  log(`[sources] БЕЗ ИСТОЧНИКОВ: ${emptyAspects.join(', ')} — проверить эти разделы отдельно`)
}
const totalSources = found.reduce((sum, f) => sum + f.sources.length, 0)
const reusedCount = found.filter((f) => f.reused).length
log(
  `[research] aspects_covered=${found.length}/${brief.aspects.length} sources=${totalSources}` +
    (reusedCount ? ` (переиспользовано с диска: ${reusedCount})` : ''),
)

// --- Analyse: between reading and writing, or the writer paraphrases its last source ---------

// The analyst reconciles sources, so it gets all of them — the per-aspect summaries and the
// per-source notes both. This is the stage whose whole job is "what do these say together".
const analyseTask = task({
  inputs: [{ port: 'brief', path: BRIEF_PATH }, ...allSourcePorts],
  output: MATERIAL_PATH,
})

phase('Analyse')
let analysis = null
if (present.has(MATERIAL_PATH)) {
  log('[analyse] материал уже на диске, аналитик не запускается')
} else if (!RUN_RESEARCH) {
  log('[analyse] материала нет, а этап research не запрошен — писатель пойдёт без него')
} else {
  analysis = await call(analyseTask, {
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

// Skipped when nothing ran. This stage exists to check that agents which just executed left
// their files behind; on a fully reused run no agent executed, and `resume` measured the very
// same paths a moment ago. Re-measuring them is a probe that can only confirm what is already
// known.
phase('Verify')
const nothingRan = found.every((f) => f.reused) && present.has(MATERIAL_PATH)
let existence = nothingRan
  ? { checks: [...found.map(() => ({ ok: true, problems: [] })), { ok: true, problems: [] }] }
  : must(
  await call(existenceCommands([...found.map((f) => f.path), MATERIAL_PATH]), {
    agentType: 'gate-runner',
    model: MODELS.gate,
    label: 'verify:1',
    phase: 'Verify',
    schema: EXISTENCE,
  }),
      'verify:1 — without the disk check this stage means nothing',
    )
if (nothingRan) {
  log('[verify] ничего не запускалось, всё переиспользовано — проверка диска не повторяется')
}
// Every aspect, including the ones whose finder died: the point of this stage is to say what is
// missing, and the aspect most likely to be missing is exactly the one nobody heard back from.
const verifyPaths = [...found.map((f) => f.path), MATERIAL_PATH]
existence.checks.forEach((c, i) => {
  log(
    `[verify] ok=${c.ok} ${verifyPaths[i] || '(лишняя проверка)'}` +
      `${c.problems.length ? ' | ' + c.problems.join('; ') : ''}`,
  )
})

// The material is the last path passed, so it is the last check returned. By index, not by
// matching a substring of a path the agent chose how to spell.
const materialCheck =
  existence.checks.length === verifyPaths.length
    ? existence.checks[verifyPaths.length - 1]
    : null
if (!materialCheck) {
  log(
    `[verify] проверок ${existence.checks.length} на ${verifyPaths.length} путей — ` +
      `материал не сверен`,
  )
}
if (materialCheck && !materialCheck.ok) {
  log(`[verify] MATERIAL NOT CREATED, retrying: ${materialCheck.problems.join('; ')}`)
  analysis = await call(
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
  existence = await call(existenceCommands([MATERIAL_PATH]), {
    agentType: 'gate-runner',
    model: MODELS.gate,
    label: 'verify:2',
    phase: 'Verify',
    schema: EXISTENCE,
  })
  const rechecked = existence ? existence.checks : []
  for (const c of rechecked) {
    log(
      `[verify/2] ok=${c.ok} ${MATERIAL_PATH}` +
        `${c.problems.length ? ' | ' + c.problems.join('; ') : ''}`,
    )
  }
  if (!rechecked.length || rechecked.some((c) => !c.ok)) {
    log('[verify/2] STILL NO MATERIAL — the writer goes without it, and that is in the report')
  }
}

// --- The analysis exists. Is there work under its headings ------------------------------------
//
// A floor on length answers "did the agent write anything" and misses what actually happens: the
// analyst writes the SHAPE of the artifact — every heading the contract asks for, in order — and
// fills it aspect by aspect over many passes. Caught live at 1 748 bytes of headings alone, and
// again at 68 KB with three of six aspects still hollow. Either would pass a floor, and the
// writer would build those sections of the article on nothing.
//
// The empty headings are named back to the analyst rather than the whole job being redone: it
// has Edit, and the ones already filled cost too much to throw away.
if (present.has(MATERIAL_PATH) || analysis) {
  const structure = await call(
    commands([
      `${GATE_TOOL} --file ${MATERIAL_PATH} --no-empty-sections ${noted('is there work under every heading')}`,
    ]),
    {
      agentType: 'gate-runner',
      model: MODELS.gate,
      label: 'verify:structure',
      phase: 'Verify',
      schema: EXISTENCE,
    },
  )
  const hollow = structure && structure.checks && structure.checks[0]
  if (!hollow) {
    log('[verify/структура] проверка не вернулась — наполненность разбора неизвестна')
    warnings.push('не проверено, есть ли работа под заголовками разбора')
  } else if (!hollow.ok) {
    log(`[verify/структура] РАЗБОР С ПУСТЫМИ РАЗДЕЛАМИ: ${hollow.problems.join('; ')}`)
    analysis = await call(
      `The analysis on disk has headings with nothing under them: ${hollow.problems.join('; ')}\n` +
        `Fill exactly those, in place, leaving everything already written as it is.\n\n` +
        analyseTask,
      {
        agentType: 'domain-analyst',
        model: MODELS.analyse,
        label: 'analyse:fill',
        phase: 'Verify',
        schema: ANALYSIS,
      },
    )
    const refilled = await call(
      commands([
        `${GATE_TOOL} --file ${MATERIAL_PATH} --no-empty-sections ${noted('are the headings filled now')}`,
      ]),
      {
        agentType: 'gate-runner',
        model: MODELS.gate,
        label: 'verify:structure/2',
        phase: 'Verify',
        schema: EXISTENCE,
      },
    )
    const after = refilled && refilled.checks && refilled.checks[0]
    if (!after || !after.ok) {
      const left = after ? after.problems.join('; ') : 'проверка не вернулась'
      log(`[verify/структура] ВСЁ ЕЩЁ ПУСТО: ${left}`)
      warnings.push(`разбор ушёл писателю с пустыми разделами: ${left}`)
    } else {
      log('[verify/структура] разделы наполнены')
    }
  } else {
    log('[verify/структура] под каждым заголовком есть работа')
  }
}

// --- End of the research segment --------------------------------------------------------------
//
// A launch that was only asked to research stops here, with the material on disk and the run
// summarised. Everything the drafting segment needs is a file: the brief carries the aspect
// slugs, the slugs name the source files, and the analysis is the writer's material. Nothing of
// value lives in this process once these lines have run.
if (!RUN_DRAFT) {
  const covered = found.filter((f) => !f.reused || present.has(f.path)).length
  log(
    `[итог/research] аспектов=${brief.aspects.length} закрыто=${covered} ` +
      `источников=${totalSources} материал=${present.has(MATERIAL_PATH) || Boolean(analysis)}`,
  )
  await recordHandoff()
  const { onDisk, orphans: researchOrphans } = await auditRun()
  log(`[итог/research] дальше: тот же прогон с config.stages=["draft"]`)
  return {
    stages: STAGES,
    files_on_disk: onDisk.length,
    files_read_by_agents: touched.size,
    orphans: researchOrphans,
    brief: BRIEF_PATH,
    sources: found.map((f) => f.path),
    material: MATERIAL_PATH,
    aspects: brief.aspects.map((a) => a.slug),
    sources_total: totalSources,
    sources_reused_from_disk: found.filter((f) => f.reused).length,
    aspects_covered: covered,
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
let rounds = startRound - 1
if (startRound > MAX_ROUNDS) {
  log(
    `[write] круги исчерпаны предыдущими запусками (${rounds} из ${MAX_ROUNDS}), ` +
      `писатель не запускается — идём сразу к отчёту`,
  )
}

// A run that comes back onto a plateau should not buy one more round to rediscover it. The
// detector inside the loop only fires after a round has been paid for; here the same verdict is
// available before anything is spent, because the counts came off disk.
const plateauAlready = startRound > 1 && sinceBest >= PLATEAU_ROUNDS
if (plateauAlready) {
  log(
    `[write] ПОЛКА уже достигнута прошлыми запусками: лучший результат ${bestOpen} пунктов ` +
      `на круге ${bestRound}, после него ${sinceBest} круга без улучшения. Круги не покупаются.`,
  )
}

for (let round = plateauAlready ? MAX_ROUNDS + 1 : startRound; round <= MAX_ROUNDS; round++) {
  rounds = round
  const writeInputs = [
    { port: 'brief', path: BRIEF_PATH },
    { port: 'material', path: MATERIAL_PATH },
    ...voicePort,
    ...sourcePorts,
  ]
  // Order of the revision block is the order of authority: the length budget, then what a
  // regex measured, then the mechanism critic, then style. A writer that runs out of attention
  // runs out of it on the last section, so what cannot be argued with goes first.
  //
  // The budget is stated as arithmetic because a sentence did not work. Round 3 of a live run
  // was handed "max_prose 30000 exceeded (got 30616)" as one item among sixteen and answered
  // it by adding nine thousand characters of well-sourced material. The script knows the
  // ceiling and the measurement, so it can say how much to remove instead of hoping the
  // writer infers it.
  const overBy = maxProse && measuredProse ? measuredProse - maxProse : 0
  const underBy = minProse && measuredProse ? minProse - measuredProse : 0
  const budget =
    overBy > 0
      ? `LENGTH BUDGET. The draft measures ${measuredProse} characters of readable prose ` +
        `against a ceiling of ${maxProse}: it is ${overBy} over. This round must END SHORTER ` +
        `than it started — remove at least ${overBy} characters. Every other item below has to ` +
        `be satisfied by cutting, or by replacing text with something no longer. Adding a ` +
        `paragraph is not available this round, however well it would serve the article; if a ` +
        `remark cannot be honoured inside the budget, leave it and say which one.\n\n`
      : underBy > 0
        ? `LENGTH BUDGET. The draft measures ${measuredProse} characters of readable prose ` +
          `against a floor of ${minProse}: it is ${underBy} short. Close the gap with substance ` +
          `the sources carry, not by restating what the article already says.\n\n`
        : ''

  // ONE numbered list, not three. Each section used to number from 1, so "item 3" meant three
  // different things and nothing could be checked. Now the number is the identity of a remark
  // for this round, and the writer answers by number.
  // On a genuine first pass there is nothing to report yet and no verdict to read: `verdict` is
  // still null there, and reaching into it is how the previous version of this list crashed two
  // of the three stub paths.
  // Which axis passed last round. Read before the item list is built, because the list is
  // what an approval actually changes.
  const substanceApproved = Boolean(verdict && verdict.verdict === 'ok')
  const styleApproved = Boolean(STYLE_CRITIC && styleVerdict && styleVerdict.verdict === 'ok')
  const approved = []
  if (substanceApproved) approved.push('SUBSTANCE')
  if (styleApproved) approved.push('STYLE')
  const isFirstPass = round === 1 && startRound === 1
  // Exactly one axis approved: this round works only on the other one. The approved axis is not
  // just "please keep it" — its items are withheld entirely, so there is nothing to tempt a
  // rewrite of prose that already passed. When both fail, or neither, the round is normal.
  const singleAxis = substanceApproved !== styleApproved && !isFirstPass
  if (singleAxis) {
    log(
      `[write/${round}] круг односторонний: ${substanceApproved ? 'существо принято, правим только стиль' : 'стиль принят, правим только существо'}`,
    )
  }
  const items = isFirstPass
    ? []
    : [
        ...carried.map((text) => ({ source: 'CARRIED', text })),
        ...gateProblems.map((text) => ({ source: 'GATE', text })),
        ...(singleAxis && substanceApproved
          ? []
          : ((verdict && verdict.remarks) || []).map((text) => ({ source: 'SUBSTANCE', text }))),
        ...(singleAxis && styleApproved
          ? []
          : styleRemarks.map((text) => ({ source: 'STYLE', text }))),
      ]

  // Five remarks came back word for word identical in rounds 4 and 5 of a live run — same
  // corpus named wrongly, same unsourced config values, same line missing from a code quote
  // called complete. The writer had them twice and dropped them twice, and nothing in its
  // contract made that visible: the schema asked what it changed, never what it left. So the
  // round now hands it a numbered ledger and demands one line back per number. A remark can be
  // declined — the length budget may forbid the only available fix — but it cannot vanish.
  const ledgerRule = items.length
    ? `\n\nHOW TO ANSWER. Return one entry per numbered item above, and account for every ` +
      `number from 1 to ${items.length}. Status \`fixed\` when the draft now satisfies it, ` +
      `\`declined\` when you deliberately did not act — and then the note says why, in one ` +
      `sentence. Do not answer an item you did not act on with \`fixed\`: the next round is ` +
      `given whatever you leave open, and the run reports it. An item you silently skip comes ` +
      `back identical next round, which is how five of these were carried three rounds.`
    : ''

  // No items, no revision block. Cleaner than keying off the round number: a resumed run whose
  // records held nothing open has nothing to say to the writer either.
  // What was approved last round, named so it survives this one. Nine rounds of a live run
  // alternated: substance ok / style revise, then substance revise / style ok, then back. Each
  // round fixed one axis and disturbed the other, because the writer was handed the complaints
  // and never the approvals — it had no way to know which half of the draft was finished.
  //
  // An approval is a constraint, not a compliment: it says where the edit must not reach.
  const approvedBlock = approved.length
    ? (singleAxis
        ? `THIS IS A SINGLE-AXIS ROUND. ${substanceApproved ? 'The substance is approved and frozen: change no claim, no number, no attribution, no section, and add nothing. Every edit below is to the prose only.' : 'The prose is approved and frozen: fix the substance with the smallest edits that do it, and leave sentences you are not correcting exactly as they stand.'} A fix that cannot be made without touching the frozen half is declined with that as the reason.

`
        : '') +
      `ALREADY APPROVED, and it has to stay approved: ${approved.join(' and ')}. The critic on ` +
      `that axis passed the previous draft. Whatever you change now must leave it passing — ` +
      `make the smallest edit that answers the items below, and where a fix would disturb an ` +
      `approved axis, prefer the version that does not. The two axes have taken turns failing ` +
      `for several rounds, each round repairing one and breaking the other; that is the thing ` +
      `to stop.

`
    : ''

  const revision = !items.length
    ? null
    : budget +
      approvedBlock +
        `REMARKS ON THE PREVIOUS DRAFT. ` +
        (verdict && verdict.verdict === 'ok'
          ? `The critic on substance passed it, so SUBSTANCE items are optional — take one only ` +
            `if it costs no length. GATE and STYLE items are not optional.`
          : `GATE items are arithmetic and are not open to argument; SUBSTANCE and STYLE items ` +
            `are judgements you may decline with a reason.`) +
        `\n\n` +
        items.map((it, i) => `${i + 1}. [${it.source}] ${it.text}`).join('\n') +
        ledgerRule

  // A draft already on disk is a draft nobody has judged yet, and rewriting it from scratch
  // throws away the most expensive agent in the run. So the first round skips the writer and
  // goes straight to the gate and the critics; from the second round on the writer always
  // runs, because by then there are remarks to act on.
  const skipWriter = round === 1 && startRound === 1 && present.has(ARTICLE_PATH)
  if (skipWriter) {
    log('[write/1] черновик уже на диске, писатель не запускается — сразу гейт и критики')
  } else {
    const article = must(
      await call(task({ inputs: writeInputs, output: ARTICLE_PATH, extra: revision }), {
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

    // The ledger, checked against the numbers the script itself handed over. Everything below
    // is arithmetic on what came back — the writer's own account of a remark is the only thing
    // being trusted, and even that is only trusted where it is present.
    const answered = new Map()
    for (const a of article.addressed) {
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
      log(`[write/${round}/${entry.status}] ${n}. [${items[n - 1].source}] ${entry.note}`)
      if (entry.status === 'declined') declined.push(items[n - 1])
    }
    if (unanswered.length) {
      log(
        `[write/${round}] БЕЗ ОТВЕТА ${unanswered.length} из ${items.length} замечаний — ` +
          `они уходят в следующий круг и в отчёт`,
      )
      for (const it of unanswered) log(`[write/${round}/без-ответа] [${it.source}] ${it.text}`)
    }
    if (declined.length) {
      log(`[write/${round}] отклонено с обоснованием: ${declined.length}`)
    }
    // Kept in the writer's own wording, paired with the remark it answers, and handed to both
    // critics below.
    declinedNotes = declined.map((it) => {
      const entry = [...answered.values()].find((a) => items[a.item - 1] === it)
      return `[${it.source}] ${it.text}\n    → отклонено: ${entry ? entry.note : '(без причины)'}`
    })
    // Carried forward by hand, because the critics of this round judge the NEW draft and will
    // not repeat a remark they consider settled. An item the writer never answered is not
    // settled by anybody.
    //
    // The text travels alone, without a "carried" prefix. It used to get one per round, and by
    // the sixth an item read `CARRIED (перенесено): CARRIED (перенесено): CARRIED (перенесено):
    // STYLE (перенесено): …` — four layers of bookkeeping in front of the remark the writer was
    // supposed to act on. The `[CARRIED]` tag in the numbered list already says where it came
    // from, and it says it once.
    carried = [...unanswered, ...declined].map((it) => it.text)
  }

  // --- Correctors: fix what is decidable before anything judges it -------------------------
  //
  // A chain, not a fan-out: three agents edit the same file in turn, and turn is what makes it
  // safe. Two runs writing one article concurrently already made a draft whose provenance could
  // not be established.
  //
  // Order matters. Arithmetic first, because the fact checker may weaken a claim ABOUT a number
  // and should see the number that survived. Both run before the gate, so the measurement the
  // critics are told about is the measurement of the text that actually exists.
  if (USE_CORRECTORS && !skipWriter) {
    const verified = await call(
      task({
        inputs: [
          { port: 'draft', path: ARTICLE_PATH },
          { port: 'brief', path: BRIEF_PATH },
        ],
        output: ARTICLE_PATH,
      }),
      {
        agentType: 'example-verifier',
        model: MODELS.verify,
        label: `verify-example:${round}`,
        phase: 'Write',
        schema: VERIFIED,
      },
    )
    if (verified) {
      log(
        `[example/${round}] пересчитано командой: ${verified.ran} | ` +
          `исправлено чисел: ${verified.corrections.length}`,
      )
      for (const c of verified.corrections) {
        log(`[example/${round}/число] ${c.where}: было ${c.was} → стало ${c.now}`)
      }
    } else {
      log(`[example/${round}] ПРОВЕРЯЮЩИЙ АРИФМЕТИКУ НЕ ОТРАБОТАЛ — числа примера не сверены`)
    }

    const checked = await call(
      task({
        // All of them, not the four summaries. Checking an attribution against a summary of
        // the paper is how a wrong corpus name survives a correction stage.
        inputs: [
          { port: 'draft', path: ARTICLE_PATH },
          { port: 'brief', path: BRIEF_PATH },
          ...voicePort,
          ...allSourcePorts,
        ],
        output: ARTICLE_PATH,
      }),
      {
        agentType: 'article-fact-checker',
        model: MODELS.factcheck,
        label: `factcheck:${round}`,
        phase: 'Write',
        schema: CHECKED,
      },
    )
    if (checked) {
      log(`[facts/${round}] исправлено утверждений: ${checked.corrections.length}`)
      for (const c of checked.corrections) {
        log(`[facts/${round}/${c.action}] «${c.claim}» | заметка: «${c.note_says}»`)
      }
    } else {
      log(`[facts/${round}] СВЕРКА С ЗАМЕТКАМИ НЕ ОТРАБОТАЛА — атрибуция не проверена`)
    }
  }

  // Measure before judging, so neither critic spends a remark on something already counted.
  const sized = await call(commands([gateCommand(ARTICLE_PATH, minProse, maxProse, `round ${round}`)]), {
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
  measuredProse =
    typeof sizedReport.measures.prose_chars === 'number' ? sizedReport.measures.prose_chars : null
  log(
    `[gate/${round}] ok=${sizedReport.ok} problems=${gateProblems.length} ` +
      `measures=${JSON.stringify(sizedReport.measures)}`,
  )
  for (const p of gateProblems) log(`[gate/${round}/problem] ${p}`)

  const lastRound = round === MAX_ROUNDS
  // One paragraph, identical for both critics: the same facts about the same draft.
  const declinedBlock = declinedNotes.length
    ? `\n\nWHAT THE WRITER DECLINED, and why, from the previous round:\n` +
      declinedNotes.map((d, i) => `${i + 1}. ${d}`).join('\n') +
      `\n\nA declined remark is not settled — but it is not new either. If the reason holds, ` +
      `let it go and do not raise it again; if it does not, say why the reason is wrong rather ` +
      `than repeating the original remark. Repeating it unchanged costs a round and moves ` +
      `nothing.`
    : ''
  // The mechanism critic reads the analysis, not the raw notes. Checking a claim against the
  // note that carries it belongs to the fact checker that ran two stages ago — and while both
  // did it, one agent was doing two jobs and doing the second one badly: attribution errors
  // survived three rounds under a critic that also had to judge the mechanism, the example, the
  // coverage and the order of introduction. Dropping the note ports also halves what this call
  // reads every round, which on a 105 KB analysis and 90 KB of notes is most of its cost.
  const criticInputs = USE_CORRECTORS
    ? [
        { port: 'brief', path: BRIEF_PATH },
        { port: 'draft', path: ARTICLE_PATH },
        { port: 'material', path: MATERIAL_PATH },
      ]
    : [
        { port: 'brief', path: BRIEF_PATH },
        { port: 'draft', path: ARTICLE_PATH },
        { port: 'material', path: MATERIAL_PATH },
        ...sourcePorts,
      ]

  const [judged, styled] = await parallel([
    () =>
      call(
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
            (USE_CORRECTORS
              ? ` The article's claims have already been checked against the source notes by a` +
                ` fact checker in this same round, and its worked example has been recomputed:` +
                ` you have the analysis rather than the notes, and a remark of the form "no note` +
                ` supports this" is not yours to make. Judge the mechanism, the teaching, the` +
                ` order of introduction and the coverage of the brief.`
              : '') +
            (lastRound ? ' This is the last revision round; there are no more.' : '') +
            declinedBlock,
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
      STYLE_CRITIC
        ? call(
            task({
              inputs: [
                { port: 'draft', path: ARTICLE_PATH },
                { port: 'brief', path: BRIEF_PATH },
                ...voicePort,
              ],
              noFile: true,
              extra:
                `A deterministic gate has already run over this draft with the pattern files ` +
                `${FORBID_FILES.join(', ') || '(none)'}, and reported: ` +
                `${gateProblems.length ? gateProblems.join('; ') : 'nothing found'}.` +
                ` Confirm what it found by quoting it, and spend your own rounds on what a` +
                ` regex cannot reach — rhythm, address, terminology, the author's voice.` +
                (lastRound ? ' This is the last revision round; there are no more.' : '') +
                declinedBlock,
            }),
            {
              agentType: STYLE_CRITIC,
              model: MODELS.style,
              label: `style:${round}`,
              phase: 'Write',
              schema: STYLE_VERDICT,
            },
          )
        : Promise.resolve(null),
  ])

  verdict = judged || noVerdict('the critic on substance')
  // A critic that numbers its own list is not wrong to; the ledger is what must stay single.
  // Round 1 of a live run recorded `1. 1. …`, and the two numbers disagree from the first style
  // item onward: ledger 6 is substance 1's neighbour, and the writer answers by number. That is
  // exactly the failure one numbered list was built to prevent, arriving through the other door.
  verdict.remarks = verdict.remarks.map(unnumbered)
  log(`[critic/${round}] verdict=${verdict.verdict} remarks=${verdict.remarks.length}`)
  for (const r of verdict.remarks) log(`[critic/${round}/remark] ${r}`)

  styleVerdict = styled || null
  if (!STYLE_CRITIC) {
    // Not judged, and said so. The item goes on the record and into the report; what it must
    // not do is block a loop that has no way to satisfy it.
    styleRemarks = [
      `стиль не проверен: для языка «${brief.language}» стилевой критик не назначен`,
    ]
    log(`[style/${round}] КРИТИКА ДЛЯ ЭТОГО ЯЗЫКА НЕТ — стиль не судился, пункт в отчёт`)
  } else if (styled) {
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

  // The round goes on the record before anything decides what to do with it. Written here
  // rather than at the end of the run on purpose: the point is to survive a process that dies
  // mid-loop, and a record written after the loop would die with it.
  // With no critic for the language there is no style verdict to wait for. The absence is
  // reported every round and lands in UNRESOLVED.md; it is not a reason to spend the whole
  // round budget proving that nothing will change.
  const styleOk = STYLE_CRITIC ? Boolean(styled) && styled.verdict === 'ok' : true
  const roundItems = [
    ...verdict.remarks,
    ...styleRemarks.map((r) => `Style: ${r}`),
    ...gateProblems.map((p) => `Gate: ${p}`),
    ...carried.map((c) => `Carried: ${c}`),
  ]
  const recordedRound = await call(
    record(
      roundPathOf(round),
      `Round ${round} — verdict=${verdict.verdict} style=${styled ? styled.verdict : 'unknown'}`,
      roundItems,
    ),
    {
      agentType: 'verbatim-writer',
      model: MODELS.record,
      label: `record:${round}`,
      phase: 'Write',
      schema: WROTE,
    },
  )
  // Taken here, beside the record and before the loop can turn: one round produced one verdict
  // about one text, and the two halves of that have to be written at the same moment or they
  // stop being about each other.
  const snapped = await call(
    commands([`${SNAPSHOT_TOOL} --file ${ARTICLE_PATH} --to ${draftPathOf(round)} ${noted('draft snapshot of round ' + round)}`]),
    {
      agentType: 'file-copier',
      model: MODELS.copy,
      label: `snapshot:${round}`,
      phase: 'Write',
      schema: GATE,
    },
  )
  // Declared, not consumed — and that distinction is the one exception the audit allows. A
  // snapshot exists to be read by a person comparing two rounds, so no agent will ever open it,
  // and without this line it would be reported as a loss every run. The rule the audit enforces
  // is "read by an agent OR declared as a record", and this is where a record declares itself.
  touched.add(draftPathOf(round))
  if (snapped && snapped.report && snapped.report.ok) {
    log(`[snapshot/${round}] черновик сохранён: ${draftPathOf(round)}`)
  } else {
    log(
      `[snapshot/${round}] ЧЕРНОВИК НЕ СОХРАНЁН — сравнить круги между собой будет нечем` +
        `${snapped && snapped.report ? ': ' + snapped.report.problems.join('; ') : ''}`,
    )
  }

  if (recordedRound && recordedRound.written) {
    log(`[record/${round}] круг записан: ${roundPathOf(round)} пунктов=${roundItems.length}`)
  } else {
    // Not fatal, but loud: without the record a restart re-judges this draft from scratch.
    log(`[record/${round}] КРУГ НЕ ЗАПИСАН — перезапуск будет судить статью заново`)
  }

  // Did this round beat the best any round has managed? The count is what the reader of
  // UNRESOLVED.md will see, so it is the thing worth minimising.
  //
  // Counted before the acceptance check, not after. With the accounting below the break, the
  // accepted round never became the best one: a live run accepted round 6 with seven items and
  // reported its best as twelve on round 4 — and `best_round` is exactly what a person reads to
  // find the draft snapshot worth keeping.
  if (roundItems.length < bestOpen) {
    bestOpen = roundItems.length
    bestRound = round
    sinceBest = 0
  } else {
    sinceBest += 1
    log(
      `[write/${round}] не лучше достигнутого: ${roundItems.length} пунктов против ` +
        `${bestOpen} на круге ${bestRound} (подряд без улучшения: ${sinceBest})`,
    )
  }

  // All three conditions. An article the mechanism critic likes but written in machine
  // prose, one in the author's voice that explains the mechanism wrongly, and one both
  // critics like that overruns the brief are equally unfinished.
  if (verdict.verdict === 'ok' && styleOk && sizedReport.ok) break

  // A round that produced the same set of items as the round before it has stopped moving, and
  // the next one will produce it again. Six rounds of a live run cost five million tokens
  // partly this way: the same five remarks came back word for word while the budget drained.
  // Stopping here is not giving up — the items are recorded and reported either way; it is
  // declining to pay for a third identical answer.
  if (sinceBest >= PLATEAU_ROUNDS) {
    log(
      `[write/${round}] ПОЛКА: ${sinceBest} круга подряд не улучшили результат. Петля своё ` +
        `отработала — остальное решает автор, и оно в отчёте.`,
    )
    break
  }

  const signature = JSON.stringify(roundItems.slice().sort())
  if (previousItems === signature) {
    log(
      `[write/${round}] ПЕТЛЯ НЕ ДВИЖЕТСЯ: набор замечаний совпал с предыдущим кругом ` +
        `(${roundItems.length} пунктов). Дальше круги не помогут — останавливаемся и всё в отчёт.`,
    )
    break
  }
  previousItems = signature
}

// The loop may not have run at all — every round spent by earlier launches. The verdict then
// comes from the record, and if even that is missing there is nothing to report on.
if (!verdict) {
  throw new Error('нет ни одного круга правки и нет записей о прошлых — статью никто не судил')
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
  ...carried.map((c) => `Carried: ${c}`),
]
if (openItems.length) {
  const passed = verdict.verdict === 'ok' && stylePassed && !gateProblems.length
  log(
    `[unresolved] rounds=${rounds} verdict=${verdict.verdict} ` +
      `style=${styleVerdict ? styleVerdict.verdict : 'no verdict'} ` +
      `${passed ? 'accepted with remarks' : 'NOT accepted'}: items=${openItems.length}`,
  )
  const wrote = await call(
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
const gate = await call(commands([gateCommand(ARTICLE_PATH, minProse, maxProse)]), {
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

// --- Audit: is there anything here that nobody read? -----------------------------------------
//
// The question this answers is the one that cannot be answered by looking at the code: not "does
// the wiring look right" but "did anything the run produced end up unread". Every loss found in
// this pipeline had that exact shape, and none of them looked like a failure at the time:
//
//   - twenty-five source notes written by the finders, passed to nobody;
//   - a dead finder's whole directory, dropped because the aspect left the list;
//   - `_index.json`, written every run since the beginning, read for the first time today;
//   - an agent's scratch `rounds_output.json`, sitting in the run directory.
//
// `touched` is every path that reached an agent. The disk is what is actually there. The
// difference is the loss, and it is reported by name rather than counted, because a number tells
// you that something went missing and a name tells you what.
phase('Gate')
await recordHandoff()
const { onDisk: onDiskNow, orphans } = await auditRun()

log(
  `[summary] aspects=${brief.aspects.length} sources=${totalSources} rounds=${rounds} ` +
    `verdict=${verdict.verdict} style=${styleVerdict ? styleVerdict.verdict : 'no verdict'} ` +
    `gate_ok=${report.ok} open_items=${openItems.length}`,
)

return {
  stages: STAGES,
  brief: BRIEF_PATH,
  sources: found.map((f) => f.path),
  material: MATERIAL_PATH,
  article: ARTICLE_PATH,
  unresolved: unresolvedPath,
  aspects: brief.aspects.map((a) => a.slug),
  sources_total: totalSources,
  sources_reused_from_disk: reusedCount,
  rounds,
  best_round: bestRound,
  best_open_items: bestOpen === Infinity ? null : bestOpen,
  verdict: verdict.verdict,
  style_verdict: styleVerdict ? styleVerdict.verdict : null,
  open_items: openItems.length,
  gate_ok: report.ok,
  gate_measures: report.measures,
  files_on_disk: onDiskNow.length,
  files_read_by_agents: touched.size,
  orphans,
}
