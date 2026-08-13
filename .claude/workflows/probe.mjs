// Пробник этапа 0. Написан руками, живёт до заполнения docs/probe-findings.md и потом
// удаляется. Одним прогоном снимает семь неизвестных, от которых зависит устройство
// генератора; что делать, если какое-то не подтвердится, записано в docs/handoff.md.
//
//   1. сохранённый скрипт, написанный нами, запускается как /probe
//   2. agentType подхватывает определение из .claude/agents/
//   3. агент воркфлоу дотягивается до Tavily MCP
//   4. агент пишет артефакт в каталог прогона, скрипт получает путь схемой
//   5. гейт работает отдельной стадией через tools/gate.py
//   6. петля гейт-ретрая с инжекцией замечаний доводит артефакт
//   7. каталог прогона приходит через args
//
// Ограничения рантайма, которые здесь соблюдены: meta — чистый литерал; ни одного import;
// ни Date.now, ни Math.random; сам скрипт файлов не открывает — только адресует.

export const meta = {
  name: 'probe',
  description: 'Проверка: наш агент, Tavily MCP, артефакты на диске, гейт отдельной стадией',
  phases: [
    { title: 'Research', detail: 'ресерчер ищет через Tavily и пишет файл' },
    { title: 'Gate', detail: 'детерминированная проверка через tools/gate.py' },
    { title: 'Expand', detail: 'круг исправления по замечаниям гейта' },
  ],
}

// Каталог прогона обязателен: Date.now() в скрипте недоступен, метку времени даёт вызов.
const run = typeof args === 'string' ? args : args && args.runDir
if (!run) {
  throw new Error('нужен каталог прогона: /probe probe-runs/<метка> (или args.runDir)')
}
const topic =
  (args && args.topic) ||
  'чем dynamic workflows в Claude Code отличаются от subagents и agent teams'

// Порог заведомо выше того, что даст первая запись: круг исправления должен сработать,
// иначе пункт 6 останется непроверенным.
const MIN_PROSE = 2500

const SOURCES = {
  type: 'object',
  required: ['path', 'sources', 'tool_used'],
  properties: {
    path: { type: 'string', description: 'путь к записанному файлу' },
    sources: {
      type: 'array',
      minItems: 3,
      items: {
        type: 'object',
        required: ['title', 'url'],
        properties: { title: { type: 'string' }, url: { type: 'string' } },
      },
    },
    tool_used: {
      type: 'string',
      description: 'точное имя инструмента поиска, как оно выглядит в вызове',
    },
  },
}

const GATE = {
  type: 'object',
  required: ['ok', 'problems', 'measures'],
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
    measures: { type: 'object' },
  },
}

function gateCmd(path) {
  return (
    'Выполни ровно эту команду из корня репозитория и верни её JSON без изменений, ' +
    'ничего не добавляя и не исправляя:\n\n' +
    `python -X utf8 tools/gate.py --file ${path} ` +
    `--min-prose ${MIN_PROSE} --min-length 200 ` +
    '--forbid "стоит отметить|важно понимать"'
  )
}

phase('Research')
let doc = await agent(
  `Тема: «${topic}».\n\n` +
    `Найди три источника через Tavily и запиши их в ${run}/sources.md по формату из ` +
    'твоих инструкций. Каталог создай, если его нет.\n\n' +
    'Верни путь к файлу, три источника и точное имя инструмента, которым искал.',
  { agentType: 'probe-researcher', label: 'research', phase: 'Research', schema: SOURCES },
)
log(`ресерчер: ${doc.sources.length} источников, инструмент поиска: ${doc.tool_used}`)

phase('Gate')
let gate = await agent(gateCmd(doc.path), {
  model: 'haiku',
  label: 'gate:1',
  phase: 'Gate',
  schema: GATE,
})
log(`гейт 1: ok=${gate.ok} | ${gate.problems.join('; ')} | ${JSON.stringify(gate.measures)}`)

let rounds = 1
if (!gate.ok) {
  phase('Expand')
  await agent(
    `Гейт не пройден: ${gate.problems.join('; ')}.\n\n` +
      `Расширь ${doc.path}: добавь по каждому источнику разбор того, что в нём есть по ` +
      'теме — факты, числа, формулировки. Не добавляй воды и не трогай уже написанные ' +
      'адреса. Верни тот же путь, те же три источника и то же имя инструмента.',
    { agentType: 'probe-researcher', label: 'expand', phase: 'Expand', schema: SOURCES },
  )
  gate = await agent(gateCmd(doc.path), {
    model: 'haiku',
    label: 'gate:2',
    phase: 'Expand',
    schema: GATE,
  })
  rounds = 2
  log(`гейт 2: ok=${gate.ok} | ${gate.problems.join('; ')} | ${JSON.stringify(gate.measures)}`)
}

return {
  path: doc.path,
  tool_used: doc.tool_used,
  sources: doc.sources.length,
  gate_ok: gate.ok,
  gate_rounds: rounds,
  measures: gate.measures,
}
