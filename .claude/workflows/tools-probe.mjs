// Один вопрос: поднимается ли СГЕНЕРИРОВАННОЕ определение агента и приезжают ли к нему
// инструменты, объявленные его фронтматтером. Файл .claude/agents/source-finder.md написан
// не руками, а emit_agents.py из library/agents/source_finder/.
//
// Задача агенту нарочно диагностическая, а не по его специальности: нужен не результат
// поиска, а факт, что инструмент из фронтматтера вызывается.

export const meta = {
  name: 'tools-probe',
  description: 'Сгенерированное определение агента: поднимается ли и с какими инструментами',
  phases: [{ title: 'Tools', detail: 'агент перечисляет свои инструменты и зовёт один MCP' }],
}

const SEEN = {
  type: 'object',
  required: ['tools', 'mcp_call', 'mcp_ok'],
  properties: {
    tools: {
      type: 'array',
      items: { type: 'string' },
      description: 'имена ВСЕХ доступных тебе инструментов, как они выглядят в вызове',
    },
    mcp_call: { type: 'string', description: 'точное имя вызванного инструмента MCP' },
    mcp_ok: { type: 'boolean', description: 'вернул ли он результат' },
  },
}

phase('Tools')
const seen = await agent(
  'Диагностика оснастки, не исследование. Сделай два дела.\n\n' +
    '1. Перечисли имена всех инструментов, которые тебе доступны, ровно как они выглядят ' +
    'в вызове.\n' +
    '2. Позови поиск Tavily с запросом «collimator optics» один раз и скажи, вернул ли он ' +
    'результат. Файлов не пиши, ничего не сохраняй.',
  { agentType: 'source-finder', label: 'generated-agent', phase: 'Tools', schema: SEEN },
)

log(`инструментов видно: ${seen.tools.length} | MCP: ${seen.mcp_call} ok=${seen.mcp_ok}`)
log(`список: ${seen.tools.join(', ')}`)

return { tools: seen.tools, mcp_call: seen.mcp_call, mcp_ok: seen.mcp_ok }
