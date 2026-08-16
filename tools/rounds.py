#!/usr/bin/env python3
"""Read the round records a revision loop left behind, so a restart does not re-judge.

Why this exists. A dynamic workflow lives inside the CLI process, and that process is
restarted routinely — five self-upgrades and one idle exit in a single working day of the
machine this was built on. The artifacts of a run survive that, because agents write them to
disk; the *verdicts* did not, because they lived only in the values agents returned. So a
restart made the pipeline pay its two most expensive agents again to re-read an article they
had already judged, and the round budget became per-launch instead of per-article: three
restarts meant six rounds of revision where the brief allowed two.

The record itself is written by an agent (the script has no filesystem), one file per round,
in the plain numbered form ``verbatim_writer`` produces. This script only parses them back,
and it is a script rather than a model for the same reason ``gate.py`` is: recovering "which
round were we on" by reading prose is exactly the judgement that comes back different every
time it is asked.

The output envelope matches gate.py's — ``ok``/``problems``/``measures`` — so the agent that
carries deterministic checks can carry this one too without learning a second shape.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import toollog

ROUND_FILE = re.compile(r"^round-(\d+)\.md$")
ITEM = re.compile(r"^\s*\d+\.\s+(.*\S)\s*$", re.MULTILINE)
VERDICT = re.compile(r"\bverdict=(\w+)")
STYLE_VERDICT = re.compile(r"\bstyle=(\w+)")

# The prefixes the loop puts on an item before recording it. Splitting on them here keeps the
# recovered state in the same three buckets the loop feeds back to the writer, rather than one
# flat list the next round would hand over as if a single critic had said all of it.
STYLE_PREFIX = "Style: "
GATE_PREFIX = "Gate: "


def parse_round(path: Path) -> dict[str, object]:
    """One ``round-<n>.md`` into the state the loop needs to continue from it."""
    text = path.read_text(encoding="utf-8")
    head = text.split("\n", 1)[0]

    remarks: list[str] = []
    style: list[str] = []
    gate: list[str] = []
    for item in ITEM.findall(text):
        if item.startswith(STYLE_PREFIX):
            style.append(item[len(STYLE_PREFIX) :])
        elif item.startswith(GATE_PREFIX):
            gate.append(item[len(GATE_PREFIX) :])
        else:
            remarks.append(item)

    verdict_match = VERDICT.search(head)
    style_match = STYLE_VERDICT.search(head)
    match = ROUND_FILE.match(path.name)
    return {
        "round": int(match.group(1)) if match else 0,
        "verdict": verdict_match.group(1) if verdict_match else "unknown",
        "style_verdict": style_match.group(1) if style_match else "unknown",
        "remarks": remarks,
        "style": style,
        "gate": gate,
    }


def collect(directory: Path) -> tuple[list[dict[str, object]], list[str]]:
    """Every round record in the directory, in round order, plus what went wrong reading it."""
    problems: list[str] = []
    if not directory.is_dir():
        # Not a problem: a first run has no records, and that is the normal case rather than
        # an error. `ok` stays true and `rounds` stays empty.
        return [], problems

    rounds: list[dict[str, object]] = []
    for path in sorted(directory.iterdir()):
        if not ROUND_FILE.match(path.name):
            continue
        try:
            rounds.append(parse_round(path))
        except OSError as exc:
            problems.append(f"unreadable round record {path.name}: {exc}")

    rounds.sort(key=lambda r: int(str(r["round"])))

    # A gap means a record was lost, and continuing from the highest number would silently
    # skip a round that was actually run. Say so rather than guess.
    numbers = [int(str(r["round"])) for r in rounds]
    expected = list(range(1, len(numbers) + 1))
    if numbers and numbers != expected:
        problems.append(f"round records are not consecutive: found {numbers}, expected {expected}")

    return rounds, problems


def main() -> int:
    p = argparse.ArgumentParser(description="Read the round records of a revision loop.")
    p.add_argument("--dir", type=Path, required=True, help="directory holding round-<n>.md")
    p.add_argument(
        "--last-only",
        action="store_true",
        help="emit only the newest round in `rounds`; counts still cover all of them",
    )
    p.add_argument("--strict", action="store_true", help="also exit 1 when a record is broken")
    toollog.add_argument(p)
    args = p.parse_args()

    rounds, problems = collect(args.dir)
    last = max((int(str(r["round"])) for r in rounds), default=0)

    # Why --last-only exists, and why the workflow always passes it. The output of this script
    # travels back through an agent, and an agent is a channel with a budget: five rounds of
    # verbatim remarks is about a hundred kilobytes of JSON, and the carrier silently returned
    # two rounds instead of five. The script read that as "two rounds done", restarted the loop
    # at three, and ran four rounds where one was due — 1.4 million tokens.
    #
    # Nothing downstream needs the older rounds' text: the loop continues from the newest one
    # and counts the rest. So the payload is bounded here rather than hoped about there. The
    # full form stays the default, because a person reading the whole history wants all of it
    # and a terminal has no such budget.
    emitted = rounds[-1:] if args.last_only else rounds

    report = {
        "ok": not problems,
        "problems": problems,
        "measures": {"rounds": len(rounds), "last_round": last},
        "rounds": emitted,
    }
    toollog.append(args.log, "rounds", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if (problems and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
