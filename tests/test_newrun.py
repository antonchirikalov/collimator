"""Тесты именования каталога прогона.

Скрипт воркфлоу не имеет часов — `Date.now()` там недоступен, — поэтому имя каталога приходит
снаружи. Семь запусков одной статьи ушли в один и тот же каталог, и переиспользование с диска
честно подхватило чужой прогон: сравнивать стало нечего.
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime
from pathlib import Path

import newrun
import pytest

WHEN = datetime(2026, 8, 16, 14, 25, 30, tzinfo=UTC)


def test_name_carries_label_and_moment() -> None:
    assert newrun.run_dir("docs-runs", "attention", WHEN) == "docs-runs/attention-20260816-142530"


def test_cyrillic_label_is_transliterated_not_dropped() -> None:
    """Кириллица в пути ломала PowerShell, но выбрасывать метку нельзя.

    Без транслитерации каждый прогон назывался `run-<время>` — имя, не отличающее ничего.
    """
    got = newrun.run_dir("docs-runs", "Внимание в трансформерах", WHEN)
    assert got == "docs-runs/vnimanie-v-transformerah-20260816-142530"
    assert got.isascii()


def test_punctuation_collapses_to_single_dashes() -> None:
    assert newrun.slugify("Solution   Design: v2!!") == "solution-design-v2"


def test_empty_label_still_yields_a_name() -> None:
    assert newrun.slugify("---") == "run"


def test_path_is_posix_even_on_windows() -> None:
    """Обратный слеш уже однажды отправил четырёх искателей работать вхолостую."""
    assert "\\" not in newrun.run_dir("a/b", "c", WHEN)


def test_two_runs_in_the_same_second_collide_and_that_is_visible(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--check` существует ровно чтобы столкновение было отказом, а не тихим наследованием."""
    target = newrun.run_dir(str(tmp_path), "x", datetime.now(tz=UTC))
    Path(target).mkdir(parents=True)
    monkeypatch.setattr(sys, "argv", ["newrun.py", "--base", str(tmp_path), "--label", "x", "--check"])
    monkeypatch.setattr(newrun, "run_dir", lambda *a, **k: target)
    assert newrun.main() == 1
    assert "уже существует" in capsys.readouterr().err
