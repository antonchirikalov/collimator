// Один вопрос, ноль агентов: сканирует ли .claude/workflows расширение .js.
// Пара к tools-probe.mjs, у которого расширение .mjs и который в реестре не появился.
// Проверять в СВЕЖЕЙ сессии: если /ext-js есть, а /tools-probe нет — дело в расширении,
// и обёртки-скиллы из emit_commands.py не нужны.

export const meta = {
  name: 'ext-js',
  description: 'Сканируется ли расширение .js в .claude/workflows',
  phases: [],
}

log('скрипт с расширением .js запустился')
return { extension: 'js', registered: true }
