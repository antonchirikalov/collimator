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

export const meta = {
  name: 'attn-figures',
  description: 'Иллюстрации к готовой статье через figgybanana, критик — Kimi K3',
  phases: [
    { title: 'Plan', detail: 'какие рисунки статье нужны, заглушки в текст' },
    { title: 'Draw', detail: 'figgybanana по одному разу на рисунок' },
    { title: 'Look', detail: 'смотрим на PNG глазами и сверяем с подписью' },
    { title: 'Redraw', detail: 'перерисовка того, что не прошло, с замечаниями' },
    { title: 'Gate', detail: 'детерминированный счёт файлов' },
  ],
}

const run = typeof args === 'string' ? args : args && args.runDir
if (!run) {
  throw new Error('нужен каталог прогона: args.runDir, например probe-runs/figures')
}
// The article to illustrate comes from a previous run; nothing here writes to it.
const source = (args && args.articlePath) || 'probe-runs/attn3/article.md'
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
          slug: { type: 'string', description: 'латиницей через дефис, имя файла без .png' },
          caption: { type: 'string', description: 'подпись из заглушки, дословно' },
          why: { type: 'string', description: 'что рисунок объясняет лучше, чем абзац текста' },
          section: { type: 'string', description: 'заголовок раздела, после которого он стоит' },
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
          critic_provider: { type: 'string', description: 'kimi или claude_code — кто судил' },
          run_dir: { type: 'string', description: 'каталог прогона CLI, он его сам назвал' },
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
      description: 'ответил ли шлюз изображений; false при 401 или отсутствии токена',
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
            description: 'КАЖДАЯ надпись на картинке дословно, включая мелкие и подрисуночные',
          },
          ok: { type: 'boolean', description: 'годится ли рисунок в статью как есть' },
          defects: {
            type: 'array',
            items: { type: 'string' },
            description: 'что именно не так, каждое пригодно как правка для рисовальщика',
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
  `export WINROOT="$(pwd -W)"   # Windows-форма пути, POSIX-форма ломает PowerShell\n` +
  `export TMPDIR="$WINROOT/${WORK_DIR}/tmp" TEMP="$TMPDIR" TMP="$TMPDIR"\n` +
  `export KIMI_BASE_URL="https://api.kimi.com/coding/v1"\n` +
  `FIGGY="\${FIGGYBANANA_HOME:-$(echo "$PAPERBANANA_BIN" | tr '\\\\\\\\' '/' | ` +
  `sed 's#/[.]venv/Scripts/paperbanana.exe$##')}"\n` +
  `test -d "$FIGGY/data" || { echo "не найден каталог figgybanana: $FIGGY"; exit 1; }\n` +
  `export GUIDELINES_PATH="${GUIDELINES}"\n` +
  `export REFERENCE_SET_PATH="${REFERENCE_SET}"\n` +
  `echo "TEMP=$TEMP FIGGY=$FIGGY"   # TEMP обязан начинаться с C:/ — если с /c/, чини`

const TOOL_RULES =
  `\n\nИНСТРУМЕНТ. Разрешай исполняемый файл в этом порядке и останавливайся на первом, ` +
  `который ответил:\n` +
  `1. переменная $PAPERBANANA_BIN — проверь её ПЕРВОЙ, до любого поиска; инструмент живёт в ` +
  `своём virtualenv, это норма, а не исключение;\n` +
  `2. paperbanana на PATH — только если переменная пуста.\n` +
  `Пока $PAPERBANANA_BIN задана, «нет на PATH» не находка и не повод остановиться: ` +
  `paperbanana, figgybanana, npm и pip не найдутся по построению.\n\n` +
  `ОКРУЖЕНИЕ. Экспорты уже вписаны в саму команду ниже. Выполняй их и вызов инструмента ` +
  `ОДНИМ вызовом Bash: каждый твой вызов Bash — новая оболочка, переменные из прошлого в ней ` +
  `мертвы, а без TEMP мост до шлюза не прочитает свои токены и ответит 401. Не разноси по ` +
  `двум вызовам.\n\n` +
  `ПРОВАЙДЕРЫ. Картинки только через ss_gateway. Если шлюз отвечает 401 или ` +
  `«missing bearer token» — останавливайся, ставь gateway_ok=false и объясни; НЕ переходи на ` +
  `openai_imagen, google_imagen или любой другой провайдер картинок, это не твоё решение.\n` +
  `Критик — Kimi K3. Если Kimi отвечает 403 или «usage limit», убери из команды два флага ` +
  `--critic-vlm-provider и --critic-vlm-model: тогда критиком станет claude_code sonnet. ` +
  `В отчёте назови по каждому рисунку, кто был критиком.`

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

log(`[start] каталог=${run} статья=${source} рисунков=${wanted}`)

// --- Plan: the writer declares the figures, which is what its contract says it does ---------

phase('Plan')
const plan = await agent(
  `Статья уже написана и лежит в ${source}. Менять её нельзя.\n\n` +
    `Прочитай её и реши, какие ${wanted} рисунка объясняют механизм лучше, чем абзац текста. ` +
    `Рисунок обязан нести то, что в прозе передаётся плохо: устройство, поток, соответствие ` +
    `частей. Не иллюстрируй то, что и так понятно из одной фразы.\n\n` +
    `Скопируй статью в ${ARTICLE_PATH} и вставь в копию ровно ${wanted} заглушки в формате ` +
    `![подпись](figures/<slug>.png), каждую сразу после того абзаца, к которому она ` +
    `относится. Подпись — по-русски, она говорит, что рисунок сообщает. Слаг — латиницей ` +
    `через дефис. Больше в тексте ничего не меняй: ни слова, ни порядок разделов.\n\n` +
    `Верни список рисунков: слаг, подпись дословно, раздел, после которого он стоит, и чем ` +
    `он полезен.\n\nВЫХОД. Твой результат — ФАЙЛ ${ARTICLE_PATH}: копия статьи с заглушками. ` +
    `Запиши его инструментом Write. Поля схемы — сведения о нём, а не он сам.`,
  { agentType: 'article-writer', model: 'sonnet', label: 'plan', phase: 'Plan', schema: PLAN },
)
log(`[plan] рисунков запланировано=${plan.figures.length}`)
for (const f of plan.figures) {
  log(`[plan/${f.slug}] «${f.caption}» — после «${f.section}»`)
  log(`[plan/${f.slug}/зачем] ${f.why}`)
}

// --- Draw: one CLI run per figure; the tool owns the drawing, we own the brief --------------

phase('Draw')
let drawn = await agent(
  `Тебе нужно нарисовать ${plan.figures.length} рисунка к статье ${ARTICLE_PATH}.\n\n` +
    `Заглушки в статье:\n` +
    plan.figures.map((f, i) => `${i + 1}. ${f.slug} — «${f.caption}» (раздел «${f.section}»)`).join('\n') +
    `\n\nПо каждому рисунку:\n` +
    `1. Прочитай в статье тот раздел, к которому он относится, и напиши бриф в ` +
    `${WORK_DIR}/brief-<slug>.txt: сущности, что с чем связано, подписи, которые обязаны ` +
    `появиться дословно, и что на картинке быть НЕ должно. Прозой, не обрывками. Обозначения ` +
    `бери из статьи: если в тексте матрица зовётся Q, на рисунке она Q.\n` +
    `   Статья русская, поэтому словесные подписи на рисунке тоже русские, а бриф пиши ` +
    `по-русски. Формулы и имена матриц (X, Q, K, V, W^Q, n × d_k) — как в тексте, они ` +
    `языка не имеют. Держи словесных подписей мало и покороче: генератор картинок рисует ` +
    `кириллицу хуже латиницы, и длинная фраза скорее поедет, чем короткая.\n` +
    `2. Запусти инструмент один раз этой командой, подставив свой bin, слаг и подпись:\n\n` +
    drawCommand('<slug>', '<подпись>') +
    `\n\n3. Инструмент сам называет каталог прогона и пишет туда final_output.png. Скопируй ` +
    `его под имя из заглушки: cp ${WORK_DIR}/run_*/final_output.png ${FIGURES_DIR}/<slug>.png — ` +
    `копируй именно тот прогон, который только что закончился, а не самый новый наугад. ` +
    `Проверь, что файл существует и не пустой.\n` +
    `4. После первого же рисунка открой ${WORK_DIR}/run_*/planning.json и посмотри поле ` +
    `retrieved_examples. Если там пустой список — эталоны не подхватились, значит ` +
    `REFERENCE_SET_PATH не доехал: останови работу и скажи об этом, не рисуй остальные ` +
    `вслепую. Ретривер — половина того, за что этот инструмент взят.\n` +
    `5. Если команда упала — прочитай вывод. Недоступный шлюз, исчерпанная квота и отвергнутый ` +
    `бриф это три разных беды, и только последняя твоя. Один повтор с более коротким и ` +
    `конкретным брифом; не вышло — запиши в failed и переходи к следующему рисунку.\n\n` +
    `Напиши ${MANIFEST_PATH}: по каждому рисунку слаг, подпись, файл, точная команда, каталог ` +
    `прогона, число итераций и кто был критиком. Смысл манифеста в команде: рисунок, который ` +
    `захотят чуть другим, перерисовывается правкой одного брифа и одной строкой.` +
    TOOL_RULES,
  {
    agentType: 'illustrator',
    model: 'sonnet',
    label: 'draw:1',
    phase: 'Draw',
    schema: DRAWN,
  },
)
log(`[draw] нарисовано=${drawn.done.length} провалов=${drawn.failed.length} шлюз_ok=${drawn.gateway_ok}`)
for (const d of drawn.done) {
  log(`[draw/${d.slug}] критик=${d.critic_provider} итераций=${d.iterations} прогон=${d.run_dir}`)
}
for (const f of drawn.failed) log(`[draw/провал] ${f.slug}: ${f.reason}`)

if (!drawn.gateway_ok) {
  // Loud and specific: this is a credential in the OS keychain, not something a prompt fixes.
  log('[draw] ШЛЮЗ НЕ ОТВЕТИЛ: откройте «SS AI Setup» и нажмите Apply, затем повторите прогон')
}

// --- Look and Redraw: our own eyes on the render, then targeted repair ----------------------

const lookTask = (slugs) =>
  `Посмотри на рисунки как читатель статьи ${ARTICLE_PATH}. Файлы: ` +
  slugs.map((s) => `${FIGURES_DIR}/${s}.png`).join(', ') +
  `\n\nОткрой КАЖДЫЙ файл инструментом Read — ты умеешь смотреть картинки — и сверь с ` +
  `подписью и с тем разделом статьи, к которому рисунок относится.\n\n` +
  `По каждому реши, годится ли он в статью как есть. Смотри на: читаются ли подписи; те ли ` +
  `это обозначения, что в тексте; нет ли выдуманных элементов, которых в статье нет; не ` +
  `перевраны ли направления связей; не пустая ли картинка и не каша ли. Опечатки в подписях ` +
  `внутри картинки — это дефект, их видно.\n\n` +
  `Отдельно и придирчиво — КИРИЛЛИЦА. Генераторы картинок её ломают: буквы подменяются, ` +
  `слова превращаются в похожий на русский набор знаков. Прочитай каждую русскую подпись ` +
  `вслух про себя: если это не настоящее слово — дефект, так и напиши, с указанием, какая ` +
  `подпись поехала. Статья с рисунком, где написана бессмыслица, хуже статьи без рисунка.\n\n` +
  `Если для разглядывания мелочей режешь фрагменты — клади их в ${WORK_DIR}, а не в ` +
  `${FIGURES_DIR}: там только то, что уйдёт в статью.

` +
  `Дефекты формулируй так, чтобы их можно было отдать рисовальщику как правку: «стрелка от K ` +
  `к Q нарисована в обратную сторону», а не «непонятно».\n\n` +
  `СНАЧАЛА выпиши в labels_seen каждую надпись с картинки дословно — все, включая мелкие ` +
  `подписи под блоками и на стрелках. Пока не выписал, вердикт не выноси: именно на этом ` +
  `шаге видно то, что при беглом взгляде проскакивает.\n\n` +
  `ЯЗЫК НАДПИСЕЙ. Статья русская, значит словесные надписи на рисунке русские. Латиницей ` +
  `допустимы: обозначения и формулы (X, Q, K, V, W^Q, n × d_k, d_model) и те термины, ` +
  `которые сама статья пишет латиницей — softmax и Attention. Всё остальное по-английски — ` +
  `дефект: «output» вместо «выход», «shape unchanged» вместо «форма не меняется», «Concat» ` +
  `там, где статья говорит о конкатенации. Три рисунка в одной статье обязаны быть на одном ` +
  `языке; разнобой между ними — дефект, даже если каждый по отдельности читается.\n\n` +
  `ТИПОГРАФИКА ОБОЗНАЧЕНИЙ. Индексы обязаны быть индексами: d_k и d_v печатаются как d с ` +
  `маленькой k или v внизу, а не как «d_k» с подчёркиванием посреди строки. Сырое ` +
  `подчёркивание в формуле — дефект, и он особенно заметен, когда на одной картинке рядом ` +
  `стоят обе записи. Проверь каждую размерность по отдельности.`

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
  log(`[redraw/${redraws}] перерисовываем: ${bad.map((c) => c.slug).join(', ')}`)

  const byslug = {}
  for (const d of drawn.done) byslug[d.slug] = d

  const again = await agent(
    `Перерисуй только эти рисунки, остальные не трогай. По каждому — что с ним не так:\n\n` +
      bad
        .map(
          (c, i) =>
            `${i + 1}. ${c.slug} (каталог прогона ${byslug[c.slug] ? byslug[c.slug].run_dir : 'неизвестен'})\n` +
            c.defects.map((d) => `   - ${d}`).join('\n'),
        )
        .join('\n\n') +
      `\n\nУ инструмента для этого есть штатный путь: продолжить существующий прогон и ` +
      `передать замечания его критику. Экспорты и вызов — одним вызовом Bash.\n\n` +
      `${ENV_BLOCK}\n` +
      `<bin> generate --output-dir ${WORK_DIR} --continue-run <каталог прогона> \\\n` +
      `  --auto --max-iterations 2 \\\n` +
      `  --vlm-provider claude_code --vlm-model sonnet \\\n` +
      `  --critic-vlm-provider kimi --critic-vlm-model k3 \\\n` +
      `  --image-provider ss_gateway \\\n` +
      `  --feedback "<замечания по этому рисунку одной строкой>"\n\n` +
      `Если продолжение не сработает — правь бриф ${WORK_DIR}/brief-<slug>.txt по замечаниям ` +
      `и запускай заново обычной командой. Готовый файл снова скопируй в ` +
      `${FIGURES_DIR}/<slug>.png, поверх старого. Обнови ${MANIFEST_PATH}.` +
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
    log(`[redraw/${redraws}/${d.slug}] критик=${d.critic_provider} итераций=${d.iterations}`)
  }
  for (const f of again.failed) log(`[redraw/${redraws}/провал] ${f.slug}: ${f.reason}`)

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
  `Выполни ровно эту команду из корня репозитория и верни её результат без изменений:\n\n` +
    `python -X utf8 tools/gate.py --dir ${FIGURES_DIR} --min-entries ${plan.figures.length + 1}\n\n` +
    `Верни разобранный отчёт полем report и сырой вывод полем stdout. Ничего не исправляй.`,
  { model: 'haiku', label: 'gate', phase: 'Gate', schema: GATE },
)
log(
  `[gate] ok=${gate.report.ok} проблем=${gate.report.problems.length} ` +
    `измерения=${JSON.stringify(gate.report.measures)}`,
)
for (const p of gate.report.problems) log(`[gate/проблема] ${p}`)

// A floor is not enough for a delivery directory. The vision check cropped fragments to look
// at them closely and left four crop_*.png next to the figures; `--min-entries 4` counted
// eight and said ok, so the debris would have shipped with the article.
const expectedEntries = plan.figures.length + 1
const actualEntries = gate.report.measures.entries
if (typeof actualEntries === 'number' && actualEntries !== expectedEntries) {
  log(
    `[gate] ЛИШНЕЕ В ПОСТАВКЕ: файлов ${actualEntries}, ожидалось ${expectedEntries} ` +
      `(${plan.figures.length} рисунка и манифест). Рабочие файлы место в ${WORK_DIR}.`,
  )
}

const stillBad = looked.checks.filter((c) => !c.ok)
if (stillBad.length) {
  // Same rule as the article loop: an unmet verdict goes into the log by name, never silently.
  log(`[итог] НЕ ДОВЕДЕНО до качества: ${stillBad.map((c) => c.slug).join(', ')}`)
  for (const c of stillBad) for (const d of c.defects) log(`[итог/дефект] ${c.slug}: ${d}`)
}

log(
  `[итог] запланировано=${plan.figures.length} нарисовано=${drawn.done.length} ` +
    `перерисовок=${redraws} не_доведено=${stillBad.length} гейт_ok=${gate.report.ok}`,
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
