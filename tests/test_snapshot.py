"""Тесты снимка черновика.

Петля перезаписывает `article.md` каждый круг. Записи кругов хранят вердикты, но не текст, о
котором они вынесены, — и вопрос «что именно изменилось между восьмым и девятым» оставался без
ответа ровно тогда, когда он важнее всего: когда петля перестала сходиться.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest
import snapshot


def run(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    *argv: str,
) -> tuple[dict[str, Any], int]:
    monkeypatch.setattr(sys, "argv", ["snapshot.py", *argv])
    code = snapshot.main()
    report: dict[str, Any] = json.loads(capsys.readouterr().out)
    return report, code


def test_copy_is_byte_for_byte(tmp_path: Path) -> None:
    src = tmp_path / "article.md"
    src.write_text("текст со всеми знаками — и тире, и «ёлочками»\n", encoding="utf-8")
    dst = tmp_path / "rounds" / "draft-1.md"
    copied, problems = snapshot.snapshot(src, dst, overwrite=False)
    assert copied is True
    assert problems == []
    assert dst.read_bytes() == src.read_bytes()


def test_missing_source_is_named(tmp_path: Path) -> None:
    copied, problems = snapshot.snapshot(tmp_path / "нет.md", tmp_path / "к.md", overwrite=False)
    assert copied is False
    assert any("nothing to copy" in p for p in problems)


def test_identical_target_is_not_an_error(tmp_path: Path) -> None:
    """Повтор круга, уже сделавшего снимок, — не сбой и не копия."""
    src = tmp_path / "a.md"
    src.write_text("x", encoding="utf-8")
    dst = tmp_path / "b.md"
    snapshot.snapshot(src, dst, overwrite=False)
    copied, problems = snapshot.snapshot(src, dst, overwrite=False)
    assert copied is False
    assert problems == []


def test_different_target_is_refused(tmp_path: Path) -> None:
    """Молча переписанный снимок уничтожает улику; отказ её лишь не добавляет."""
    src = tmp_path / "a.md"
    src.write_text("новое", encoding="utf-8")
    dst = tmp_path / "b.md"
    dst.write_text("старое", encoding="utf-8")
    copied, problems = snapshot.snapshot(src, dst, overwrite=False)
    assert copied is False
    assert any("different content" in p for p in problems)
    assert dst.read_text(encoding="utf-8") == "старое"


def test_overwrite_is_explicit(tmp_path: Path) -> None:
    src = tmp_path / "a.md"
    src.write_text("новое", encoding="utf-8")
    dst = tmp_path / "b.md"
    dst.write_text("старое", encoding="utf-8")
    copied, problems = snapshot.snapshot(src, dst, overwrite=True)
    assert copied is True
    assert problems == []
    assert dst.read_text(encoding="utf-8") == "новое"


def test_parent_directory_is_created(tmp_path: Path) -> None:
    src = tmp_path / "a.md"
    src.write_text("x", encoding="utf-8")
    dst = tmp_path / "нет" / "такого" / "b.md"
    copied, _ = snapshot.snapshot(src, dst, overwrite=False)
    assert copied is True
    assert dst.is_file()


def test_report_shape_matches_the_gate(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Носильщик несёт одну форму отчёта на все детерминированные проверки."""
    src = tmp_path / "a.md"
    src.write_text("x", encoding="utf-8")
    report, code = run(capsys, monkeypatch, "--file", str(src), "--to", str(tmp_path / "b.md"))
    assert set(report) == {"ok", "problems", "measures"}
    assert report["measures"]["copied"] is True
    assert code == 0


def test_strict_turns_a_refusal_into_a_failure(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, code = run(
        capsys,
        monkeypatch,
        "--file",
        str(tmp_path / "нет.md"),
        "--to",
        str(tmp_path / "b.md"),
        "--strict",
    )
    assert code == 1
