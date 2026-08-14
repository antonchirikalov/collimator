// One question before the real run: which definition answers to the agent type
// `article-critic`. The name collided with a user-level agent in ~/.claude/agents, which
// was renamed to `ru-style-critic`; this confirms the generated project-level definition
// now holds the name.
//
// The tool list is the objective discriminator: the generated critic gets Read, Write, Edit
// from its contract, while the user-level style critic also had Grep, Glob and Bash.

export const meta = {
  name: 'critic-check',
  description: 'Кто отвечает на имя article-critic: наш критик механизма или критик прозы',
  phases: [{ title: 'Check', detail: 'один дешёвый агент называет свои инструменты и задачу' }],
}

const WHO = {
  type: 'object',
  required: ['tools', 'judges', 'language_of_instructions'],
  properties: {
    tools: {
      type: 'array',
      items: { type: 'string' },
      description: 'имена всех доступных тебе инструментов, ровно как они выглядят в вызове',
    },
    judges: {
      type: 'string',
      description: 'одной фразой: что именно тебе велено оценивать твоими инструкциями',
    },
    language_of_instructions: {
      type: 'string',
      description: 'на каком языке написаны твои инструкции: русский или английский',
    },
  },
}

phase('Check')
const who = await agent(
  'Диагностика оснастки, не работа по специальности. Ничего не читай и не пиши. ' +
    'Ответь три вещи: какие инструменты тебе доступны, что тебе велено оценивать твоими ' +
    'инструкциями и на каком языке эти инструкции написаны.',
  { agentType: 'article-critic', model: 'haiku', label: 'who', phase: 'Check', schema: WHO },
)

log(`[who] инструменты=${who.tools.join(', ')}`)
log(`[who] оценивает=«${who.judges}»`)
log(`[who] язык_инструкций=${who.language_of_instructions}`)

return who
