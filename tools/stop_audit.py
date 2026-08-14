#!/usr/bin/env python3
"""SubagentStop hook: record what every agent actually left on disk.

Not a gate, and the name says so. Blocking was measured and does not work for workflow agents:
the hook fires, the payload is complete, exit code 2 is ignored and the agent finishes anyway.
What the hook can do is watch for free — it runs in Claude Code's own process, costs no tokens,
and an agent cannot skip it.

What it records, and why this and not something else. An earlier version looked for a `path`
field in the agent's StructuredOutput and checked whether a file sat there. That field was
later removed from every schema on purpose — the script names the paths, so asking an agent to
report one back only creates a channel where "say where it is" substitutes for "put it there".
The hook then had nothing to look at: 48 of its 50 log lines said `no_claimed_path`.

So it looks at what an agent cannot fake: its own Write and Edit tool calls. For each stop it
writes one line with the agent type, how many files it wrote, and — the useful part — whether
those files are actually on disk now. An agent that called Write and left nothing, or wrote
somewhere nobody expected, shows up in the log without anyone having to ask.

Always exits 0. A hook that fails must not take the run with it.
"""

from __future__ import annotations

import datetime
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LOG = REPO / "probe-runs" / "stop-audit.jsonl"
MSYS_DRIVE = re.compile(r"^/([A-Za-z])(?=/|$)")
WRITING_TOOLS = frozenset({"Write", "Edit", "NotebookEdit"})


def resolve(path: Path) -> Path:
    """Accept the msys spelling of a Windows path, same rule as tools/gate.py."""
    if path.exists():
        return path
    posix = path.as_posix()
    match = MSYS_DRIVE.match(posix)
    if match is None:
        return path
    candidate = Path(f"{match.group(1).upper()}:{posix[match.end() :] or '/'}")
    return candidate if candidate.exists() else path


def written_paths(transcript: Path) -> list[str]:
    """Every file the agent's own Write/Edit calls targeted, in order, without repeats."""
    if not transcript.is_file():
        return []
    seen: dict[str, None] = {}
    for line in transcript.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        content = (entry.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if block.get("type") != "tool_use" or block.get("name") not in WRITING_TOOLS:
                continue
            payload = block.get("input")
            if isinstance(payload, dict) and isinstance(payload.get("file_path"), str):
                seen.setdefault(payload["file_path"], None)
    return list(seen)


def audit(payload: dict[str, object]) -> dict[str, object]:
    """Build the log line for one stop. Pure, so the tests can read it."""
    record: dict[str, object] = {
        "agent_type": payload.get("agent_type") or "(none)",
        "agent_id": payload.get("agent_id") or "(none)",
    }
    transcript = payload.get("agent_transcript_path")
    if not isinstance(transcript, str):
        record["verdict"] = "no_transcript"
        return record

    paths = written_paths(Path(transcript))
    if not paths:
        # Not a defect by itself: a critic writes nothing and is right not to.
        record["verdict"] = "no_writes"
        return record

    missing = [p for p in paths if not resolve(Path(p)).exists()]
    record["wrote"] = len(paths)
    record["files"] = paths
    if missing:
        record["verdict"] = "MISSING_AFTER_WRITE"
        record["missing"] = missing
    else:
        record["verdict"] = "ok"
    return record


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0

    record = audit(payload)
    record["at"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")

    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
