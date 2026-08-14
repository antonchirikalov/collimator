#!/usr/bin/env python3
"""SubagentStop hook: an agent may not claim an output file it did not write.

Why a hook and not an agent. The gate has to be arithmetic to be worth anything, and a
workflow script cannot reach the filesystem, so something outside the script must run it.
An agent with Bash can — but only if it chooses to, and it is the same agent whose work is
being judged. A hook runs in Claude Code's own process: zero tokens, and the agent cannot
skip it.

What it enforces, and why this rule first. A live run had the analyst read three source
files, return `path: .../analysis.md` through its schema, and never call Write. The whole
stage silently did not exist: the writer hunted for the file six times, gave up, wrote the
article straight from the sources, and the run reported success. The schema guarantees the
field holds a string, never that a file sits at that string.

How the claimed path is found: the agent's transcript records its StructuredOutput call, and
`input.path` is the path it claims to have produced. No per-agent configuration is needed —
an agent that claims no path is simply not subject to this rule.

Blocking contract: exit code 2 stops the agent from finishing and hands it stderr as the
reason, which it can act on. `stop_hook_active` is true when the agent is already continuing
because of a stop hook, and that is the guard against blocking forever: one block per agent,
then the run proceeds and the missing artifact becomes the next stage's problem instead of a
deadlock.
"""

from __future__ import annotations

import datetime
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LOG = REPO / "probe-runs" / "hook-gate.jsonl"
MSYS_DRIVE = re.compile(r"^/([A-Za-z])(?=/|$)")


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


def claimed_paths(transcript: Path) -> list[str]:
    """Every `path` an agent handed back through StructuredOutput, in order."""
    if not transcript.is_file():
        return []
    found: list[str] = []
    for line in transcript.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        content = (entry.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if block.get("type") != "tool_use" or block.get("name") != "StructuredOutput":
                continue
            payload = block.get("input")
            if isinstance(payload, dict) and isinstance(payload.get("path"), str):
                found.append(payload["path"])
    return found


def note(record: dict[str, object]) -> None:
    """Keep a trace of every decision: a hook that blocks silently is its own bug."""
    LOG.parent.mkdir(parents=True, exist_ok=True)
    record["at"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0

    agent_type = payload.get("agent_type") or "(none)"
    agent_id = payload.get("agent_id") or "(none)"
    transcript = payload.get("agent_transcript_path")

    # Already continuing because of a stop hook: do not block a second time.
    if payload.get("stop_hook_active"):
        note({"agent_type": agent_type, "agent_id": agent_id, "verdict": "skip:already_blocked"})
        return 0

    if not isinstance(transcript, str):
        note({"agent_type": agent_type, "agent_id": agent_id, "verdict": "skip:no_transcript"})
        return 0

    paths = claimed_paths(Path(transcript))
    if not paths:
        note({"agent_type": agent_type, "agent_id": agent_id, "verdict": "skip:no_claimed_path"})
        return 0

    claimed = paths[-1]
    target = resolve(Path(claimed))
    if target.exists():
        note(
            {
                "agent_type": agent_type,
                "agent_id": agent_id,
                "verdict": "ok",
                "path": claimed,
            }
        )
        return 0

    note(
        {
            "agent_type": agent_type,
            "agent_id": agent_id,
            "verdict": "BLOCK:missing_output",
            "path": claimed,
        }
    )
    print(
        f"output missing: {claimed}\n"
        f"Ты вернул этот путь как результат, но файла по нему нет. "
        f"Запиши файл своим инструментом Write и только потом завершайся. "
        f"Если писать нечего — верни путь к файлу, который действительно создал.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
