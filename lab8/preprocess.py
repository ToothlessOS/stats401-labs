"""Lab 8 - Task 2: turn the DKU UG Bulletin PDF into a structured passage table.

One paragraph / short policy block = one passage = one row.

The bulletin ships with a 5-level bookmark outline, so the
chapter / section / subsection hierarchy is read from the file itself
rather than guessed from font sizes.  Output schema (Task 2):

    passage_id, chapter, section, subsection, page, text

plus two extras that are useful downstream:

    heading_path  full breadcrumb (all 5 outline levels)
    kind          "prose" or "course_listing"

Run:  uv run lab8/preprocess.py
"""

from __future__ import annotations

import csv
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pymupdf

HERE = Path(__file__).resolve().parent
PDF_PATH = HERE / "V2021-22_DKU_UG_Bulletin.pdf"
OUT_PATH = HERE.parent / "data" / "bulletin_passages.csv"

# Course-listing tables are 1600+ rows like "SOSC 101 Foundational Questions 4".
# Left separate they swamp the corpus (they carry almost no semantic content),
# so consecutive rows in the same subsection are merged into one passage.
# Set False to keep one row per passage.
MERGE_COURSE_ROWS = True
MAX_MERGED_WORDS = 220          # split a merged listing past this length

BULLET = re.compile(r"^[•●▪◦\-–]\s*$")
PAGE_NUM = re.compile(r"^\d{1,3}$")
COURSE_CODE = re.compile(r"^[A-Z]{2,10}\s?\d{2,3}[A-Z]?\b")
TABLE_HEAD = re.compile(r"^Course Code\b.*Course Name\b", re.I)
LIST_ITEM = re.compile(r"^[a-z]\.\s|^[ox]\s+[A-Z]")


def norm(s: str) -> str:
    """Collapse the PDF's letter-spacing / trailing-space artifacts."""
    return re.sub(r"\s+", " ", s.replace("­", "")).strip()


def page_blocks(page) -> list[list[tuple[int, int, str]]]:
    """Return each text block as lines of (x, y, text), blocks in reading order.

    PyMuPDF's block segmentation already matches the visual paragraph breaks,
    so a block is treated as a paragraph (or as one table row).
    """
    blocks = []
    for b in page.get_text("dict")["blocks"]:
        if b.get("type") != 0:                      # skip images
            continue
        lines = [
            (round(l["bbox"][0]), round(l["bbox"][1]),
             norm("".join(s["text"] for s in l["spans"])))
            for l in b["lines"]
        ]
        lines = [l for l in lines if l[2]]
        if lines:
            blocks.append(sorted(lines, key=lambda z: (z[1], z[0])))
    return sorted(blocks, key=lambda ls: ls[0][1])


def is_page_number(lines) -> bool:
    return (len(lines) == 1 and PAGE_NUM.match(lines[0][2]) and lines[0][0] > 400)


def is_table_row(lines) -> bool:
    """A course row has several short lines sharing one y (code | name | credits).

    Prose lines stack vertically, so no two share a y.  Bullet markers sit only
    ~18pt from their text, so the 40pt horizontal gap keeps list items as prose.
    """
    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            xi, yi, ti = lines[i]
            xj, yj, tj = lines[j]
            if (abs(yi - yj) < 3 and abs(xi - xj) >= 40
                    and not BULLET.match(ti) and not BULLET.match(tj)):
                return True
    return False


def join_lines(lines) -> str:
    """Join a block's lines, healing words broken across a line break."""
    out = ""
    for _, _, text in sorted(lines, key=lambda z: z[1]):
        if out.endswith("-") and text[:1].islower():
            out = out[:-1] + text          # "under- stand" -> "understand"
        else:
            out = f"{out} {text}" if out else text
    return norm(out)


def build_heading_index(doc) -> dict[int, list[tuple[int, int, str]]]:
    """Map page index -> [(y, level, title)] for every outline entry.

    The outline stores only page numbers, so each title is located on its page
    to recover the y-position needed for slicing.  Titles match the rendered
    heading text for 1141 of 1142 entries.
    """
    index: dict[int, list[tuple[int, int, str]]] = defaultdict(list)
    for level, title, page_no in doc.get_toc():
        p = page_no - 1
        if not 0 <= p < doc.page_count:
            continue
        want = norm(title)
        for lines in page_blocks(doc[p]):
            got = norm(" ".join(t for _, _, t in lines))
            if got == want or (len(want) > 18 and got.startswith(want)):
                index[p].append((lines[0][1], level, want))
                break
    return index


def extract(doc) -> list[dict]:
    """Walk the document, slicing body blocks under the current outline path."""
    heading_at = build_heading_index(doc)
    stack: list[tuple[int, str]] = []
    passages: list[dict] = []

    for p in range(doc.page_count):
        headings = sorted(heading_at.get(p, []))

        for lines in page_blocks(doc[p]):
            if is_page_number(lines):
                continue

            y = lines[0][1]
            for hy, level, title in headings:
                if abs(hy - y) < 3:                       # this block IS a heading
                    stack = [x for x in stack if x[0] < level] + [(level, title)]
                    break
            else:
                text = join_lines(lines)
                if not text or TABLE_HEAD.match(text):
                    continue                               # repeated table header
                if is_table_row(lines):
                    kind = "course_listing"
                else:
                    kind = "prose"
                passages.append({
                    "page": p + 1,
                    "chapter": level_text(stack, 1),
                    "section": level_text(stack, 2),
                    "subsection": level_text(stack, 3),
                    "heading_path": " > ".join(t for _, t in stack),
                    "kind": kind,
                    "text": text,
                })
    return [p for p in passages if p["chapter"]]


def level_text(stack, level: int) -> str:
    vals = [t for lv, t in stack if lv == level]
    return vals[-1] if vals else ""


def merge_course_rows(passages: list[dict]) -> list[dict]:
    """Collapse consecutive course rows in one subsection into a single passage."""
    merged: list[dict] = []
    buf: list[dict] = []

    def flush():
        if not buf:
            return
        chunk: list[str] = []
        for row in buf:
            chunk.extend(row["text"].split())
            if len(chunk) >= MAX_MERGED_WORDS:
                merged.append({**buf[0], "text": " ".join(chunk)})
                chunk = []
        if chunk:
            merged.append({**buf[0], "text": " ".join(chunk)})
        buf.clear()

    for p in passages:
        if p["kind"] != "course_listing":
            flush()
            merged.append(p)
        elif buf and p["heading_path"] != buf[0]["heading_path"]:
            flush()
            buf.append(p)
        else:
            buf.append(p)
    flush()
    return merged


def merge_continuations(passages: list[dict]) -> list[dict]:
    """Rejoin paragraphs that a page break split mid-sentence.

    A paragraph running over a page boundary comes back as two blocks, the
    second starting mid-sentence ("community where those who study...").  Those
    units are not interpretable on their own, so glue them back together.
    """
    out: list[dict] = []
    for p in passages:
        prev = out[-1] if out else None
        # A block mislabelled "course_listing" that carries no course code is
        # really prose, so let it rejoin too; a real listing row never does.
        continues = (
            prev is not None
            and not (p["kind"] == "course_listing" and COURSE_CODE.match(p["text"]))
            and p["heading_path"] == prev["heading_path"]
            and (p["text"][:1].islower()
                 or not prev["text"].rstrip().endswith((".", "!", "?")))
        )
        # "a. For students..." / "o Exploratory Courses..." are list items, not
        # the tail of the previous paragraph, so they always stand alone.
        if continues and not LIST_ITEM.match(p["text"]):
            prev["text"] = norm(f"{prev['text'].rstrip()} {p['text']}")
        else:
            out.append(dict(p))
    return out


def clean(passages: list[dict]) -> list[dict]:
    """Task 3: drop duplicates / junk and normalise whitespace."""
    seen = set()
    out = []
    for p in passages:
        text = norm(p["text"])
        if len(text.split()) < 3:          # stray markers, single words
            continue
        if text in seen:
            continue
        seen.add(text)
        p["text"] = text
        out.append(p)
    return out


def main() -> int:
    if not PDF_PATH.exists():
        print(f"missing PDF: {PDF_PATH}", file=sys.stderr)
        return 1

    doc = pymupdf.open(PDF_PATH)
    raw = extract(doc)
    staged = merge_course_rows(raw) if MERGE_COURSE_ROWS else raw
    # Clean first: a dropped fragment sitting between two halves of a split
    # paragraph would otherwise block them from rejoining.
    passages = clean(merge_continuations(clean(staged)))

    for i, p in enumerate(passages, 1):
        p["passage_id"] = f"p{i:04d}"

    fields = ["passage_id", "chapter", "section", "subsection",
              "page", "text", "heading_path", "kind"]
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(passages)

    words = [len(p["text"].split()) for p in passages]
    print(f"pages in PDF            : {doc.page_count}")
    print(f"passages before cleaning: {len(raw)}")
    print(f"passages after cleaning : {len(passages)}")
    print(f"average passage length  : {sum(words)/len(words):.1f} words")
    print(f"chapters                : {len({p['chapter'] for p in passages})}")
    print(f"sections                : {len({p['section'] for p in passages})}")
    print(f"subsections             : {len({p['subsection'] for p in passages if p['subsection']})}")
    print(f"kind                    : {dict(Counter(p['kind'] for p in passages))}")
    print(f"\nwrote {OUT_PATH.relative_to(HERE.parent)}")
    print("\ntop sections by passage count:")
    for name, n in Counter(p["section"] for p in passages).most_common(8):
        print(f"  {n:>5}  {name[:70]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
