#!/usr/bin/env python3
"""Throwaway probe: do workflow agents count as subagents for the SubagentStop hook?

The plan wants content gates to run from a SubagentStop hook rather than from an agent that
has to be trusted to call Bash. The documentation says the hook fires "when a subagent
finishes", but never says whether an agent spawned by a Dynamic Workflow script counts as
one. This script answers that and nothing else.

Deliberately harmless: it appends one line and always exits 0, so it can never block an
agent while we are only looking. The payload the hook receives on stdin is recorded verbatim
because the field names decide what a real gate hook can branch on — which agent stopped,
which agent type, which session.
"""

from __future__ import annotations

import datetime
import json
import sys
from pathlib import Path

LOG = Path(__file__).resolve().parent.parent / "probe-runs" / "hook-probe.jsonl"


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {"_unparsed": raw[:4000]}

    LOG.parent.mkdir(parents=True, exist_ok=True)
    # The timestamp comes from here rather than from a workflow script, which has no clock.
    record = {
        "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "payload": payload,
    }
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    # Always 0: exit code 2 is what blocks an agent, and blocking is not this probe's job.
    return 0


if __name__ == "__main__":
    sys.exit(main())
