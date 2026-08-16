"""Тесты перечисления каталога.

Перечисление — единственный способ для скрипта узнать про файлы, имена которых он не мог
придумать заранее. Всё, на чём он потом ветвится, обязано быть предсказуемым: форма пути,
порядок, отсев по расширению.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import listing
import pytest


def run(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    *argv: str,
) -> tuple[dict[str, Any], int]:
    monkeypatch.setattr(sys, "argv", ["listing.py", *argv])
    code = listing.main()
    report: dict[str, Any] = json.loads(capsys.readouterr().out)
    return report, code


def test_missing_directory_is_a_problem(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    report, code = run(capsys, monkeypatch, "--dir", str(tmp_path / "нет"))
    assert report["ok"] is False
    assert report["files"] == []
    assert code == 0


def test_lists_only_the_named_suffix(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "a.md").write_text("x", encoding="utf-8")
    (tmp_path / "b.json").write_text("{}", encoding="utf-8")
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert [Path(f).name for f in report["files"]] == ["a.md"]


def test_empty_ext_keeps_everything(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "a.md").write_text("x", encoding="utf-8")
    (tmp_path / "b.json").write_text("{}", encoding="utf-8")
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path), "--ext", "")
    assert len(report["files"]) == 2


def test_exclude_is_repeatable(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    for name in ("a.md", "b.md", "c.md"):
        (tmp_path / name).write_text("x", encoding="utf-8")
    report, _ = run(
        capsys, monkeypatch, "--dir", str(tmp_path), "--exclude", "a.md", "--exclude", "c.md"
    )
    assert [Path(f).name for f in report["files"]] == ["b.md"]


def test_order_is_stable(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Скрипт сопоставляет результаты по индексу — порядок обязан быть один и тот же."""
    for name in ("c.md", "a.md", "b.md"):
        (tmp_path / name).write_text("x", encoding="utf-8")
    first, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    second, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert first["files"] == second["files"]
    assert [Path(f).name for f in first["files"]] == ["a.md", "b.md", "c.md"]


def test_directories_are_not_listed(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "вложенный.md").mkdir()
    (tmp_path / "файл.md").write_text("x", encoding="utf-8")
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert [Path(f).name for f in report["files"]] == ["файл.md"]


def test_paths_use_forward_slashes(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Обратный слеш — тот самый рассинхрон, который однажды отправил искателей работать зря."""
    (tmp_path / "a.md").write_text("x", encoding="utf-8")
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert "\\" not in report["files"][0]


# --- рекурсия: для итоговой ревизии каталога прогона -----------------------------------


def test_recursive_walks_subdirectories(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "верх.md").write_text("x", encoding="utf-8")
    nested = tmp_path / "sources" / "aspect"
    nested.mkdir(parents=True)
    (nested / "низ.md").write_text("x", encoding="utf-8")
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path), "--recursive")
    # Сортировка по полному пути, а не по имени: `sources/aspect/низ.md` идёт раньше `верх.md`.
    # Ревизия сравнивает множества, порядок ей безразличен — важно, что он воспроизводим.
    assert {Path(f).name for f in report["files"]} == {"верх.md", "низ.md"}
    assert report["files"] == sorted(report["files"])


def test_without_recursive_only_the_top_level(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "верх.md").write_text("x", encoding="utf-8")
    nested = tmp_path / "sources"
    nested.mkdir()
    (nested / "низ.md").write_text("x", encoding="utf-8")
    report, _ = run(capsys, monkeypatch, "--dir", str(tmp_path))
    assert [Path(f).name for f in report["files"]] == ["верх.md"]


def test_recursive_keeps_the_exclusion_by_name(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    nested = tmp_path / "a"
    nested.mkdir()
    (nested / "нужен.md").write_text("x", encoding="utf-8")
    (nested / "лишний.md").write_text("x", encoding="utf-8")
    report, _ = run(
        capsys, monkeypatch, "--dir", str(tmp_path), "--recursive", "--exclude", "лишний.md"
    )
    assert [Path(f).name for f in report["files"]] == ["нужен.md"]
