"""Тесты замка на каталог прогона.

Вопрос «идёт ли по этому каталогу другой прогон» до сих пор не имел ответа, и это стоило
прогона: журнал молчал шесть минут, каталог выглядел свободным, а первый прогон был жив —
молчали искатели, которые вообще не зовут инструментов. Два процесса писали один разбор, и
какую версию читал писатель, установить уже нельзя.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import busy
import pytest

NOW = "2026-08-16T15:30:00+03:00"


def run(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    *argv: str,
) -> tuple[dict[str, Any], int]:
    monkeypatch.setattr(sys, "argv", ["busy.py", *argv])
    code = busy.main()
    report: dict[str, Any] = json.loads(capsys.readouterr().out)
    return report, code


def log_with(tmp_path: Path, *stamps: str) -> Path:
    target = tmp_path / "tools.jsonl"
    target.write_text(
        "".join(json.dumps({"at": s, "tool": "gate", "ok": True}) + "\n" for s in stamps),
        encoding="utf-8",
    )
    return target


def test_missing_log_is_free(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Свежий каталог — обычное состояние, а не подозрительное."""
    report, code = run(capsys, monkeypatch, "--file", str(tmp_path / "нет.jsonl"), "--now", NOW)
    assert report["busy"] is False
    assert report["ok"] is True
    assert code == 0


def test_recent_line_means_busy(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    log = log_with(tmp_path, "2026-08-16T15:28:00+03:00")
    report, _ = run(capsys, monkeypatch, "--file", str(log), "--now", NOW)
    assert report["busy"] is True
    assert report["measures"]["idle_seconds"] == 120
    assert "another run may be working here" in report["problems"][0]


def test_old_line_means_free(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    log = log_with(tmp_path, "2026-08-16T15:00:00+03:00")
    report, _ = run(capsys, monkeypatch, "--file", str(log), "--now", NOW)
    assert report["busy"] is False
    assert report["measures"]["idle_seconds"] == 1800


def test_window_is_the_callers_to_set(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    log = log_with(tmp_path, "2026-08-16T15:00:00+03:00")
    report, _ = run(capsys, monkeypatch, "--file", str(log), "--now", NOW, "--idle-seconds", "3600")
    assert report["busy"] is True


def test_last_line_wins_not_the_first(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    log = log_with(tmp_path, "2026-08-16T14:00:00+03:00", "2026-08-16T15:29:00+03:00")
    report, _ = run(capsys, monkeypatch, "--file", str(log), "--now", NOW)
    assert report["busy"] is True


def test_truncated_final_line_falls_back_to_the_one_before(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Оборванная последняя строка — как раз то, как выглядит журнал прогона на ходу."""
    log = log_with(tmp_path, "2026-08-16T15:29:00+03:00")
    with log.open("a", encoding="utf-8") as fh:
        fh.write('{"at": "2026-08-16T15:29')
    report, _ = run(capsys, monkeypatch, "--file", str(log), "--now", NOW)
    assert report["busy"] is True
    assert report["measures"]["last_activity"] == "2026-08-16T15:29:00+03:00"


def test_unreadable_now_is_busy_not_free(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Сломанные часы не должны читаться как «свободно»: это ответ, который пускает второй прогон."""
    log = log_with(tmp_path, "2026-08-16T15:29:00+03:00")
    report, code = run(capsys, monkeypatch, "--file", str(log), "--now", "вчера", "--strict")
    assert report["busy"] is True
    assert code == 1


def test_future_line_does_not_read_as_free(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Часы разошлись — это не причина объявлять каталог свободным."""
    log = log_with(tmp_path, "2026-08-16T16:00:00+03:00")
    report, _ = run(capsys, monkeypatch, "--file", str(log), "--now", NOW)
    assert report["busy"] is True


def test_strict_exits_one_when_busy(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    log = log_with(tmp_path, "2026-08-16T15:29:00+03:00")
    _, code = run(capsys, monkeypatch, "--file", str(log), "--now", NOW, "--strict")
    assert code == 1
    _, code = run(capsys, monkeypatch, "--file", str(log), "--now", NOW)
    assert code == 0


def test_naive_and_aware_stamps_compare(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Часовой пояс есть не у всякого, кто передаёт время; падать на этом нельзя."""
    log = log_with(tmp_path, "2026-08-16T15:29:00")
    report, _ = run(capsys, monkeypatch, "--file", str(log), "--now", NOW)
    assert report["busy"] is True


def test_receipt_goes_to_its_own_log(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    receipt = tmp_path / "tools.jsonl"
    run(
        capsys,
        monkeypatch,
        "--file",
        str(tmp_path / "нет.jsonl"),
        "--now",
        NOW,
        "--log",
        str(receipt),
    )
    line = json.loads(receipt.read_text(encoding="utf-8").splitlines()[0])
    assert line["tool"] == "busy"
