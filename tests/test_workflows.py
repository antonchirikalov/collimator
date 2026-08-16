"""Инварианты скриптов воркфлоу и сгенерированных агентов.

Всё, что здесь проверяется, оплачено живым прогоном. Проверки объективные и повторяемые:
утверждение «хардкода нет» стоит ровно столько, сколько стоит способ его перепроверить через
месяц.

Тесты читают `.claude/`, то есть **сгенерированное**. Это намеренно: рантайм грузит именно эти
файлы, и вопрос «а совпадает ли собранное с источником» здесь не задаётся — на него отвечает
`test_emit_agents`.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".claude" / "workflows"
AGENTS = ROOT / ".claude" / "agents"

AGENT_TYPE = re.compile(r"agentType:\s*'([a-z0-9-]+)'")
COMMENT_LINE = re.compile(r"^\s*//")

# Слова предметной области, которые уже утекали в промпты агентов. Список — растяжка, а не
# определение: он ловит ровно тот случай, который случился (примеры из статьи про внимание,
# оставшиеся в инструкции агента общего назначения), и пополняется, когда утечёт что-то ещё.
SUBJECT_WORDS = re.compile(
    r"attention|softmax|transformer|трансформер|d_k\b|d_model|QK\^?T|токенизац",
    re.IGNORECASE,
)

# Агенты конвейера статьи. Именно они обязаны быть безразличны к теме: один и тот же писатель
# пишет и про внимание, и про счета-фактуры.
PIPELINE_AGENTS = [
    "brief-writer",
    "source-finder",
    "domain-analyst",
    "article-writer",
    "example-verifier",
    "article-fact-checker",
    "article-critic",
    "style-critic-ru",
    "gate-runner",
    "verbatim-writer",
]


def workflow_scripts() -> list[Path]:
    return sorted(WORKFLOWS.glob("*.js"))


def agent_files() -> list[Path]:
    return sorted(AGENTS.glob("*.md"))


def frontmatter(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n"), f"{path.name}: файл не начинается с фронтматтера"
    parsed: dict[str, object] = yaml.safe_load(text.split("---\n", 2)[1])
    return parsed


def code_lines(path: Path) -> list[str]:
    """Строки скрипта без комментариев — то, что реально исполняется."""
    return [
        ln for ln in path.read_text(encoding="utf-8").splitlines() if not COMMENT_LINE.match(ln)
    ]


# --- управляющие символы --------------------------------------------------------------


@pytest.mark.parametrize("script", workflow_scripts(), ids=lambda p: p.name)
def test_no_control_characters(script: Path) -> None:
    """CR и NUL в скрипте — отказ запуска, а не косметика.

    Рантайм отвечает «script contains control characters that would be hidden in the approval
    dialog» и не стартует. За один день это случилось дважды: `autocrlf` вернул CRLF после
    checkout, и `\\u0000` в исходнике патча записался настоящим нулевым байтом, сделав скрипт
    бинарным. Обе поломки молчаливые до самого запуска.
    """
    raw = script.read_bytes()
    bad = sorted({c for c in raw if c < 32 and c not in (9, 10)})
    assert not bad, f"{script.name}: управляющие символы {bad} (13 — это CR, конец строки CRLF)"


# --- агенты, которых зовёт скрипт -----------------------------------------------------


@pytest.mark.parametrize("script", workflow_scripts(), ids=lambda p: p.name)
def test_every_agent_type_has_a_definition(script: Path) -> None:
    """`agentType` без файла — падение прогона на первой же секунде.

    Рантайм резолвит агента из `.claude/agents/`, и опечатка в имени видна только в живом
    запуске: `agent type 'brief-writer' not found`.
    """
    wanted = sorted(set(AGENT_TYPE.findall(script.read_text(encoding="utf-8"))))
    missing = [name for name in wanted if not (AGENTS / f"{name}.md").is_file()]
    assert not missing, f"{script.name}: нет определений для {missing}"


@pytest.mark.parametrize("agent", agent_files(), ids=lambda p: p.name)
def test_agent_name_matches_its_filename(agent: Path) -> None:
    """Имя во фронтматтере и имя файла — одно и то же, иначе рантайм агента не найдёт.

    Проверка нужна и против опечатки, и против порчи файла: четыре случайных символа,
    попавшие перед `---`, перестают быть фронтматтером, и агент молча исчезает из реестра.
    """
    head = frontmatter(agent)
    assert head.get("name") == agent.stem, f"{agent.name}: name={head.get('name')!r}"
    assert str(head.get("tools", "")).strip(), f"{agent.name}: пустой список инструментов"


# --- независимость от прогона и от темы -----------------------------------------------


@pytest.mark.parametrize("script", workflow_scripts(), ids=lambda p: p.name)
def test_no_run_directory_in_executable_code(script: Path) -> None:
    """Каталог прогона приходит через `args`, а не живёт в скрипте.

    В комментариях и в тексте ошибки пример пути допустим — он объясняет, что передавать.
    В исполняемой строке путь означает, что скрипт умеет ровно один прогон.
    """
    offenders = [
        ln.strip()
        for ln in code_lines(script)
        if re.search(r"probe-runs/|docs-runs/", ln) and "Error(" not in ln
    ]
    assert not offenders, f"{script.name}: каталог прогона в коде: {offenders[:3]}"


@pytest.mark.parametrize("name", PIPELINE_AGENTS)
def test_pipeline_agent_prompt_is_subject_neutral(name: str) -> None:
    """Один и тот же писатель пишет и про внимание, и про счета-фактуры.

    Пример из предметной области, оставленный в инструкции агента общего назначения, не
    ломает ничего заметно — он просто тянет следующую статью к предыдущей теме. В библиотеке
    таких следов было четыре: `QK^T` как образец жирной метки, `h = 8, d_model = 512` как
    образец числа без следствия, «How attention works» как образец плохой пары аспектов и слаг
    `x-to-qkv` в примере заглушки рисунка.

    Исключение — словарь целевого языка у стилевого критика: штампы, которые он ищет, обязаны
    быть на языке статьи. Но и они не про предметную область.
    """
    path = AGENTS / f"{name}.md"
    if not path.is_file():
        pytest.skip(f"{name} ещё не собран")
    hits = SUBJECT_WORDS.findall(path.read_text(encoding="utf-8"))
    assert not hits, f"{name}: предметная область в промпте: {sorted(set(hits))}"


def test_voice_profile_default_exists() -> None:
    """Путь по умолчанию для профиля голоса указывает на файл, который есть.

    `voicePath` можно переопределить и можно занулить, но умолчание, указывающее в пустоту,
    даст писателю порт с несуществующим файлом и ни одной ошибки.
    """
    script = (WORKFLOWS / "explainer-article.js").read_text(encoding="utf-8")
    match = re.search(r"cfg\.voicePath === undefined \? '([^']+)'", script)
    assert match, "умолчание voicePath не найдено — тест устарел вместе со скриптом"
    assert (ROOT / match.group(1)).is_file(), f"нет файла профиля голоса: {match.group(1)}"
