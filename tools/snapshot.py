#!/usr/bin/env python3
"""Copy a file to a snapshot path, byte for byte.

Why a tool and not `cp`: the agent that runs this chooses its own shell, and the three shells
available on this machine spell a copy three different ways — `cp` in Git Bash, `Copy-Item` in
PowerShell, `copy` in cmd. A python call reads the same in all three and cannot be talked into
globbing something it was not asked to touch.

Why snapshots at all: the revision loop overwrites `article.md` every round. The round records
keep the verdicts and the remarks, so what a critic said in round 8 survives — but the draft it
said it about does not. Comparing what actually changed between two rounds was impossible, which
is exactly the question worth asking when a loop stops converging.

The copy is verbatim and the destination is refused if it already holds different content, so a
snapshot can never be silently rewritten by a later round bearing the same number.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path


def snapshot(source: Path, target: Path, overwrite: bool) -> tuple[bool, list[str]]:
    """Copy source to target. Returns (copied, problems)."""
    problems: list[str] = []
    if not source.is_file():
        problems.append(f"nothing to copy: {source}")
        return False, problems

    if target.exists() and not overwrite:
        same = target.read_bytes() == source.read_bytes()
        if same:
            # Re-running a round that already produced this snapshot is not an error, and it is
            # not a copy either. Saying so beats both a silent overwrite and a false failure.
            return False, problems
        problems.append(f"target exists with different content: {target}")
        return False, problems

    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return True, problems


def main() -> int:
    p = argparse.ArgumentParser(description="Copy a file to a snapshot path.")
    p.add_argument("--file", type=Path, required=True, help="what to copy")
    p.add_argument("--to", type=Path, required=True, help="where to put it")
    p.add_argument(
        "--overwrite", action="store_true", help="replace an existing snapshot instead of refusing"
    )
    p.add_argument("--strict", action="store_true", help="also exit 1 when the copy did not happen")
    args = p.parse_args()

    copied, problems = snapshot(args.file, args.to, args.overwrite)
    report = {
        "ok": not problems,
        "problems": problems,
        "measures": {
            "copied": copied,
            "bytes": args.to.stat().st_size if args.to.is_file() else 0,
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if (problems and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
