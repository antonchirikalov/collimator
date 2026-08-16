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
from dataclasses import dataclass
from pathlib import Path

import toollog

FENCED_BLOCK = re.compile(r"^```.*?^```\s*", re.DOTALL | re.MULTILINE)
INLINE_CODE = re.compile(r"`[^`\n]*`")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
TABLE_ROW = re.compile(r"^[ \t]*\|.*\|[ \t]*$\n?", re.MULTILINE)
IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
HEADING_MARK = re.compile(r"^#{1,6}[ \t]+", re.MULTILINE)
LIST_MARK = re.compile(r"^[ \t]*([-*+]|\d+\.)[ \t]+", re.MULTILINE)
BACKTICK = re.compile(r"`+")
EMPHASIS = re.compile(r"(\*\*|__|\*|_)")
BLANKS = re.compile(r"[ \t]*\n[ \t]*")
MSYS_DRIVE = re.compile(r"^/([A-Za-z])(?=/|$)")

# Forbidden patterns come from FILES, not from this module and not from argv.
#
# They used to live here, as a dict of Russian phrases inside a Python tool. That was wrong in
# the ordinary way: a dead-phrase list is editorial policy for one language, the same kind of
# thing as the author's voice profile next to it — data a person edits, not code. Wanting to
# add a phrase should not mean opening a parser.
#
# Not argv either, and that part was right the first time: Cyrillic through a command line on
# Windows depends on the codepage and on which shell the carrying agent picked. A file sidesteps
# it completely — the path is ASCII, the contents are UTF-8 read by Python.
#
# One regex per line. `#` starts a comment, blank lines are ignored. Matched OUTSIDE code:
# fenced blocks and inline code are removed first, because `d_k ** 0.5` is a power and
# `**важно**` is bold, and only the caller knows which was meant.
COMMENT = re.compile(r"^\s*#")
HEADING = re.compile(r"^(#{1,6})[ \t]+(.*\S)")


@dataclass
class Section:
    """One heading while it is still open: what it is, and whether anything filled it."""

    level: int
    title: str
    line: int
    filled: bool = False
    has_children: bool = False


def patterns_of(path: Path) -> tuple[list[str], list[str]]:
    """Read one pattern file. A missing file is a problem, not an empty rule set.

    Silently checking nothing is the failure this returns instead of: a gate that found no
    violations because it had no patterns reads exactly like a gate that passed.
    """
    if not path.is_file():
        return [], [f"pattern file missing: {path.as_posix()}"]
    lines = path.read_text(encoding="utf-8").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not COMMENT.match(ln)], []


def outside_code(text: str) -> str:
    """The document with fenced blocks and inline code removed, markup otherwise intact.

    Not `prose_of`: that one also strips emphasis markers, so a bold-hunting pattern would
    find nothing there. Headings, lists and tables stay — a cliché in a table heading is
    still a cliché.
    """
    return INLINE_CODE.sub("", FENCED_BLOCK.sub("", text))


def resolve_path(path: Path) -> Path:
    """Accept the msys spelling of a Windows path.

    The gate stage does not control which shell the agent picks, and the probe run showed
    all three forms for one and the same command the script emitted: Bash with the path
    rewritten to ``/c/Users/…``, PowerShell with a ``cd`` prefix, Bash with the path
    quoted. Git Bash rewrites a drive path on the way to the process, so ``/c/Users/…``
    is what argv actually carries — real for the shell, absent for Python.

    Fallback only, never a rewrite: a path that exists as given is returned untouched, and
    a candidate that does not exist either leaves the original in place so the "output
    missing" message still names the path the caller passed.
    """
    if path.exists():
        return path
    posix = path.as_posix()
    match = MSYS_DRIVE.match(posix)
    if match is None:
        return path
    candidate = Path(f"{match.group(1).upper()}:{posix[match.end() :] or '/'}")
    return candidate if candidate.exists() else path


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


def empty_sections(text: str, floor: int) -> list[str]:
    """Headings with nothing under them, by title, in order.

    A length floor catches "the agent wrote nothing" and misses the failure that actually
    happens: the agent writes the SHAPE of the artifact — every heading the contract asks for,
    in the right order — and leaves the work out. Measured live: an analysis built from 25
    source files came back as 1 748 bytes of headings alone, which is comfortably past any
    floor a document that size would be given.

    A section counts as filled by any non-blank line that is not itself a heading, and content
    fills every heading open above it — a filled child fills its parent, which is what a reader
    would say looking at it. Only leaves are reported: naming a parent whose subsections are
    empty says the same thing twice and buries the one title worth acting on.
    """
    open_heads: list[Section] = []
    empty: list[Section] = []

    def close() -> None:
        section = open_heads.pop()
        if not section.filled and not section.has_children:
            empty.append(section)

    for number, line in enumerate(text.splitlines()):
        head = HEADING.match(line)
        if head:
            level = len(head.group(1))
            while open_heads and open_heads[-1].level >= level:
                close()
            if open_heads:
                open_heads[-1].has_children = True
            open_heads.append(Section(level, head.group(2), number))
            continue
        if len(line.strip()) < floor:
            continue
        for section in open_heads:
            section.filled = True

    while open_heads:
        close()

    return [section.title for section in sorted(empty, key=lambda s: s.line)]


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
    p.add_argument(
        "--forbid-file",
        action="append",
        default=[],
        type=Path,
        metavar="PATH",
        help="file of patterns matched outside code, one per line; repeatable",
    )
    p.add_argument(
        "--no-empty-sections",
        nargs="?",
        type=int,
        const=1,
        default=None,
        metavar="MIN_LINE",
        help="every heading must have content under it; optional floor on a line that counts",
    )
    p.add_argument("--min-entries", type=int, help="floor on entries directly inside --dir")
    p.add_argument("--strict", action="store_true", help="also exit 1 when the gate fails")
    toollog.add_argument(p)
    args = p.parse_args()

    problems: list[str] = []
    measures: dict[str, object] = {}

    if args.file is not None:
        target = resolve_path(args.file)
        if not target.exists():
            problems.append(f"output missing: {target.as_posix()}")
        else:
            text = target.read_text(encoding="utf-8")
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

            if args.no_empty_sections is not None:
                empty = empty_sections(text, args.no_empty_sections)
                measures["empty_sections"] = empty
                if empty:
                    # By name, not by count. The number says something is missing; the name
                    # says what, and only the name tells the caller whether it matters.
                    problems.append(
                        f"headings with nothing under them ({len(empty)}): " + "; ".join(empty[:8])
                    )

            hits: dict[str, int] = {}
            for pattern in args.forbid:
                found = re.findall(pattern, text, flags=re.IGNORECASE)
                hits[pattern] = len(found)
                if found:
                    sample = ", ".join(sorted({str(f) for f in found})[:3])
                    problems.append(
                        f"forbidden pattern matched {len(found)}x: {pattern} ({sample})"
                    )
            if hits:
                measures["regex"] = hits

            file_hits: dict[str, int] = {}
            prose_markup = outside_code(text)
            for pattern_file in args.forbid_file:
                patterns, missing = patterns_of(pattern_file)
                problems.extend(missing)
                for pattern in patterns:
                    found = re.findall(pattern, prose_markup, flags=re.IGNORECASE)
                    file_hits[pattern] = len(found)
                    if found:
                        # The sample is what makes the problem actionable: the writer gets
                        # the phrase it must remove, not the regex that caught it.
                        sample = ", ".join(sorted({str(f) for f in found})[:3])
                        problems.append(
                            f"{pattern_file.name} matched {len(found)}x: {pattern} ({sample})"
                        )
            if file_hits:
                measures["forbidden"] = file_hits

    if args.dir is not None:
        target_dir = resolve_path(args.dir)
        if not target_dir.is_dir():
            problems.append(f"output directory missing: {target_dir.as_posix()}")
        else:
            entries = sorted(x.name for x in target_dir.iterdir())
            measures["entries"] = len(entries)
            if not entries:
                problems.append("output directory has no content")
            if args.min_entries is not None and len(entries) < args.min_entries:
                problems.append(f"min_entries {args.min_entries} not met (got {len(entries)})")

    report = {"ok": not problems, "problems": problems, "measures": measures}
    toollog.append(args.log, "gate", report, args.log_note)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if (problems and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
