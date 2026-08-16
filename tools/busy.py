#!/usr/bin/env python3
"""Is another run working in this directory right now?

The question has no answer today, and that cost a run. A run directory looked finished — its
tool log had been quiet for six minutes — so a second run was started into it. The first was
alive: the quiet was its source finders working, which produce no tool calls at all. The two
then wrote the same analysis file from two processes, and which version the writer read is no
longer establishable. The rake was already in CLAUDE.md; knowing about it did not help, because
"is a run going" was not observable.

It is observable through the tool log. Every stage that measures anything appends a line with
a timestamp, so a log whose last line is younger than the idle window means someone is working.
That is a heuristic and it is named as one: a run can be quiet longer than the window while an
agent thinks, and a crashed run leaves a log that ages into "free" — the first is a false alarm
the caller can override, the second resolves itself after the window. Both beat the current
answer, which is silence.

The clock comes from outside, in `--now`. A workflow script has no `Date.now()` — the runtime
removes it, or resuming would break — so a script cannot ask "how long ago" without being told
when now is. Same reason the run directory is minted outside and passed in.

The output envelope is gate.py's, so the agent that carries deterministic checks carries this
one too.

One caveat by construction: the check writes its own receipt into the same log, so asking twice
about the same directory answers "busy" the second time — the occupant it found is the first
question. It is asked once, at the start of a run, before anything else has been spent.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import toollog


def last_activity(log: Path) -> tuple[datetime | None, list[str]]:
    """When the tool log was last appended to, by its own timestamps rather than by mtime.

    Not mtime: a copy, a checkout or a sync rewrites it, and the answer would then be about the
    filesystem rather than about the run. The line carries the time it was written, so that is
    what is read — the last parseable one, scanning backwards, because a truncated final line
    is exactly what a half-written log looks like.
    """
    if not log.is_file():
        return None, []
    problems: list[str] = []
    lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            at = json.loads(line).get("at")
        except json.JSONDecodeError:
            continue
        if not isinstance(at, str):
            continue
        try:
            return datetime.fromisoformat(at), problems
        except ValueError:
            problems.append(f"unreadable timestamp in log: {at}")
    return None, problems


def main() -> int:
    p = argparse.ArgumentParser(description="Is another run working in this directory?")
    p.add_argument("--file", dest="target", type=Path, required=True, help="the run's tools.jsonl")
    p.add_argument("--now", required=True, help="current time in ISO 8601; the script has no clock")
    p.add_argument(
        "--idle-seconds",
        type=int,
        default=600,
        help="quiet for at least this long counts as free (default 600)",
    )
    p.add_argument("--strict", action="store_true", help="also exit 1 when the directory is busy")
    toollog.add_argument(p)
    args = p.parse_args()

    problems: list[str] = []
    measures: dict[str, object] = {"idle_seconds_required": args.idle_seconds}

    try:
        now = datetime.fromisoformat(args.now)
    except ValueError:
        # Not a guess: an unreadable clock cannot be allowed to read as "free", because that is
        # the answer that lets a second run start.
        report = {
            "ok": False,
            "problems": [f"unreadable --now: {args.now}"],
            "measures": measures,
            "busy": True,
        }
        toollog.append(args.log, "busy", report, args.log_note)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if args.strict else 0

    at, read_problems = last_activity(args.target)
    problems.extend(read_problems)

    if at is None:
        # No log at all is the normal state of a fresh directory, and of a directory whose run
        # never got as far as a measurement. Free either way.
        measures["last_activity"] = None
        busy = False
    else:
        if at.tzinfo is None or now.tzinfo is None:
            at, now = at.replace(tzinfo=None), now.replace(tzinfo=None)
        idle = (now - at).total_seconds()
        measures["last_activity"] = at.isoformat(timespec="seconds")
        measures["idle_seconds"] = round(idle)
        # A log from the future means the two clocks disagree, and disagreeing clocks are not a
        # reason to declare the directory free.
        busy = idle < args.idle_seconds
        if busy:
            problems.append(
                f"another run may be working here: last tool call {round(idle)}s ago, "
                f"quiet for {args.idle_seconds}s required"
            )

    report = {"ok": not problems, "problems": problems, "measures": measures, "busy": busy}
    toollog.append(args.log, "busy", report, args.log_note)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if (busy and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
