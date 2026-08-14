// Same fingerprint proof as which-file.js, for every agent the pipeline used. The marker that
// emit_agents.py writes after the frontmatter exists in exactly one file per agent and nowhere
// else, so an agent quoting it verbatim is reading our generated definition as its system
// prompt. agentType in the run metadata only proves which name was requested; this proves
// which file answered.

export const meta = {
  name: 'which-file-all',
  description: 'Отпечаток каждого агента конвейера: его промпт — наш сгенерированный файл?',
  phases: [{ title: 'Fingerprint', detail: 'по одному дешёвому агенту на определение' }],
}

const AGENTS = ['source-finder', 'domain-analyst', 'article-writer', 'article-critic']

const PROOF = {
  type: 'object',
  required: ['html_comment', 'first_line', 'tools'],
  properties: {
    html_comment: {
      type: 'string',
      description: 'HTML-комментарий из твоих инструкций дословно; пустая строка, если его нет',
    },
    first_line: { type: 'string', description: 'первая строка инструкций после комментария' },
    tools: { type: 'array', items: { type: 'string' }, description: 'доступные тебе инструменты' },
  },
}

phase('Fingerprint')
const proofs = await parallel(
  AGENTS.map((name) => () =>
    agent(
      'Диагностика, не работа. Ничего не читай на диске и ничего не пиши — отвечай только про ' +
        'СВОИ инструкции, тот текст, который выдан тебе как системный промпт.\n\n' +
        'Приведи дословно HTML-комментарий вида <!-- ... -->, если он там есть; первую строку ' +
        'инструкций после него; и список доступных тебе инструментов.',
      { agentType: name, model: 'haiku', label: `fp:${name}`, phase: 'Fingerprint', schema: PROOF },
    ),
  ),
)

const report = []
for (let i = 0; i < AGENTS.length; i++) {
  const name = AGENTS[i]
  const p = proofs[i]
  if (!p) {
    log(`[fp/${name}] агент не ответил`)
    continue
  }
  const expected = `library/agents/${name.replace(/-/g, '_')}/`
  const match = p.html_comment.includes(expected)
  log(`[fp/${name}] маркер_наш=${match} инструменты=${p.tools.join(', ')}`)
  log(`[fp/${name}] комментарий=«${p.html_comment}»`)
  log(`[fp/${name}] первая_строка=«${p.first_line.slice(0, 120)}»`)
  report.push({ name, match, comment: p.html_comment, tools: p.tools })
}

return { report, all_ours: report.length === AGENTS.length && report.every((r) => r.match) }
