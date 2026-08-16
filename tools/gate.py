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

# Style presets: patterns that live in this file instead of on a command line.
#
# Two reasons they are not just `--forbid` arguments. Cyrillic through argv on Windows is a
# codepage lottery, and the gate stage does not choose the shell — a carrying agent picks
# bash or powershell on its own, and the rake list already records what a mangled path does
# to a run. And a preset is versioned with the repository: a phrase added here applies to
# every pipeline at once, where a command-line list drifts per caller.
#
# Presets match OUTSIDE code — fenced blocks and inline code are removed first. Plain
# `--forbid` still matches the whole file on purpose: `d_k ** 0.5` is a power in python and
# `**важно**` is bold in prose, and only the caller knows which of the two it meant.
PRESETS: dict[str, tuple[str, ...]] = {
    # Turns of phrase that read as generated Russian. Deliberately narrow: «давайте
    # разбираться» is a live author's transition and stays, «давайте разберём каждый
    # пункт» is filler and goes. A pattern that fires on normal prose costs a revision
    # round, so the list holds only phrases that carry no information at all.
    "ru_slop": (
        r"стоит отметить|стоит подчеркнуть|стоит обратить внимание",
        r"важно (?:отметить|понимать|подчеркнуть)|нельзя не отметить|крайне важно",
        r"давайте разбер[её]м|давайте рассмотрим|рассмотрим подробнее|разбер[её]м подробнее",
        r"в заключение|подводя ито[гж]|резюмиру[яе]|в конечном ито[гж]е",
        r"погрузимся в|нырн[её]м в|окун[её]мся в",
        r"ключев(?:ой|ая|ым) (?:вывод|роль|момент)|игра(?:ет|ют) (?:важную|ключевую) роль",
        r"явля(?:ет|ют)ся ключев",
        r"в современном мире|в наши дни|на сегодняшний день|в эпоху",
        r"не будем забывать|не стоит забывать",
        r"в этой стать[ебй] мы (?:рассмотрим|разбер[её]м|поговорим)",
        r"валидиру|имплементиру|хендлит|репортит|апрув",
        # Emoji: the pictographic planes only. Arrows and check marks live lower in the
        # table and belong to legitimate technical prose.
        r"[\U0001F300-\U0001FAFF]",
    ),
    # Bold inside prose. A separate preset because it is a formatting rule, not a
    # vocabulary one, and a pipeline may want one without the other.
    "no_bold": (
        r"\*\*[^\n*]+\*\*",
        r"__[^\n_]+__",
    ),
}


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
        "--forbid-preset",
        action="append",
        default=[],
        choices=sorted(PRESETS),
        metavar="NAME",
        help=f"named pattern set matched outside code; repeatable ({', '.join(sorted(PRESETS))})",
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
            problems.append(f"output missing: {target}")
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

            preset_hits: dict[str, int] = {}
            prose_markup = outside_code(text)
            for name in args.forbid_preset:
                for pattern in PRESETS[name]:
                    found = re.findall(pattern, prose_markup, flags=re.IGNORECASE)
                    preset_hits[pattern] = len(found)
                    if found:
                        # The sample is what makes the problem actionable: the writer gets
                        # the phrase it must remove, not the regex that caught it.
                        sample = ", ".join(sorted({str(f) for f in found})[:3])
                        problems.append(
                            f"preset {name} matched {len(found)}x: {pattern} ({sample})"
                        )
            if preset_hits:
                measures["preset"] = preset_hits

    if args.dir is not None:
        target_dir = resolve_path(args.dir)
        if not target_dir.is_dir():
            problems.append(f"output directory missing: {target_dir}")
        else:
            entries = sorted(x.name for x in target_dir.iterdir())
            measures["entries"] = len(entries)
            if not entries:
                problems.append("output directory has no content")
            if args.min_entries is not None and len(entries) < args.min_entries:
                problems.append(f"min_entries {args.min_entries} not met (got {len(entries)})")

    report = {"ok": not problems, "problems": problems, "measures": measures}
    toollog.append(args.log, "gate", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if (problems and args.strict) else 0


if __name__ == "__main__":
    sys.exit(main())
