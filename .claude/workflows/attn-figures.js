// Illustrate an article that is already written: plan the figures it needs, render them with
// the figgybanana CLI, look at what came out, redraw what failed.
//
// The drawing itself is not ours. figgybanana runs its own five-agent pipeline per figure
// (retriever, planner, stylist, visualizer, vision critic), and this script only commissions
// it and judges the result. Two model slots are set explicitly on every call:
//
//   --vlm-provider claude_code --vlm-model sonnet      planner and stylist
//   --critic-vlm-provider kimi --critic-vlm-model k3   the vision critic only
//
// Kimi K3 sits in the critic slot on purpose. It is the slot that looks at the rendered image,
// which is what its vision is wanted for, and the Kimi-for-Coding quota is small — spending it
// on the critic alone stretches it about three times further than putting Kimi on every agent.
// When that quota runs out the CLI is called again without the two critic flags, so the critic
// falls back to claude_code sonnet; the agent reports which slot filled it per figure.
//
// Images go through ss_gateway and nowhere else. A 401 from the gateway means its bridge has no
// token in the Windows keychain (fix: open "SS AI Setup", press Apply) — it is not a reason to
// reach for a public image key, and silently switching providers is how a run stops testing
// what it was built to test.
//
// Every string in this file is English, including the ones only a person reads. The articles
// are Russian; the machinery that makes them is not, and a script that mixes the two gives a
// model one more reason to switch language halfway through a run.

export const meta = {
  name: 'attn-figures',
  description: 'Figures for a finished article through figgybanana, with Kimi K3 as the critic',
  phases: [
    { title: 'Plan', detail: 'which figures the article needs, placeholders into the text' },
    { title: 'Draw', detail: 'figgybanana, one run per figure' },
    { title: 'Look', detail: 'read the PNGs with our own eyes against the captions' },
    { title: 'Redraw', detail: 'redraw what failed, with the defects attached' },
    { title: 'Gate', detail: 'deterministic file count' },
  ],
}

const run = typeof args === 'string' ? args : args && args.runDir
if (!run) {
  throw new Error('a run directory is required: args.runDir, e.g. probe-runs/figures')
}
// The article to illustrate comes from a previous run; nothing here writes to it. Required
// rather than defaulted: the default used to name one particular old run, so a caller who
// forgot the argument got figures drawn for somebody else's article and no error to say so.
// A missing path is a question, and the script asks it instead of guessing.
const source = args && args.articlePath
if (!source) {
  throw new Error('нужен путь к статье: args.articlePath — тот файл, к которому рисуем')
}
// A count, not a path: this one is a policy default and belongs here.
const wanted = (args && args.figures) || 3
const MAX_REDRAWS = 2

// Every path is named by the script. `run_dir` is the one exception the agents report back,
// because the CLI stamps it with a timestamp the script has no way to know.
const ARTICLE_PATH = `${run}/article.md`
const FIGURES_DIR = `${run}/figures`
const WORK_DIR = `${run}/figures-work`
const MANIFEST_PATH = `${FIGURES_DIR}/manifest.json`
// Both paths are absolute and both are needed. figgybanana resolves `guidelines_path` and
// `reference_set_path` relative to the current directory, and we run its CLI from this
// repository, not from its own — so the defaults `data/guidelines` and `data/reference_sets`
// point at directories that do not exist here. The guidelines being missing is visible (a
// thin stylist prompt); the reference set being missing is not: the retriever simply returns
// `retrieved_examples: []` and the pipeline proceeds ungrounded. The first run drew all three
// figures that way.
//
// The blog pair, not the conference one: `reference_sets_blog` holds the two etalon diagrams
// the blog style guide was synthesised from, and pairing the guide with a different corpus
// would pull the stylist and the retriever in two directions.
//
// Where figgybanana lives is not written here. A workflow script has no access to the
// environment, so the shell resolves it: `$FIGGYBANANA_HOME` if set, otherwise derived from
// `$PAPERBANANA_BIN`, which already points inside that repository
// (`…/figgybanana/.venv/Scripts/paperbanana.exe`). Hardcoding an absolute path would tie the
// script to one machine and put a home directory into a public repository.
const GUIDELINES = '$FIGGY/data/guidelines/blog'
const REFERENCE_SET = '$FIGGY/data/reference_sets_blog'

const PLAN = {
  type: 'object',
  required: ['figures'],
  properties: {
    figures: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['slug', 'caption', 'why', 'section'],
        properties: {
          slug: { type: 'string', description: 'latin, hyphenated, the filename without .png' },
          caption: { type: 'string', description: 'the caption from the placeholder, verbatim' },
          why: { type: 'string', description: 'what the figure explains better than a paragraph' },
          section: { type: 'string', description: 'the heading of the section it stands after' },
        },
      },
    },
  },
}

const DRAWN = {
  type: 'object',
  required: ['done', 'failed', 'gateway_ok'],
  properties: {
    done: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'critic_provider', 'run_dir', 'iterations'],
        properties: {
          slug: { type: 'string' },
          critic_provider: { type: 'string', description: 'kimi or claude_code — who judged it' },
          run_dir: { type: 'string', description: 'the CLI run directory, which the CLI named' },
          iterations: { type: 'number' },
        },
      },
    },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'reason'],
        properties: { slug: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    gateway_ok: {
      type: 'boolean',
      description: 'did the image gateway answer; false on a 401 or a missing token',
    },
  },
}

const LOOKED = {
  type: 'object',
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        // `labels_seen` is not decoration: the first run returned ok with zero defects for
        // three figures, two of which carried English prose in a Russian article. A verdict
        // is cheap to rubber-stamp; an enumeration of every label on the image is not, and it
        // forces the reading that the verdict was supposed to rest on.
        required: ['slug', 'labels_seen', 'ok', 'defects'],
        properties: {
          slug: { type: 'string' },
          labels_seen: {
            type: 'array',
            items: { type: 'string' },
            description: 'EVERY label on the image verbatim, including small and sub-figure ones',
          },
          ok: { type: 'boolean', description: 'is the figure fit for the article as it stands' },
          defects: {
            type: 'array',
            items: { type: 'string' },
            description: 'what exactly is wrong; each one usable as an instruction to redraw',
          },
        },
      },
    },
  },
}

const GATE = {
  type: 'object',
  required: ['report', 'stdout'],
  properties: {
    report: {
      type: 'object',
      required: ['ok', 'problems', 'measures'],
      properties: {
        ok: { type: 'boolean' },
        problems: { type: 'array', items: { type: 'string' } },
        measures: { type: 'object' },
      },
    },
    stdout: { type: 'string' },
  },
}

// The environment block every CLI call needs, spelled out once. Every line here was paid for
// with a failed live run.
//
// `pwd -W`, not `$PWD`. In Git Bash `$PWD` is the POSIX form `/c/Users/...`, and a TEMP in
// that form is a path Windows cannot resolve. PowerShell then fails to start, and the gateway
// bridge reads its tokens through PowerShell — so all eight come back empty, the bridge builds
// 3 headers instead of 11, and the gateway answers 401. The whole thing reads exactly like
// expired credentials and is not: it is one wrong-shaped path. Cost: an hour and a wrong
// diagnosis handed to the user.
//
// The temp dir must also sit inside the working directory, or the vision critic cannot read
// the image it is meant to judge and reviews the description instead; and it must be in long
// form, because a segment like `ACHIRI~1` is refused as a "suspicious Windows path pattern"
// and the critic again declares itself satisfied having seen nothing.
//
// KIMI_BASE_URL is exported because the CLI reads figgybanana's own .env relative to the
// current directory, and we are not running in that directory.
const ENV_BLOCK =
  `mkdir -p ${WORK_DIR}/tmp ${FIGURES_DIR}\n` +
  `export WINROOT="$(pwd -W)"   # Windows form; the POSIX form breaks PowerShell\n` +
  `export TMPDIR="$WINROOT/${WORK_DIR}/tmp" TEMP="$TMPDIR" TMP="$TMPDIR"\n` +
  `export KIMI_BASE_URL="https://api.kimi.com/coding/v1"\n` +
  `FIGGY="\${FIGGYBANANA_HOME:-$(echo "$PAPERBANANA_BIN" | tr '\\\\\\\\' '/' | ` +
  `sed 's#/[.]venv/Scripts/paperbanana.exe$##')}"\n` +
  `test -d "$FIGGY/data" || { echo "figgybanana directory not found: $FIGGY"; exit 1; }\n` +
  `export GUIDELINES_PATH="${GUIDELINES}"\n` +
  `export REFERENCE_SET_PATH="${REFERENCE_SET}"\n` +
  `echo "TEMP=$TEMP FIGGY=$FIGGY"   # TEMP must start with C:/ — if it starts with /c/, fix it`

const TOOL_RULES =
  `\n\nTHE TOOL. Resolve the executable in this order and stop at the first one that answers:\n` +
  `1. the variable $PAPERBANANA_BIN — check it FIRST, before any search; the tool lives in its ` +
  `own virtualenv, and that is the normal case, not the exception;\n` +
  `2. paperbanana on PATH — only if the variable is empty.\n` +
  `While $PAPERBANANA_BIN is set, "not on PATH" is neither a finding nor a reason to stop: ` +
  `paperbanana, figgybanana, npm and pip will not be found there by construction.\n\n` +
  `THE ENVIRONMENT. The exports are already written into the command below. Run them and the ` +
  `tool call in ONE Bash invocation: every Bash call of yours is a fresh shell, variables from ` +
  `the previous one are dead in it, and without TEMP the gateway bridge cannot read its tokens ` +
  `and answers 401. Do not split this across two calls.\n\n` +
  `PROVIDERS. Images go through ss_gateway and nothing else. If the gateway answers 401 or ` +
  `"missing bearer token", stop, set gateway_ok=false and explain; do NOT fall back to ` +
  `openai_imagen, google_imagen or any other image provider — that is not your decision.\n` +
  `The critic is Kimi K3. If Kimi answers 403 or "usage limit", drop the two flags ` +
  `--critic-vlm-provider and --critic-vlm-model from the command: the critic then becomes ` +
  `claude_code sonnet. Name the critic per figure in your report.`

// The environment and the command go into ONE Bash call, never two. Each Bash invocation is a
// fresh shell, so exports from a previous call are gone — and when TEMP is gone the gateway
// bridge cannot read its tokens and answers 401. That is exactly how the first redraw round
// died after the first draw round had worked: same script, same agent, different call
// boundary.
function drawCommand(slug, caption) {
  return (
    `${ENV_BLOCK}\n` +
    `<bin> generate \\\n` +
    `  --input ${WORK_DIR}/brief-${slug}.txt \\\n` +
    `  --caption "${caption}" \\\n` +
    `  --output-dir ${WORK_DIR} \\\n` +
    `  --auto --max-iterations 3 \\\n` +
    `  --vlm-provider claude_code --vlm-model sonnet \\\n` +
    `  --critic-vlm-provider kimi --critic-vlm-model k3 \\\n` +
    `  --image-provider ss_gateway \\\n` +
    `  --aspect-ratio 16:9 --save-prompts`
  )
}

log(`[start] dir=${run} article=${source} figures=${wanted}`)

// --- Plan: the writer declares the figures, which is what its contract says it does ---------

phase('Plan')
const plan = await agent(
  `The article is already written and lives at ${source}. It must not be changed.\n\n` +
    `Read it and decide which ${wanted} figures explain the mechanism better than a paragraph ` +
    `of prose does. A figure must carry what prose carries badly: a structure, a flow, a ` +
    `correspondence between parts. Do not illustrate what one sentence already makes clear.\n\n` +
    `Copy the article to ${ARTICLE_PATH} and insert into the copy exactly ${wanted} ` +
    `placeholders of the form ![caption](figures/<slug>.png), each one directly after the ` +
    `paragraph it belongs to. The caption is in the article's language and says what the ` +
    `figure communicates. The slug is latin and hyphenated. Change nothing else in the text: ` +
    `not a word, not the order of the sections.\n\n` +
    `Return the list of figures: slug, caption verbatim, the section it stands after, and what ` +
    `it is good for.\n\nOUTPUT. Your result is the FILE ${ARTICLE_PATH}: the copy of the ` +
    `article with the placeholders. Write it with the Write tool. The schema fields describe ` +
    `it, they are not it.`,
  { agentType: 'article-writer', model: 'sonnet', label: 'plan', phase: 'Plan', schema: PLAN },
)
log(`[plan] figures planned=${plan.figures.length}`)
for (const f of plan.figures) {
  log(`[plan/${f.slug}] «${f.caption}» — after «${f.section}»`)
  log(`[plan/${f.slug}/why] ${f.why}`)
}

// --- Draw: one CLI run per figure; the tool owns the drawing, we own the brief --------------

phase('Draw')
let drawn = await agent(
  `You have ${plan.figures.length} figures to draw for the article ${ARTICLE_PATH}.\n\n` +
    `The placeholders in the article:\n` +
    plan.figures.map((f, i) => `${i + 1}. ${f.slug} — «${f.caption}» (section «${f.section}»)`).join('\n') +
    `\n\nFor each figure:\n` +
    `1. Read the section of the article it belongs to and write a brief into ` +
    `${WORK_DIR}/brief-<slug>.txt: the entities, what connects to what, the labels that must ` +
    `appear verbatim, and what must NOT be on the picture. In prose, not in fragments. Take ` +
    `the notation from the article: if the text calls a matrix Q, it is Q on the figure.\n` +
    `   The article is Russian, so the worded labels on the figure are Russian too, and the ` +
    `brief is written in Russian. Formulas and matrix names (X, Q, K, V, W^Q, n × d_k) stay as ` +
    `they are in the text — they have no language. Keep the worded labels few and short: the ` +
    `image generator draws Cyrillic worse than Latin, and a long phrase is likelier to come ` +
    `out mangled than a short one.\n` +
    `2. Run the tool once with this command, substituting your bin, the slug and the caption:\n\n` +
    drawCommand('<slug>', '<caption>') +
    `\n\n3. The tool names its own run directory and writes final_output.png into it. Copy that ` +
    `file to the name from the placeholder: cp ${WORK_DIR}/run_*/final_output.png ` +
    `${FIGURES_DIR}/<slug>.png — copy the run that just finished, not the newest one at a ` +
    `guess. Check that the file exists and is not empty.\n` +
    `4. After the very first figure, open ${WORK_DIR}/run_*/planning.json and look at the ` +
    `field retrieved_examples. An empty list there means the etalons were not picked up, which ` +
    `means REFERENCE_SET_PATH did not arrive: stop and say so, do not draw the rest blind. The ` +
    `retriever is half of what this tool was chosen for.\n` +
    `5. If the command fails, read its output. An unreachable gateway, an exhausted quota and a ` +
    `rejected brief are three different problems, and only the last one is yours. One retry ` +
    `with a shorter, more concrete brief; if that fails, record it in failed and move on to ` +
    `the next figure.\n\n` +
    `Write ${MANIFEST_PATH}: per figure the slug, the caption, the file, the exact command, the ` +
    `run directory, the number of iterations and who the critic was. The point of the manifest ` +
    `is the command: a figure someone wants slightly different is redrawn by editing one brief ` +
    `and running one line.` +
    TOOL_RULES,
  {
    agentType: 'illustrator',
    model: 'sonnet',
    label: 'draw:1',
    phase: 'Draw',
    schema: DRAWN,
  },
)
log(`[draw] drawn=${drawn.done.length} failed=${drawn.failed.length} gateway_ok=${drawn.gateway_ok}`)
for (const d of drawn.done) {
  log(`[draw/${d.slug}] critic=${d.critic_provider} iterations=${d.iterations} run=${d.run_dir}`)
}
for (const f of drawn.failed) log(`[draw/failed] ${f.slug}: ${f.reason}`)

if (!drawn.gateway_ok) {
  // Loud and specific: this is a credential in the OS keychain, not something a prompt fixes.
  log('[draw] THE GATEWAY DID NOT ANSWER: open "SS AI Setup", press Apply, then run again')
}

// --- Look and Redraw: our own eyes on the render, then targeted repair ----------------------

const lookTask = (slugs) =>
  `Look at these figures as a reader of the article ${ARTICLE_PATH} would. The files: ` +
  slugs.map((s) => `${FIGURES_DIR}/${s}.png`).join(', ') +
  `\n\nOpen EVERY file with the Read tool — you can look at images — and check it against its ` +
  `caption and against the section of the article it belongs to.\n\n` +
  `For each one decide whether it is fit for the article as it stands. Look at: are the labels ` +
  `legible; is the notation the same as in the text; are there invented elements the article ` +
  `does not have; are the directions of any relations reversed; is the picture empty or a ` +
  `mess. Typos inside the picture's labels are a defect and they are visible.\n\n` +
  `Separately and pedantically — CYRILLIC. Image generators break it: letters get substituted ` +
  `and words turn into Russian-looking noise. Read every Russian label out to yourself: if it ` +
  `is not a real word, that is a defect, and say which label went wrong. An article with a ` +
  `figure that has gibberish written on it is worse than an article with no figure.\n\n` +
  `If you crop fragments to inspect details, put them in ${WORK_DIR}, not in ${FIGURES_DIR}: ` +
  `that directory holds only what ships with the article.

` +
  `Phrase the defects so they can be handed to whoever redraws: "the arrow from K to Q is ` +
  `drawn the wrong way round", not "unclear".\n\n` +
  `FIRST write out into labels_seen every label on the picture verbatim — all of them, ` +
  `including the small ones under blocks and on arrows. Pass no verdict until you have: this ` +
  `is the step at which what a quick glance skips becomes visible.\n\n` +
  `THE LANGUAGE OF THE LABELS. The article is Russian, so the worded labels are Russian. Latin ` +
  `is allowed for: notation and formulas (X, Q, K, V, W^Q, n × d_k, d_model) and the terms the ` +
  `article itself writes in Latin — softmax and Attention. Anything else in English is a ` +
  `defect: "output" instead of «выход», "shape unchanged" instead of «форма не меняется», ` +
  `"Concat" where the article speaks of concatenation. Three figures in one article must be in ` +
  `one language; a mismatch between them is a defect even if each reads fine on its own.\n\n` +
  `THE TYPOGRAPHY OF THE NOTATION. Subscripts must be subscripts: d_k and d_v are printed as a ` +
  `d with a small k or v below, not as "d_k" with an underscore in the middle of the line. A ` +
  `raw underscore in a formula is a defect, and it is especially visible when both spellings ` +
  `sit side by side on one picture. Check every dimension separately.`

phase('Look')
let looked = await agent(lookTask(drawn.done.map((d) => d.slug)), {
  model: 'sonnet',
  label: 'look:1',
  phase: 'Look',
  schema: LOOKED,
})
for (const c of looked.checks) {
  log(`[look/${c.slug}] ok=${c.ok}${c.defects.length ? ' | ' + c.defects.join('; ') : ''}`)
}

let redraws = 0
while (redraws < MAX_REDRAWS && looked.checks.some((c) => !c.ok)) {
  redraws += 1
  const bad = looked.checks.filter((c) => !c.ok)
  phase('Redraw')
  log(`[redraw/${redraws}] redrawing: ${bad.map((c) => c.slug).join(', ')}`)

  const byslug = {}
  for (const d of drawn.done) byslug[d.slug] = d

  const again = await agent(
    `Redraw only these figures and leave the rest alone. What is wrong with each:\n\n` +
      bad
        .map(
          (c, i) =>
            `${i + 1}. ${c.slug} (run directory ${byslug[c.slug] ? byslug[c.slug].run_dir : 'unknown'})\n` +
            c.defects.map((d) => `   - ${d}`).join('\n'),
        )
        .join('\n\n') +
      `\n\nThe tool has a supported path for this: continue the existing run and hand the ` +
      `defects to its critic. The exports and the call go in ONE Bash invocation.\n\n` +
      `${ENV_BLOCK}\n` +
      `<bin> generate --output-dir ${WORK_DIR} --continue-run <run directory> \\\n` +
      `  --auto --max-iterations 2 \\\n` +
      `  --vlm-provider claude_code --vlm-model sonnet \\\n` +
      `  --critic-vlm-provider kimi --critic-vlm-model k3 \\\n` +
      `  --image-provider ss_gateway \\\n` +
      `  --feedback "<the defects for this figure, on one line>"\n\n` +
      `If continuing does not work, edit the brief ${WORK_DIR}/brief-<slug>.txt according to ` +
      `the defects and run the ordinary command again. Copy the finished file to ` +
      `${FIGURES_DIR}/<slug>.png again, over the old one. Update ${MANIFEST_PATH}.` +
      TOOL_RULES,
    {
      agentType: 'illustrator',
      model: 'sonnet',
      label: `redraw:${redraws}`,
      phase: 'Redraw',
      schema: DRAWN,
    },
  )
  for (const d of again.done) {
    log(`[redraw/${redraws}/${d.slug}] critic=${d.critic_provider} iterations=${d.iterations}`)
  }
  for (const f of again.failed) log(`[redraw/${redraws}/failed] ${f.slug}: ${f.reason}`)

  looked = await agent(lookTask(bad.map((c) => c.slug)), {
    model: 'sonnet',
    label: `look:${redraws + 1}`,
    phase: 'Redraw',
    schema: LOOKED,
  })
  for (const c of looked.checks) {
    log(`[look/${redraws + 1}/${c.slug}] ok=${c.ok}${c.defects.length ? ' | ' + c.defects.join('; ') : ''}`)
  }
}

// --- Gate: how many files are actually on disk, counted by python ---------------------------

phase('Gate')
const gate = await agent(
  `Run exactly this command from the repository root and return its result unchanged:\n\n` +
    `python -X utf8 tools/gate.py --dir ${FIGURES_DIR} --min-entries ${plan.figures.length + 1}\n\n` +
    `Return the parsed report in the report field and the raw output in stdout. Correct nothing.`,
  { model: 'haiku', label: 'gate', phase: 'Gate', schema: GATE },
)
log(
  `[gate] ok=${gate.report.ok} problems=${gate.report.problems.length} ` +
    `measures=${JSON.stringify(gate.report.measures)}`,
)
for (const p of gate.report.problems) log(`[gate/problem] ${p}`)

// A floor is not enough for a delivery directory. The vision check cropped fragments to look
// at them closely and left four crop_*.png next to the figures; `--min-entries 4` counted
// eight and said ok, so the debris would have shipped with the article.
const expectedEntries = plan.figures.length + 1
const actualEntries = gate.report.measures.entries
if (typeof actualEntries === 'number' && actualEntries !== expectedEntries) {
  log(
    `[gate] EXTRA FILES IN THE DELIVERY: ${actualEntries} files, expected ${expectedEntries} ` +
      `(${plan.figures.length} figures and the manifest). Working files belong in ${WORK_DIR}.`,
  )
}

const stillBad = looked.checks.filter((c) => !c.ok)
if (stillBad.length) {
  // Same rule as the article loop: an unmet verdict goes into the log by name, never silently.
  log(`[summary] NOT BROUGHT UP TO QUALITY: ${stillBad.map((c) => c.slug).join(', ')}`)
  for (const c of stillBad) for (const d of c.defects) log(`[summary/defect] ${c.slug}: ${d}`)
}

log(
  `[summary] planned=${plan.figures.length} drawn=${drawn.done.length} ` +
    `redraws=${redraws} not_good_enough=${stillBad.length} gate_ok=${gate.report.ok}`,
)

return {
  article: ARTICLE_PATH,
  figures_dir: FIGURES_DIR,
  manifest: MANIFEST_PATH,
  planned: plan.figures.map((f) => f.slug),
  drawn: drawn.done.map((d) => d.slug),
  failed: drawn.failed,
  redraws,
  not_good_enough: stillBad.map((c) => ({ slug: c.slug, defects: c.defects })),
  gateway_ok: drawn.gateway_ok,
  gate_ok: gate.report.ok,
  gate_measures: gate.report.measures,
}
