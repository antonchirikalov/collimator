"""Тесты дворника: он ходит по корню репозитория, поэтому ошибиться ему нельзя.

Проверяется ровно то, чего от него боишься: что он не тронет рабочий каталог, не удалит
каталог, в котором лежит хоть один файл, и что `--dry-run` действительно ничего не сносит.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import sweep_junk


def make_root(tmp_path: Path) -> Path:
    """Слепок корня: свои каталоги, посторонний пустой и посторонний с файлом."""
    (tmp_path / "collimator").mkdir()
    (tmp_path / "tools").mkdir()
    (tmp_path / "probe-runs" / "attn").mkdir(parents=True)
    (tmp_path / "probe-runs" / "attn" / "article.md").write_text("текст", encoding="utf-8")
    (tmp_path / "OF_PROCESSORS=16").mkdir()
    (tmp_path / "ৠ翹").mkdir()
    (tmp_path / "Shell" / "v1.0").mkdir(parents=True)
    (tmp_path / "важное").mkdir()
    (tmp_path / "важное" / "файл.txt").write_text("не удалять", encoding="utf-8")
    (tmp_path / "README.md").write_text("файл в корне", encoding="utf-8")
    return tmp_path


def test_splits_empty_from_occupied(tmp_path: Path) -> None:
    empty, occupied = sweep_junk.strays(make_root(tmp_path))
    assert {p.name for p in empty} == {"OF_PROCESSORS=16", "ৠ翹", "Shell"}
    assert {p.name for p in occupied} == {"важное"}


def test_keeps_the_repository_own_directories(tmp_path: Path) -> None:
    empty, occupied = sweep_junk.strays(make_root(tmp_path))
    names = {p.name for p in empty + occupied}
    assert "collimator" not in names
    assert "tools" not in names
    assert "probe-runs" not in names


def test_nested_empty_directory_counts_as_empty(tmp_path: Path) -> None:
    """`Shell/v1.0` — каталог в каталоге без единого файла; это тоже мусор."""
    empty, _ = sweep_junk.strays(make_root(tmp_path))
    assert "Shell" in {p.name for p in empty}


def test_file_at_root_is_not_a_stray(tmp_path: Path) -> None:
    empty, occupied = sweep_junk.strays(make_root(tmp_path))
    assert "README.md" not in {p.name for p in empty + occupied}


def test_dry_run_removes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = make_root(tmp_path)
    monkeypatch.setattr(sweep_junk, "REPO", root)
    monkeypatch.setattr(sys, "argv", ["sweep_junk.py", "--dry-run"])
    assert sweep_junk.main() == 0
    assert (root / "OF_PROCESSORS=16").is_dir()
    assert "would remove" in capsys.readouterr().out


def test_sweep_removes_only_the_empty_strays(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = make_root(tmp_path)
    monkeypatch.setattr(sweep_junk, "REPO", root)
    monkeypatch.setattr(sys, "argv", ["sweep_junk.py"])
    assert sweep_junk.main() == 0

    assert not (root / "OF_PROCESSORS=16").exists()
    assert not (root / "ৠ翹").exists()
    assert not (root / "Shell").exists()
    # Всё остальное на месте, включая посторонний каталог с файлом.
    assert (root / "важное" / "файл.txt").is_file()
    assert (root / "probe-runs" / "attn" / "article.md").is_file()
    assert (root / "collimator").is_dir()

    out = capsys.readouterr()
    assert "strays: 3 empty, 1 kept" in out.out
    assert "важное" in out.err


def test_clean_root_is_a_no_op(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "collimator").mkdir()
    monkeypatch.setattr(sweep_junk, "REPO", tmp_path)
    monkeypatch.setattr(sys, "argv", ["sweep_junk.py"])
    assert sweep_junk.main() == 0
    assert "strays: 0 empty, 0 kept" in capsys.readouterr().out


# --- мусорные файлы в корне -----------------------------------------------------------
#
# Вторая половина той же беды, и она была невидима: инструмент смотрел только каталоги.
# За один рабочий день в корне нашлись temp_data.py, rounds_output.json,
# final_structured_output.json и rounds_structured.json, и `git add -A` внёс три из них
# в коммит.


def test_known_root_files_are_not_strays(tmp_path: Path) -> None:
    for name in ("pyproject.toml", "CLAUDE.md", ".gitignore"):
        (tmp_path / name).write_text("x", encoding="utf-8")
    assert sweep_junk.stray_files(tmp_path) == []


def test_unknown_root_file_is_a_stray(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("x", encoding="utf-8")
    (tmp_path / "rounds_output.json").write_text("{}", encoding="utf-8")
    assert [p.name for p in sweep_junk.stray_files(tmp_path)] == ["rounds_output.json"]


def test_directories_are_not_counted_as_stray_files(tmp_path: Path) -> None:
    (tmp_path / "какой-то-каталог").mkdir()
    assert sweep_junk.stray_files(tmp_path) == []


def test_stray_files_are_sorted(tmp_path: Path) -> None:
    for name in ("b.json", "a.json", "c.py"):
        (tmp_path / name).write_text("x", encoding="utf-8")
    assert [p.name for p in sweep_junk.stray_files(tmp_path)] == ["a.json", "b.json", "c.py"]


def test_without_git_a_file_counts_as_tracked(tmp_path: Path) -> None:
    """Нет ответа — значит не удаляем. Стереть исходник ради порядка хуже любого мусора."""
    target = tmp_path / "неизвестно.json"
    target.write_text("{}", encoding="utf-8")
    assert sweep_junk.tracked_by_git(tmp_path, target) is True


def test_untracked_file_in_a_repo_is_removable(tmp_path: Path) -> None:
    """Чистая единица от git — единственный ответ, по которому можно удалять."""
    import subprocess

    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True, capture_output=True)
    target = tmp_path / "черновик.json"
    target.write_text("{}", encoding="utf-8")
    assert sweep_junk.tracked_by_git(tmp_path, target) is False
