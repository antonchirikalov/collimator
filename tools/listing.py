#!/usr/bin/env python3
"""List the files in a directory, so a workflow script can fan out over what was actually found.

A workflow script has no filesystem. Every path it uses it has to know in advance, and that
rule shaped the research stage: the fan-out runs over the aspects the brief declares, because
those are the only filenames knowable before an agent runs. It works, and it costs something
that went unnoticed for a long time.

The source finder writes one file per aspect — the path the script named — and, following its
own contract, one file per source it kept. The script passes on the four it knows about. In a
measured run that was 79 KB of 260 KB: twenty-four files searched for, read, paid for, written
to disk, and never opened by anything downstream. The writer quoted a summary of an aspect
where a note on a specific source was sitting next to it, which is the likeliest reason
attribution errors survived eleven rounds of critics.

Enumerating a directory is not the same as asking an agent where it put something. The script
still names every path it writes; this only reports what is there, deterministically, so a
second fan-out can run over files nobody could have named in advance.

The output envelope matches gate.py's, so the agent that carries deterministic checks carries
this one too without learning a second shape.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import toollog


def listing(
    directory: Path, suffix: str, exclude: set[str], recursive: bool = False
) -> tuple[list[str], list[str]]:
    """Files inside the directory, as paths relative to the current directory.

    `recursive` exists for the audit at the end of a run: the question there is not "what did
    this stage produce" but "is there anything under the run directory that no agent ever read".
    Every loss found in this pipeline had that shape — produced, never consumed — so the check
    has to see the whole tree, not one level of it.
    """
    problems: list[str] = []
    if not directory.is_dir():
        problems.append(f"directory missing: {directory.as_posix()}")
        return [], problems

    found: list[str] = []
    walk = sorted(directory.rglob("*")) if recursive else sorted(directory.iterdir())
    for path in walk:
        if not path.is_file():
            continue
        if suffix and path.suffix != suffix:
            continue
        if path.name in exclude:
            continue
        # Posix form, always: the script compares these against paths it built itself, and it
        # builds them with forward slashes. A backslash here is the same mismatch that once
        # sent four finders out to research material already sitting on disk.
        found.append(path.as_posix())
    return found, problems


def main() -> int:
    p = argparse.ArgumentParser(description="List files in a directory for a workflow script.")
    p.add_argument("--dir", type=Path, required=True, help="directory to list")
    p.add_argument("--ext", default=".md", help="keep only this suffix; empty string keeps all")
    p.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="NAME",
        help="file name to leave out; repeatable",
    )
    p.add_argument(
        "--recursive", action="store_true", help="walk the whole tree, not just one level"
    )
    p.add_argument("--strict", action="store_true", help="also exit 1 when the directory is gone")
    toollog.add_argument(p)
    args = p.parse_args()

    files, problems = listing(args.dir, args.ext, set(args.exclude), args.recursive)
    report = {
        "ok": not problems,
        "problems": problems,
        "measures": {"files": len(files)},
        "files": files,
    }
    toollog.append(args.log, "listing", report, args.log_note)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if (problems and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
