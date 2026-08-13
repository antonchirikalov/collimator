# collimator

Компилятор декларативных конвейеров подготовки документов в Dynamic Workflows для Claude
Code. На входе `pipeline.yaml`, на выходе скрипт оркестрации и определения подагентов.

Коллиматор сводит рассеянные лучи в один параллельный пучок: из одной декларации получается
параллельный фан-аут агентов.

```bash
collimate build library/templates/explainer_article.yaml \
    --workflows .claude/workflows/ --agents .claude/agents/
```

Инструмент **не исполняет** агентов — их запускает Claude Code. Здесь нет планировщика,
леджера и восстановления после сбоя: это делает платформа.

Состояние: этап 0, проверка допущений. См. `docs/plan.md` и `docs/handoff.md`.
