#!/usr/bin/env python3
"""Remove stray empty directories the figgybanana CLI drops into the repository root.

Runs of the illustration pipeline leave empty directories behind with names like
`OF_PROCESSORS=16`, `Sectigo (AAA)`, `Shell`, and strings of CJK mojibake — ten of them in one
run, in pairs, appearing within seconds of each `paperbanana generate` call. They are always
empty and always in the current working directory of the CLI call.

What is established: they come from inside paperbanana's execution, not from the shell commands
the agent runs (those were read back from the transcripts and are well-formed). Isolated
reproduction failed for every component tried separately — a `--cost-only` run, the ss_gateway
bridge spawned three times, and the `claude` CLI spawned exactly as its provider spawns it.

What is established about the likely path: on Windows `claude` is a `.cmd` shim, so the
provider's `--system-prompt` argument travels through cmd.exe. Past roughly 8 KB the call dies
with "The command line is too long" (measured: fine at 4-12 KB, dead at 20 KB), and below that
limit the prompt text still passes through a shell that interprets `>`, `&`, `|` and `%VAR%`.
That is the one mechanism found that can create entries in the current directory out of prompt
text, and it explains both the mojibake and the environment-variable fragment. Not proven.

So this is a broom, not a fix. The fix belongs in figgybanana: pass the system prompt through
stdin like the user prompt already is. Until then a deterministic sweep beats hunting the same
directories by hand after every run.

Safety: only empty directories are removed, only from the repository root, and only ones not in
KEEP. A directory holding a single file anywhere below it is left alone and reported.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Everything the repository is supposed to contain at top level. A new legitimate directory has
# to be added here, which is the point: an unknown name at the root is either junk or a mistake.
KEEP = frozenset(
    {
        ".claude",
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "collimator",
        "docs",
        "library",
        "probe-runs",
        "tests",
        "tools",
    }
)


def strays(root: Path) -> tuple[list[Path], list[Path]]:
    """Split unexpected top-level directories into empty ones and non-empty ones."""
    empty: list[Path] = []
    occupied: list[Path] = []
    for path in sorted(root.iterdir(), key=lambda p: p.name):
        if not path.is_dir() or path.name in KEEP:
            continue
        if any(child.is_file() for child in path.rglob("*")):
            occupied.append(path)
        else:
            empty.append(path)
    return empty, occupied


def main() -> int:
    parser = argparse.ArgumentParser(description="Sweep stray empty directories from the root.")
    parser.add_argument(
        "--dry-run", action="store_true", help="report what would be removed, remove nothing"
    )
    args = parser.parse_args()

    empty, occupied = strays(REPO)

    for path in occupied:
        # Never silently: a non-empty stray is a different problem and wants a human.
        print(f"kept (not empty): {path.name!r}", file=sys.stderr)

    for path in empty:
        if not args.dry_run:
            shutil.rmtree(path)
        print(f"{'would remove' if args.dry_run else 'removed'}: {path.name!r}")

    print(f"strays: {len(empty)} empty, {len(occupied)} kept")
    return 0


if __name__ == "__main__":
    sys.exit(main())
