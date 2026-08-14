"""Тесты чтения записей о кругах правки.

Записи пишет агент, а не код, поэтому формат разбирается терпимо: заголовок и нумерованные
пункты. Но всё, на чём скрипт ветвится — номер круга, вердикты, разделение пунктов по
источнику замечания — обязано разбираться однозначно, иначе восстановление после перезапуска
тихо соврёт про то, сколько кругов уже прошло.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest
import rounds


def run(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    *argv: str,
) -> tuple[dict[str, Any], int]:
    monkeypatch.setattr(sys, "argv", ["rounds.py", *argv])
    code = rounds.main()
    report: dict[str, Any] = json.loads(capsys.readouterr().out)
    return report, code


def write_round(directory: Path, n: int, head: str, items: list[str]) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    body = "\n".join(f"{i + 1}. {item}" for i, item in enumerate(items))
    target = directory / f"round-{n}.md"
    target.write_text(f"{head}\n\n{body}\n", encoding="utf-8")
    return target


# --- пустое и отсутствующее -----------------------------------------------------------


def test_missing_directory_is_not_a_problem(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Первый прогон записей не имеет — это норма, а не поломка."""
    report, code = run(capsys, monkeypatch, "--dir", str(tmp_path / "нет"))
    assert report["ok"] is True
    assert report["rounds"] == []
    assert report["measures"] == {"rounds": 0, "last_round": 0}
    assert code == 0


def test_directory_without_records_reads_as_empty(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "заметка.txt").write_text("не запись", encoding="utf-8")
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert report["ok"] is True
    assert report["measures"]["last_round"] == 0


# --- разбор одной записи --------------------------------------------------------------


def test_verdicts_come_from_the_heading(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    write_round(tmp_path, 1, "Round 1 — verdict=revise style=ok", ["пример не сходится"])
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    one = report["rounds"][0]
    assert one["round"] == 1
    assert one["verdict"] == "revise"
    assert one["style_verdict"] == "ok"


def test_items_split_by_who_said_them(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Три источника замечаний — три списка, как их и подаёт петля обратно писателю."""
    write_round(
        tmp_path,
        1,
        "Round 1 — verdict=revise style=revise",
        [
            "матрицы перепутаны местами",
            "Style: «кейсы разбираются» — страдательный залог → разбирайте кейсы",
            "Gate: max_prose 30000 exceeded (got 35668)",
            "число 64 названо без последствия",
        ],
    )
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    one = report["rounds"][0]
    assert one["remarks"] == ["матрицы перепутаны местами", "число 64 названо без последствия"]
    assert one["style"] == ["«кейсы разбираются» — страдательный залог → разбирайте кейсы"]
    assert one["gate"] == ["max_prose 30000 exceeded (got 35668)"]


def test_missing_verdict_in_heading_is_named_not_guessed(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    write_round(tmp_path, 1, "Круг первый", ["замечание"])
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert report["rounds"][0]["verdict"] == "unknown"
    assert report["rounds"][0]["style_verdict"] == "unknown"


def test_items_keep_their_order(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    items = [f"замечание {i}" for i in range(1, 8)]
    write_round(tmp_path, 1, "Round 1 — verdict=revise style=revise", items)
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert report["rounds"][0]["remarks"] == items


def test_multiline_item_keeps_only_its_first_line() -> None:
    """Пункт занимает строку: перенос — это уже пересказ, а пересказ петле подавать нельзя."""
    text = "Round 1 — verdict=revise style=ok\n\n1. первая строка\n   продолжение\n2. второй\n"
    assert ITEMS_OF(text) == ["первая строка", "второй"]


def ITEMS_OF(text: str) -> list[str]:
    return rounds.ITEM.findall(text)


# --- несколько записей ----------------------------------------------------------------


def test_rounds_sorted_by_number_not_by_filename(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`round-10.md` идёт после `round-9.md`, а не между 1 и 2."""
    for n in (1, 2, 9, 10):
        write_round(tmp_path, n, f"Round {n} — verdict=revise style=revise", ["x"])
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert [r["round"] for r in report["rounds"]] == [1, 2, 9, 10]


def test_last_round_is_the_highest(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    write_round(tmp_path, 1, "Round 1 — verdict=revise style=revise", ["x"])
    write_round(tmp_path, 2, "Round 2 — verdict=ok style=ok", [])
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert report["measures"] == {"rounds": 2, "last_round": 2}


def test_a_gap_in_the_records_is_reported(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Пропущенная запись — потерянный круг; продолжать с максимума значит скрыть потерю."""
    write_round(tmp_path, 1, "Round 1 — verdict=revise style=revise", ["x"])
    write_round(tmp_path, 3, "Round 3 — verdict=revise style=revise", ["y"])
    report, code = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert report["ok"] is False
    assert any("not consecutive" in p for p in report["problems"])
    assert code == 0


def test_strict_makes_a_broken_record_fail_the_process(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    write_round(tmp_path, 2, "Round 2 — verdict=ok style=ok", ["x"])
    _, code = run(capsys, monkeypatch, "--dir", str(tmp_path), "--strict")
    assert code == 1


def test_empty_round_record_is_a_real_round_with_no_remarks(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Круг, на котором обоим критикам нечего сказать, тоже круг — он потрачен."""
    write_round(tmp_path, 1, "Round 1 — verdict=ok style=ok", [])
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert report["measures"]["last_round"] == 1
    assert report["rounds"][0]["remarks"] == []


# --- --last-only: границы канала через агента -----------------------------------------


def test_last_only_emits_one_round_but_counts_all(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Вывод едет обратно через агента, а у агента есть бюджет.

    Пять кругов дословных замечаний — около сотни килобайт JSON; носильщик вернул два круга
    вместо пяти, скрипт прочитал это как «пройдено два» и прогнал четыре круга вместо одного.
    Счётчики обязаны остаться полными, текст — только у последнего круга.
    """
    for n in (1, 2, 3, 4, 5):
        write_round(tmp_path, n, f"Round {n} — verdict=revise style=revise", [f"замечание {n}"])
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path), "--last-only")
    assert report["measures"] == {"rounds": 5, "last_round": 5}
    assert len(report["rounds"]) == 1
    assert report["rounds"][0]["round"] == 5
    assert report["rounds"][0]["remarks"] == ["замечание 5"]


def test_last_only_on_empty_directory_emits_nothing(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path), "--last-only")
    assert report["rounds"] == []
    assert report["measures"]["last_round"] == 0


def test_last_only_keeps_reporting_a_gap(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Урезанный вывод не должен прятать потерянную запись — иначе круг пропадёт молча."""
    write_round(tmp_path, 1, "Round 1 — verdict=revise style=revise", ["x"])
    write_round(tmp_path, 3, "Round 3 — verdict=revise style=revise", ["y"])
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path), "--last-only")
    assert report["ok"] is False
    assert any("not consecutive" in p for p in report["problems"])


def test_full_output_is_still_the_default(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    for n in (1, 2, 3):
        write_round(tmp_path, n, f"Round {n} — verdict=ok style=ok", ["x"])
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert len(report["rounds"]) == 3
