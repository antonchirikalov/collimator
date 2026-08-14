// Proof, not inference: is the system prompt behind agentType 'source-finder' the body of
// .claude/agents/source-finder.md that emit_agents.py wrote?
//
// The fingerprint is the marker emit_agents.py inserts after the frontmatter. That exact
// string exists in one file on disk and nowhere else — not in refract's prompt.md, not in any
// plugin agent. An agent that can quote it verbatim is reading our generated file as its
// system prompt. Asking for the first heading of the body as well, because a lucky guess at
// the marker is conceivable while a guess at both is not.

export const meta = {
  name: 'which-file',
  description: 'Доказательство: системный промпт агента — это наш сгенерированный файл',
  phases: [{ title: 'Fingerprint', detail: 'агент цитирует маркер из своего промпта' }],
}

const PROOF = {
  type: 'object',
  required: ['html_comment', 'first_line', 'first_heading', 'sees_marker'],
  properties: {
    html_comment: {
      type: 'string',
      description: 'HTML-комментарий из твоих инструкций дословно; пустая строка, если его нет',
    },
    first_line: { type: 'string', description: 'первая строка твоих инструкций дословно' },
    first_heading: {
      type: 'string',
      description: 'первый заголовок в твоих инструкциях (строка, начинающаяся с ##)',
    },
    sees_marker: { type: 'boolean', description: 'есть ли в инструкциях HTML-комментарий' },
  },
}

phase('Fingerprint')
const proof = await agent(
  'Диагностика, не работа. Ничего не читай на диске и ничего не пиши — отвечай только про ' +
    'СВОИ инструкции, тот текст, который тебе выдан как системный промпт.\n\n' +
    'Есть ли в них HTML-комментарий вида <!-- ... -->? Если да, приведи его дословно. ' +
    'Также приведи дословно первую строку инструкций и первый заголовок уровня ##.',
  {
    agentType: 'source-finder',
    model: 'haiku',
    label: 'fingerprint',
    phase: 'Fingerprint',
    schema: PROOF,
  },
)

log(`[proof] маркер_виден=${proof.sees_marker}`)
log(`[proof] комментарий=«${proof.html_comment}»`)
log(`[proof] первая_строка=«${proof.first_line}»`)
log(`[proof] первый_заголовок=«${proof.first_heading}»`)

return proof
