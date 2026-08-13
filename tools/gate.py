#!/usr/bin/env python3
"""Deterministic content gates for generated documents.

Why a separate script instead of asking a model: every rule here is arithmetic or a
regex, and a workflow script cannot read the filesystem itself. So a cheap agent runs
this command and returns its JSON, and the orchestrating script branches on the numbers
without ever opening the file. The output format is the one the old engine wrote into
`gate_report.json`, so reports stay comparable across the two implementations.

Prose is measured separately from the file, and that distinction was learned the hard
way: a brief asking for "8 to 12 thousand characters" means readable text, while the
file also carries markdown, tables, fenced formulas and figure captions. A live article
measured 13 662 characters as a file and 11 111 without whitespace; its critic spent a
remark on length in all three of its rounds and the piece still shipped over budget.

Exit code is 0 even when the gate fails: the verdict travels in the JSON, and a non-zero
exit would read to the calling agent as "the command broke". Pass --strict when you want
the process to fail too, which is what a hook wants.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

FENCED_BLOCK = re.compile(r"^```.*?^```\s*", re.S | re.M)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
TABLE_ROW = re.compile(r"^[ \t]*\|.*\|[ \t]*$\n?", re.M)
IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
HEADING_MARK = re.compile(r"^#{1,6}[ \t]+", re.M)
LIST_MARK = re.compile(r"^[ \t]*([-*+]|\d+\.)[ \t]+", re.M)
BACKTICK = re.compile(r"`+")
EMPHASIS = re.compile(r"(\*\*|__|\*|_)")
BLANKS = re.compile(r"[ \t]*\n[ \t]*")


def prose_of(text: str) -> str:
    """Strip what a reader does not read as sentences.

    Fenced blocks, tables, images and HTML comments go entirely; link syntax collapses
    to its visible text; heading, list, emphasis and code markers are dropped. What
    remains is close to what a person would count as the article's prose.
    """
    t = FENCED_BLOCK.sub("", text)
    t = HTML_COMMENT.sub("", t)
    t = TABLE_ROW.sub("", t)
    t = IMAGE.sub("", t)
    t = LINK.sub(r"\1", t)
    t = HEADING_MARK.sub("", t)
    t = LIST_MARK.sub("", t)
    t = BACKTICK.sub("", t)
    t = EMPHASIS.sub("", t)
    return BLANKS.sub("\n", t).strip()


def main() -> int:
    p = argparse.ArgumentParser(description="Deterministic content gates.")
    p.add_argument("--file", type=Path, help="document to check")
    p.add_argument("--dir", type=Path, help="directory to check for entry count")
    p.add_argument("--max-length", type=int, help="ceiling on file characters, with spaces")
    p.add_argument("--min-length", type=int, help="floor on file characters, with spaces")
    p.add_argument("--max-prose", type=int, help="ceiling on prose characters")
    p.add_argument("--min-prose", type=int, help="floor on prose characters")
    p.add_argument(
        "--forbid",
        action="append",
        default=[],
        metavar="REGEX",
        help="pattern that must not appear (case-insensitive); repeatable",
    )
    p.add_argument("--min-entries", type=int, help="floor on entries directly inside --dir")
    p.add_argument("--strict", action="store_true", help="also exit 1 when the gate fails")
    args = p.parse_args()

    problems: list[str] = []
    measures: dict[str, object] = {}

    if args.file is not None:
        if not args.file.exists():
            problems.append(f"output missing: {args.file}")
        else:
            text = args.file.read_text(encoding="utf-8")
            chars = len(text)
            prose = len(prose_of(text))
            measures["chars"] = chars
            measures["prose_chars"] = prose

            if args.max_length is not None and chars > args.max_length:
                problems.append(f"max_length {args.max_length} exceeded (got {chars})")
            if args.min_length is not None and chars < args.min_length:
                problems.append(f"min_length {args.min_length} not met (got {chars})")
            if args.max_prose is not None and prose > args.max_prose:
                problems.append(f"max_prose {args.max_prose} exceeded (got {prose})")
            if args.min_prose is not None and prose < args.min_prose:
                problems.append(f"min_prose {args.min_prose} not met (got {prose})")

            hits: dict[str, int] = {}
            for pattern in args.forbid:
                found = re.findall(pattern, text, flags=re.I)
                hits[pattern] = len(found)
                if found:
                    sample = ", ".join(sorted({str(f) for f in found})[:3])
                    problems.append(
                        f"forbidden pattern matched {len(found)}x: {pattern} ({sample})"
                    )
            if hits:
                measures["regex"] = hits

    if args.dir is not None:
        if not args.dir.is_dir():
            problems.append(f"output directory missing: {args.dir}")
        else:
            entries = sorted(x.name for x in args.dir.iterdir())
            measures["entries"] = len(entries)
            if not entries:
                problems.append("output directory has no content")
            if args.min_entries is not None and len(entries) < args.min_entries:
                problems.append(
                    f"min_entries {args.min_entries} not met (got {len(entries)})"
                )

    report = {"ok": not problems, "problems": problems, "measures": measures}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if (problems and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
