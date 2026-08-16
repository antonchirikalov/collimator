#!/usr/bin/env python3
"""Mint a fresh run directory name, because a workflow script cannot.

`Date.now()` and `new Date()` are unavailable inside a workflow script — they would break the
resume machinery, so the runtime removes them. A script therefore cannot name a run after the
moment it started, and the run directory has to arrive from outside, in `args.runDir`.

That is a footgun and it fired. Seven launches of one article all went into `probe-runs/attn4`,
and the reuse-from-disk machinery did exactly what it was built to do: it picked up whatever was
already there. Excellent while continuing an interrupted run, and wrong while comparing two: the
second run inherits the first one's research, its material and its draft, and the comparison
measures nothing. Two runs pointed at the same directory at once did worse — one overwrote the
other's article mid-round, and which agent produced the surviving text could not be established.

So: a new directory per experiment, minted here where a clock exists. Continuing a run means
passing its directory back deliberately, which is a different act from starting one and now
looks different too.

    python -X utf8 tools/newrun.py --base docs-runs --label attention
    docs-runs/attention-20260816-142530
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

SLUG_OK = re.compile(r"[^a-z0-9]+")

# Cyrillic labels are the normal case here and dropping them produced `run-20260816-142530` for
# every experiment — a name that identifies nothing, which is the opposite of the point.
# Transliteration is the plain GOST-ish one: readable, reversible enough to recognise, ASCII.
TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya",
}


def slugify(label: str) -> str:
    """A label a filesystem and a URL can both carry, and a person can still read."""
    lowered = "".join(TRANSLIT.get(ch, ch) for ch in label.strip().lower())
    slug = SLUG_OK.sub("-", lowered).strip("-")
    return slug or "run"


def run_dir(base: str, label: str, now: datetime) -> str:
    """`docs-runs/attention-20260816-142530`, in posix form for a workflow's `args`."""
    return (Path(base) / f"{slugify(label)}-{now:%Y%m%d-%H%M%S}").as_posix()


def main() -> int:
    p = argparse.ArgumentParser(description="Print a fresh run directory name.")
    p.add_argument("--base", default="docs-runs", help="directory the runs live under")
    p.add_argument("--label", required=True, help="what this run is about, in a word or two")
    p.add_argument(
        "--check",
        action="store_true",
        help="fail if the directory already exists instead of printing it",
    )
    args = p.parse_args()

    # Local time, made explicit: the name is read by a person deciding which run to open.
    target = run_dir(args.base, args.label, datetime.now().astimezone())
    if args.check and Path(target).exists():
        print(f"уже существует: {target}", file=sys.stderr)
        return 1
    print(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
