"""Тесты наблюдателя за завершением подагентов.

Хук ничего не блокирует — его единственный результат это строка в протоколе, поэтому
проверяется, что строка говорит правду: сколько файлов агент писал, и лежат ли они на диске
на момент его завершения.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
import stop_audit


def transcript(tmp_path: Path, calls: list[tuple[str, str]], name: str = "agent.jsonl") -> Path:
    """Транскрипт из пар (инструмент, путь), в формате, который пишет рантайм."""
    path = tmp_path / name
    lines = []
    for tool, file_path in calls:
        lines.append(
            json.dumps(
                {
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "tool_use", "name": tool, "input": {"file_path": file_path}}
                        ],
                    }
                },
                ensure_ascii=False,
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_agent_that_wrote_nothing(tmp_path: Path) -> None:
    """Критик файлов не пишет, и это не дефект."""
    t = transcript(tmp_path, [])
    record = stop_audit.audit({"agent_type": "article-critic", "agent_transcript_path": str(t)})
    assert record["verdict"] == "no_writes"
    assert record["agent_type"] == "article-critic"


def test_written_file_that_exists(tmp_path: Path) -> None:
    target = tmp_path / "material.md"
    target.write_text("материал", encoding="utf-8")
    t = transcript(tmp_path, [("Write", str(target))])
    record = stop_audit.audit({"agent_type": "domain-analyst", "agent_transcript_path": str(t)})
    assert record["verdict"] == "ok"
    assert record["wrote"] == 1
    assert record["files"] == [str(target)]


def test_written_file_that_vanished(tmp_path: Path) -> None:
    """Главный случай: Write был, файла нет. Ради него хук и существует."""
    target = tmp_path / "material.md"
    t = transcript(tmp_path, [("Write", str(target))])
    record = stop_audit.audit({"agent_type": "domain-analyst", "agent_transcript_path": str(t)})
    assert record["verdict"] == "MISSING_AFTER_WRITE"
    assert record["missing"] == [str(target)]


def test_edit_counts_as_writing(tmp_path: Path) -> None:
    target = tmp_path / "article.md"
    target.write_text("статья", encoding="utf-8")
    t = transcript(tmp_path, [("Edit", str(target))])
    record = stop_audit.audit({"agent_type": "article-writer", "agent_transcript_path": str(t)})
    assert record["verdict"] == "ok"


def test_repeated_edits_of_one_file_count_once(tmp_path: Path) -> None:
    target = tmp_path / "article.md"
    target.write_text("статья", encoding="utf-8")
    t = transcript(tmp_path, [("Write", str(target)), ("Edit", str(target)), ("Edit", str(target))])
    record = stop_audit.audit({"agent_type": "article-writer", "agent_transcript_path": str(t)})
    assert record["wrote"] == 1


def test_reading_tools_are_not_writing(tmp_path: Path) -> None:
    t = transcript(tmp_path, [("Read", str(tmp_path / "brief.md"))])
    record = stop_audit.audit({"agent_type": "source-finder", "agent_transcript_path": str(t)})
    assert record["verdict"] == "no_writes"


def test_missing_transcript_is_reported_not_crashed(tmp_path: Path) -> None:
    record = stop_audit.audit(
        {"agent_type": "x", "agent_transcript_path": str(tmp_path / "нет.jsonl")}
    )
    assert record["verdict"] == "no_writes"


def test_payload_without_transcript_path(tmp_path: Path) -> None:
    record = stop_audit.audit({"agent_type": "x"})
    assert record["verdict"] == "no_transcript"


def test_broken_lines_in_transcript_are_skipped(tmp_path: Path) -> None:
    target = tmp_path / "material.md"
    target.write_text("материал", encoding="utf-8")
    t = transcript(tmp_path, [("Write", str(target))])
    t.write_text("не json\n" + t.read_text(encoding="utf-8"), encoding="utf-8")
    record = stop_audit.audit({"agent_type": "x", "agent_transcript_path": str(t)})
    assert record["verdict"] == "ok"


def test_main_appends_a_line_and_always_succeeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "material.md"
    target.write_text("материал", encoding="utf-8")
    t = transcript(tmp_path, [("Write", str(target))])
    log = tmp_path / "log" / "stop-audit.jsonl"
    monkeypatch.setattr(stop_audit, "LOG", log)

    payload = json.dumps({"agent_type": "domain-analyst", "agent_transcript_path": str(t)})
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(payload))
    assert stop_audit.main() == 0

    written = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    assert len(written) == 1
    assert written[0]["verdict"] == "ok"
    assert "at" in written[0]


def test_garbage_on_stdin_does_not_break_the_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Хук, падающий на мусоре, утащил бы за собой прогон."""
    monkeypatch.setattr(stop_audit, "LOG", tmp_path / "stop-audit.jsonl")
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO("{не json"))
    assert stop_audit.main() == 0
