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

Stray FILES are the second half of the problem and were invisible here for a long time, because
this tool only ever looked at directories. Agents drop working files into the repository root —
`temp_data.py`, `rounds_output.json`, `final_structured_output.json`, `rounds_structured.json`
were all found there across one working day, and `git add -A` committed three of them. They come
from a different mechanism than the mojibake directories: an agent redirecting a command's output
to a file to read it back, instead of returning it.

Safety: only empty directories are removed, only from the repository root, and only ones not in
KEEP. A directory holding a single file anywhere below it is left alone and reported. Files are
reported but never removed without `--files`, and a file git tracks is never removed at all —
deleting a source file to tidy up is worse than any amount of clutter.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
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


# Every file the repository is supposed to carry at top level. Same principle as KEEP: an
# unknown name here is either an agent's leftover or something that wants a human's attention.
KEEP_FILES = frozenset(
    {
        ".gitattributes",
        ".gitignore",
        "CLAUDE.md",
        "README.md",
        "pyproject.toml",
        "uv.lock",
    }
)


def tracked_by_git(root: Path, path: Path) -> bool:
    """Is this file under version control? Those are never swept, whatever their name.

    Three answers, not two, and conflating them deletes files. `git ls-files --error-unmatch`
    exits 0 when the file is tracked and 1 when it is not — but it also exits 128 when there is
    no repository at all, and git may be missing entirely. Only a clean 1 means "not tracked";
    everything else means "git could not answer", and the safe reading of that is "tracked".
    """
    try:
        done = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", path.name],
            cwd=root,
            capture_output=True,
            check=False,
        )
    except OSError:
        return True
    return done.returncode != 1


def stray_files(root: Path) -> list[Path]:
    """Top-level files nobody declared. Reported always, removed only on request."""
    return sorted(
        (p for p in root.iterdir() if p.is_file() and p.name not in KEEP_FILES),
        key=lambda p: p.name,
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
    parser.add_argument(
        "--files",
        action="store_true",
        help="also remove stray top-level files that git does not track",
    )
    args = parser.parse_args()

    empty, occupied = strays(REPO)
    loose = stray_files(REPO)

    for path in occupied:
        # Never silently: a non-empty stray is a different problem and wants a human.
        print(f"kept (not empty): {path.name!r}", file=sys.stderr)

    for path in empty:
        if not args.dry_run:
            shutil.rmtree(path)
        print(f"{'would remove' if args.dry_run else 'removed'}: {path.name!r}")

    removed_files = 0
    for path in loose:
        if tracked_by_git(REPO, path):
            print(f"kept (git tracks it): {path.name!r}", file=sys.stderr)
            continue
        if not args.files:
            print(f"stray file (use --files to remove): {path.name!r}", file=sys.stderr)
            continue
        if not args.dry_run:
            path.unlink()
        removed_files += 1
        print(f"{'would remove' if args.dry_run else 'removed'} file: {path.name!r}")

    print(
        f"strays: {len(empty)} empty, {len(occupied)} kept, "
        f"{len(loose)} loose files ({removed_files} removed)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
