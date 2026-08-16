"""Тесты детерминированного гейта.

Гейт вызывается стадией воркфлоу и его JSON — единственное, на что смотрит скрипт, поэтому
проверяются обе стороны: и формулировки проблем (по ним ветвится петля исправления), и
измерения (по ним ставятся пороги в шаблонах). Формулировки совпадают со старым движком
намеренно: отчёты остаются сравнимыми между двумя реализациями.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import gate
import pytest

WINDOWS_ONLY = pytest.mark.skipif(
    sys.platform != "win32", reason="msys-форма пути существует только рядом с буквой диска"
)


def run(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    *argv: str,
) -> tuple[dict[str, Any], int]:
    """Позвать гейт как из шелла и разобрать его JSON."""
    monkeypatch.setattr(sys, "argv", ["gate.py", *argv])
    code = gate.main()
    printed = capsys.readouterr().out
    report: dict[str, Any] = json.loads(printed)
    return report, code


def msys_form(path: Path) -> str:
    """`C:\\Users\\x\\f.md` → `/c/Users/x/f.md` — то, что Git Bash кладёт в argv."""
    drive, rest = path.as_posix().split(":", 1)
    return f"/{drive.lower()}{rest}"


def write(tmp_path: Path, text: str, name: str = "doc.md") -> Path:
    target = tmp_path / name
    target.write_text(text, encoding="utf-8")
    return target


# --- prose_of: что вычитается из файла, прежде чем считать прозу ---------------------


def test_prose_drops_fenced_block() -> None:
    assert gate.prose_of("текст\n```\nprint(1)\n```\nещё") == "текст\nещё"


def test_prose_drops_html_comment() -> None:
    assert gate.prose_of("до <!-- заметка\nв две строки --> после") == "до  после"


def test_prose_drops_table_rows() -> None:
    """Строки таблицы уходят вместе со своими переводами строки, разрыв абзаца остаётся."""
    text = "шапка\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nхвост"
    assert gate.prose_of(text) == "шапка\n\n\nхвост"


def test_prose_drops_images_but_keeps_link_text() -> None:
    assert gate.prose_of("![подпись](fig.png)") == ""
    assert gate.prose_of("см. [документацию](https://example.com/docs)") == "см. документацию"


def test_prose_drops_heading_and_list_marks() -> None:
    assert gate.prose_of("## Заголовок") == "Заголовок"
    assert gate.prose_of("- пункт\n* второй\n+ третий\n1. нумерованный") == (
        "пункт\nвторой\nтретий\nнумерованный"
    )


def test_prose_drops_backticks_and_emphasis() -> None:
    assert gate.prose_of("вызов `gate.py` и **важное** и _тихое_") == (
        "вызов gate.py и важное и тихое"
    )


def test_prose_trims_around_newlines_and_strips_edges() -> None:
    """Отступы вокруг переводов строки уходят, а пустая строка между абзацами остаётся:
    абзацное деление — часть читаемого текста, и его знаки честно попадают в счёт."""
    assert gate.prose_of("\n\n  первая  \n   \n  вторая  \n\n") == "первая\n\nвторая"


def test_prose_counts_less_than_file() -> None:
    """Тот самый урок: файл несёт разметку, бриф просит читаемый текст."""
    text = "# Заголовок\n\n| a | b |\n|---|---|\n\n```\ncode\n```\n\nОдно предложение."
    assert len(gate.prose_of(text)) < len(text)


# --- --file: измерения и пороги ------------------------------------------------------


def test_file_measures_chars_and_prose(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "# Шапка\n\nРовно одно предложение.")
    report, code = run(capsys, monkeypatch, "--file", str(doc))
    assert report["ok"] is True
    assert report["problems"] == []
    assert report["measures"]["chars"] == len(doc.read_text(encoding="utf-8"))
    assert report["measures"]["prose_chars"] == len("Шапка\n\nРовно одно предложение.")
    assert code == 0


def test_file_missing_is_a_problem_without_measures(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    absent = tmp_path / "нет.md"
    report, code = run(capsys, monkeypatch, "--file", str(absent))
    assert report["ok"] is False
    assert report["problems"] == [f"output missing: {absent}"]
    assert report["measures"] == {}
    assert code == 0


def test_max_length_exceeded_and_met(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "x" * 50)
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--max-length", "10")
    assert report["problems"] == ["max_length 10 exceeded (got 50)"]
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--max-length", "50")
    assert report["ok"] is True


def test_min_length_not_met_and_met(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "x" * 50)
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--min-length", "200")
    assert report["problems"] == ["min_length 200 not met (got 50)"]
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--min-length", "50")
    assert report["ok"] is True


def test_max_prose_exceeded_and_met(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "слово " * 20)
    prose = len(gate.prose_of(doc.read_text(encoding="utf-8")))
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--max-prose", "10")
    assert report["problems"] == [f"max_prose 10 exceeded (got {prose})"]
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--max-prose", str(prose))
    assert report["ok"] is True


def test_min_prose_not_met_matches_probe_wording(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Ровно эта формулировка уехала в промпт круга исправления в живом прогоне."""
    doc = write(tmp_path, "коротко")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--min-prose", "4500")
    assert report["problems"] == ["min_prose 4500 not met (got 7)"]


def test_min_prose_met(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "я" * 100)
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--min-prose", "100")
    assert report["ok"] is True


def test_all_four_length_rules_report_together(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Провалы не короткозамкнуты: агент круга исправления должен видеть все сразу."""
    doc = write(tmp_path, "текст")
    report, _ = run(
        capsys,
        monkeypatch,
        "--file",
        str(doc),
        "--max-length",
        "1",
        "--min-length",
        "99",
        "--max-prose",
        "1",
        "--min-prose",
        "99",
    )
    assert len(report["problems"]) == 4


# --- --forbid ------------------------------------------------------------------------


def test_forbid_reports_count_and_sample(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "стоит отметить раз, стоит отметить два")
    report, _ = run(
        capsys, monkeypatch, "--file", str(doc), "--forbid", "стоит отметить|важно понимать"
    )
    assert report["ok"] is False
    assert report["problems"] == [
        "forbidden pattern matched 2x: стоит отметить|важно понимать (стоит отметить)"
    ]
    assert report["measures"]["regex"] == {"стоит отметить|важно понимать": 2}


def test_forbid_is_case_insensitive(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "Стоит Отметить")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid", "стоит отметить")
    assert report["measures"]["regex"] == {"стоит отметить": 1}


def test_forbid_sample_is_capped_at_three_distinct(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "слово1 слово2 слово3 слово4 слово5")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid", r"слово\d")
    assert report["problems"] == [r"forbidden pattern matched 5x: слово\d (слово1, слово2, слово3)"]


def test_forbid_repeatable_and_independent(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "первое и третье")
    report, _ = run(
        capsys,
        monkeypatch,
        "--file",
        str(doc),
        "--forbid",
        "первое",
        "--forbid",
        "второе",
        "--forbid",
        "третье",
    )
    assert len(report["problems"]) == 2
    assert report["measures"]["regex"] == {"первое": 1, "второе": 0, "третье": 1}


def test_forbid_clean_still_records_zero(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Ноль в measures — доказательство, что правило проверялось, а не пропущено."""
    doc = write(tmp_path, "чистый текст")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid", "стоит отметить")
    assert report["ok"] is True
    assert report["measures"]["regex"] == {"стоит отметить": 0}


def test_no_forbid_means_no_regex_key(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "текст")
    report, _ = run(capsys, monkeypatch, "--file", str(doc))
    assert "regex" not in report["measures"]


# --- --forbid-preset -----------------------------------------------------------------
#
# Именованные наборы существуют, чтобы кириллица не ехала через argv: шелл выбирает агент,
# кодировку выбирает Windows. Поэтому проверяется и то, что набор ловит, и то, что он не
# трогает — ложное срабатывание стоит круга переписывания.


def test_preset_catches_dead_phrase(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "Здесь стоит отметить одну вещь.")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid-preset", "ru_slop")
    assert report["ok"] is False
    assert any("preset ru_slop matched 1x" in p for p in report["problems"])


def test_preset_catches_bold_verbatim(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "обычный текст и **выделенный** кусок")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid-preset", "no_bold")
    assert report["problems"] == [r"preset no_bold matched 1x: \*\*[^\n*]+\*\* (**выделенный**)"]


def test_preset_ignores_python_power_in_a_fenced_block(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Ради этого набор и смотрит вне кода: `d_k ** 0.5` — степень, а не жирный."""
    doc = write(tmp_path, "текст\n```python\nscores = q @ k.T / d_k ** 0.5\n```\nещё текст")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid-preset", "no_bold")
    assert report["ok"] is True


def test_preset_ignores_inline_code(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "в питоне это `x ** 2`, и всё")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid-preset", "no_bold")
    assert report["ok"] is True


def test_preset_keeps_the_authors_own_transition(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """«Давайте разбираться» — живой переход автора, «давайте разберём» — наполнитель."""
    doc = write(tmp_path, "Давайте разбираться. Поехали.")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid-preset", "ru_slop")
    assert report["ok"] is True


def test_preset_catches_emoji(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "Итоги 🚀 впечатляют")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid-preset", "ru_slop")
    assert report["ok"] is False


def test_preset_leaves_arrows_and_check_marks_alone(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Стрелка и галочка — обычная техническая проза, а не эмодзи в заголовке."""
    doc = write(tmp_path, "вход → выход, проверено ✓")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid-preset", "ru_slop")
    assert report["ok"] is True


def test_presets_are_repeatable_and_measured_together(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "**жирно**, и важно понимать почему")
    report, _ = run(
        capsys,
        monkeypatch,
        "--file",
        str(doc),
        "--forbid-preset",
        "ru_slop",
        "--forbid-preset",
        "no_bold",
    )
    assert len(report["problems"]) == 2
    counted = report["measures"]["preset"]
    assert sum(counted.values()) == 2
    assert len(counted) == len(gate.PRESETS["ru_slop"]) + len(gate.PRESETS["no_bold"])


def test_clean_text_still_records_every_preset_pattern(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Нули в measures — доказательство, что набор отработал, а не был пропущен."""
    doc = write(tmp_path, "Обычный текст без штампов.")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--forbid-preset", "ru_slop")
    assert report["ok"] is True
    assert set(report["measures"]["preset"].values()) == {0}


def test_no_preset_means_no_preset_key(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "текст")
    report, _ = run(capsys, monkeypatch, "--file", str(doc))
    assert "preset" not in report["measures"]


def test_unknown_preset_is_rejected_by_the_parser(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Опечатка в имени набора обязана падать, а не тихо ничего не проверять."""
    doc = write(tmp_path, "текст")
    monkeypatch.setattr(sys, "argv", ["gate.py", "--file", str(doc), "--forbid-preset", "ru-slop"])
    with pytest.raises(SystemExit):
        gate.main()


# --- --dir ---------------------------------------------------------------------------


def test_dir_missing(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    absent = tmp_path / "нет"
    report, _ = run(capsys, monkeypatch, "--dir", str(absent))
    assert report["problems"] == [f"output directory missing: {absent}"]
    assert report["measures"] == {}


def test_dir_is_a_file_counts_as_missing(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "текст")
    report, _ = run(capsys, monkeypatch, "--dir", str(doc))
    assert report["problems"] == [f"output directory missing: {doc}"]


def test_dir_empty(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    empty = tmp_path / "пусто"
    empty.mkdir()
    report, _ = run(capsys, monkeypatch, "--dir", str(empty))
    assert report["problems"] == ["output directory has no content"]
    assert report["measures"]["entries"] == 0


def test_dir_empty_with_min_entries_reports_both(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    empty = tmp_path / "пусто"
    empty.mkdir()
    report, _ = run(capsys, monkeypatch, "--dir", str(empty), "--min-entries", "5")
    assert report["problems"] == [
        "output directory has no content",
        "min_entries 5 not met (got 0)",
    ]


def test_min_entries_not_met_matches_old_engine_wording(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    d = tmp_path / "фигуры"
    d.mkdir()
    (d / "fig1.png").write_bytes(b"")
    report, _ = run(capsys, monkeypatch, "--dir", str(d), "--min-entries", "5")
    assert report["problems"] == ["min_entries 5 not met (got 1)"]


def test_min_entries_met(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    d = tmp_path / "фигуры"
    d.mkdir()
    for i in range(5):
        (d / f"fig{i}.png").write_bytes(b"")
    report, _ = run(capsys, monkeypatch, "--dir", str(d), "--min-entries", "5")
    assert report["ok"] is True
    assert report["measures"]["entries"] == 5


def test_entries_counts_direct_children_only(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    d = tmp_path / "каталог"
    (d / "вложенный").mkdir(parents=True)
    (d / "вложенный" / "глубоко.png").write_bytes(b"")
    (d / "рядом.png").write_bytes(b"")
    report, _ = run(capsys, monkeypatch, "--dir", str(d))
    assert report["measures"]["entries"] == 2


def test_file_and_dir_measured_in_one_call(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "текст статьи")
    d = tmp_path / "фигуры"
    d.mkdir()
    (d / "fig.png").write_bytes(b"")
    report, _ = run(capsys, monkeypatch, "--file", str(doc), "--dir", str(d))
    assert report["measures"]["chars"] == 12
    assert report["measures"]["entries"] == 1


def test_no_arguments_at_all_passes_empty(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    report, code = run(capsys, monkeypatch)
    assert report == {"ok": True, "problems": [], "measures": {}}
    assert code == 0


# --- код возврата --------------------------------------------------------------------


def test_failure_exits_zero_by_default(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Ненулевой код агент прочитал бы как «команда сломалась»: вердикт едет в JSON."""
    doc = write(tmp_path, "коротко")
    report, code = run(capsys, monkeypatch, "--file", str(doc), "--min-prose", "999")
    assert report["ok"] is False
    assert code == 0


def test_failure_exits_one_under_strict(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "коротко")
    report, code = run(capsys, monkeypatch, "--file", str(doc), "--min-prose", "999", "--strict")
    assert report["ok"] is False
    assert code == 1


def test_success_exits_zero_under_strict(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "достаточно длинный текст")
    _, code = run(capsys, monkeypatch, "--file", str(doc), "--min-prose", "5", "--strict")
    assert code == 0


def test_output_keeps_cyrillic_readable(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """ensure_ascii=False: замечание уезжает в промпт агента и должно читаться."""
    doc = write(tmp_path, "стоит отметить")
    monkeypatch.setattr(sys, "argv", ["gate.py", "--file", str(doc), "--forbid", "стоит отметить"])
    gate.main()
    assert "стоит отметить" in capsys.readouterr().out


# --- resolve_path: msys-форма пути ---------------------------------------------------


def test_resolve_keeps_existing_path_untouched(tmp_path: Path) -> None:
    doc = write(tmp_path, "текст")
    assert gate.resolve_path(doc) == doc


def test_resolve_leaves_non_msys_missing_path_alone(tmp_path: Path) -> None:
    absent = tmp_path / "нет.md"
    assert gate.resolve_path(absent) == absent


def test_resolve_leaves_msys_path_alone_when_windows_form_also_missing() -> None:
    """Не превращаем «нет файла» в «нет другого файла»: сообщение обязано назвать argv."""
    absent = Path("/c/такого/каталога/нет/doc.md")
    assert gate.resolve_path(absent) == absent


@WINDOWS_ONLY
def test_resolve_finds_file_behind_msys_path(tmp_path: Path) -> None:
    doc = write(tmp_path, "текст")
    assert gate.resolve_path(Path(msys_form(doc))) == doc


@WINDOWS_ONLY
def test_resolve_finds_directory_behind_msys_path(tmp_path: Path) -> None:
    d = tmp_path / "фигуры"
    d.mkdir()
    assert gate.resolve_path(Path(msys_form(d))) == d


@WINDOWS_ONLY
def test_resolve_accepts_uppercase_drive_letter(tmp_path: Path) -> None:
    doc = write(tmp_path, "текст")
    upper = msys_form(doc).replace("/c/", "/C/", 1)
    assert gate.resolve_path(Path(upper)) == doc


@WINDOWS_ONLY
def test_resolve_handles_drive_root() -> None:
    assert gate.resolve_path(Path("/c")) == Path("C:/")


def test_resolve_ignores_multi_letter_first_segment(tmp_path: Path) -> None:
    """Одна буква — диск; `/cygdrive/...` и `/usr/...` под правило не попадают."""
    absent = Path("/cygdrive/c/Users/x/doc.md")
    assert gate.resolve_path(absent) == absent


@WINDOWS_ONLY
def test_gate_measures_file_given_in_msys_form(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Сквозной случай из прогона: gate:1 получил `/c/Users/…/sources.md`."""
    text = "достаточно текста для измерения"
    doc = write(tmp_path, text)
    report, code = run(capsys, monkeypatch, "--file", msys_form(doc), "--min-prose", "5")
    assert report["ok"] is True
    assert report["measures"]["chars"] == len(text)
    assert code == 0


@WINDOWS_ONLY
def test_gate_counts_dir_given_in_msys_form(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    d = tmp_path / "фигуры"
    d.mkdir()
    (d / "fig.png").write_bytes(b"")
    report, _ = run(capsys, monkeypatch, "--dir", msys_form(d), "--min-entries", "1")
    assert report["ok"] is True
    assert report["measures"]["entries"] == 1


def test_missing_msys_file_message_names_the_path_as_given(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    given = "/c/такого/каталога/нет/doc.md"
    report, _ = run(capsys, monkeypatch, "--file", given)
    assert report["problems"] == [f"output missing: {Path(given)}"]


# --- журнал вызовов -------------------------------------------------------------------
#
# Всё, что инструмент измерил, иначе живёт только в `log()` воркфлоу: читаемо, пока за
# прогоном смотрят, и недоступно, когда он кончился. Расписка пишется тем, кто мерил.


def test_log_line_carries_the_call_and_the_verdict(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "текст")
    log = tmp_path / "tools.jsonl"
    run(capsys, monkeypatch, "--file", str(doc), "--max-length", "2", "--log", str(log))
    line = json.loads(log.read_text(encoding="utf-8").strip())
    assert line["tool"] == "gate"
    assert line["ok"] is False
    assert line["measures"]["chars"] == 5
    assert any("max_length" in p for p in line["problems"])
    assert "--max-length" in line["argv"]
    assert line["at"]


def test_log_appends_rather_than_replaces(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "текст")
    log = tmp_path / "tools.jsonl"
    run(capsys, monkeypatch, "--file", str(doc), "--log", str(log))
    run(capsys, monkeypatch, "--file", str(doc), "--log", str(log))
    assert len(log.read_text(encoding="utf-8").strip().splitlines()) == 2


def test_log_holds_no_payload(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Строка обязана остаться читаемой после пятидесяти таких же — содержимое в неё не едет."""
    doc = write(tmp_path, "текст " * 5000)
    log = tmp_path / "tools.jsonl"
    run(capsys, monkeypatch, "--file", str(doc), "--log", str(log))
    assert len(log.read_text(encoding="utf-8")) < 600


def test_without_log_nothing_is_written(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    doc = write(tmp_path, "текст")
    run(capsys, monkeypatch, "--file", str(doc))
    assert list(tmp_path.glob("*.jsonl")) == []


def test_unwritable_log_does_not_fail_the_check(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Потерять прогон из-за нерабочей расписки хуже, чем потерять расписку."""
    doc = write(tmp_path, "текст")
    blocked = tmp_path / "занято"
    blocked.write_text("не каталог", encoding="utf-8")
    report, code = run(
        capsys, monkeypatch, "--file", str(doc), "--log", str(blocked / "tools.jsonl")
    )
    assert report["ok"] is True
    assert code == 0
