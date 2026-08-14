// Which artifact names may a workflow agent write? A `Write` to `<run>/analysis.md` was
// refused four times across three runs with:
//
//   Subagents should return findings as text, not write report files.
//   Include this content in your final response instead.
//
// while `sources/formula.md`, `article.md` and `UNRESOLVED.md` in the same directory went
// through. So the veto is not about markdown, and it is not the agent's choice — it is a
// platform rule the generator has to know about, because it decides what emit_workflow may
// name a port's file.
//
// One agent, one attempt per candidate name, identical trivial content. Whatever comes back
// is the rule.

export const meta = {
  name: 'name-probe',
  description: 'Какие имена файлов агенту разрешено писать, а какие платформа запрещает',
  phases: [{ title: 'Names', detail: 'по одной записи на имя, отказы записываются дословно' }],
}

const run = (args && args.runDir) || 'probe-runs/names'

const NAMES = [
  'analysis.md',
  'analysis-notes.md',
  'material.md',
  'report.md',
  'findings.md',
  'summary.md',
  'svodka.md',
  'analysis.txt',
  'sources/analysis.md',
]

const RESULT = {
  type: 'object',
  required: ['attempts'],
  properties: {
    attempts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'written', 'error'],
        properties: {
          name: { type: 'string' },
          written: { type: 'boolean', description: 'вызов Write прошёл' },
          error: { type: 'string', description: 'текст отказа дословно, иначе пустая строка' },
        },
      },
    },
  },
}

phase('Names')
const result = await agent(
  `Проверка политики записи, не работа по специальности. Тебе нужно выяснить, какие имена ` +
    `файлов тебе разрешено создавать.\n\n` +
    `Для КАЖДОГО имени из списка попробуй записать файл ${run}/<имя> инструментом Write с ` +
    `содержимым «проба записи» и запомни, что произошло. Если Write отказал — приведи текст ` +
    `отказа дословно и переходи к следующему имени, не пытаясь обойти запрет другим ` +
    `инструментом. Пройди ВСЕ имена, даже если первое же отказало.\n\n` +
    `Имена:\n${NAMES.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\n` +
    `Верни по одному элементу на имя: имя, прошла ли запись, текст отказа.`,
  { model: 'haiku', label: 'names', phase: 'Names', schema: RESULT },
)

for (const a of result.attempts) {
  log(`[name] ${a.written ? 'МОЖНО ' : 'ЗАПРЕТ'} ${a.name}${a.error ? ' | ' + a.error : ''}`)
}

return result
