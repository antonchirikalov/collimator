"""One line per deterministic check, appended where the run can be read afterwards.

Everything these tools measure travels back through an agent and into `log()`, which lives in
the workflow's own transcript and is summarised there. That is enough while a run is watched and
almost nothing once it is over: reconstructing what actually happened meant opening per-agent
JSONL transcripts and matching them by hand, and the one time it mattered — a carrier silently
returning two rounds where the tool had printed five — the evidence was only recoverable because
the tool could be re-run against the same directory afterwards.

So each tool records its own call. Not the agent: the agent is forbidden to create files, and
that rule has already paid for itself twice. The tool writing its own log is a different act —
it is the measurement leaving a receipt, and the receipt is written by whoever did the measuring.

Bounded on purpose. The line carries the arguments, the verdict, the measurements and the
problems — never the payload. A listing of two hundred files belongs in the answer to the
caller, not in a log meant to stay readable after fifty of them.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


def append(log: Path | None, tool: str, report: dict[str, Any]) -> None:
    """Append one JSON line describing this call. Never raises: a log is not worth a run.

    A failure to write the receipt must not fail the measurement — the caller is branching on
    the numbers, and losing a run because a directory was read-only would be a worse outcome
    than losing the line. The failure is printed to stderr, where the carrying agent puts raw
    output, so it is not silent either.
    """
    if log is None:
        return
    line = {
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "tool": tool,
        "argv": sys.argv[1:],
        "ok": report.get("ok"),
        "measures": report.get("measures", {}),
        "problems": report.get("problems", []),
    }
    try:
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, ensure_ascii=False) + "\n")
    except OSError as exc:
        print(f"toollog: не смог записать {log}: {exc}", file=sys.stderr)


def add_argument(parser: Any) -> None:
    """The same `--log` on every tool, so the workflow passes it the same way to all of them."""
    parser.add_argument(
        "--log",
        type=Path,
        default=None,
        help="append one JSON line about this call to this file",
    )
