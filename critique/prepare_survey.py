"""Critique - turn the FlightSim Community Survey 2026 into simulator flow data.

The redesign on the critique page rebuilds the Sankey in ref.png ("Simulator
switching - of the users that switched, where did they go?").  That figure
collapses P3D, Infinite Flight and DCS into one "Other" node, which hides the
flows worth showing, so the underlying two-column data has to be extracted
first.

The survey never records "previous simulator".  It asks two things:

    Which.one.is.currently.your.primary.flight.simulator.software.   (col 117)
    Have.you.switched.your.primary.flight.simulation.software.in.the.past.12.months.  (col 118)

and col 118 is free text whose dominant form is "Yes, from <Simulator>".  So
`previous` is derived by parsing the text after "Yes, from", and everything
below is really about surviving that free text.

Both columns are far dirtier than the field count suggests: 306 distinct
`current` values and 202 distinct switch values across 42332 rows, where only
about a dozen in each are real answers.  The rest is casing and spelling
variance (GeoFS/geofs/geo fs, FSX/Fsx/fsx/FSX Steam/Microsoft FSX - the last
spread over nine spellings that together rival P3D), prose answers, mobile
platforms, refusal tokens and keyboard mash.

Cleaning therefore runs in three ordered tiers, and anything that matches none
of them is *dropped* rather than bucketed, so no uninterpretable value reaches
the page:

    1. the eight categories named in prompts-data-prep.md
    2. six minor sims promoted to their own labels (FSX, FlightGear, AeroFly,
       Rortos, Falcon BMS, Aerowinx) - large enough to be worth seeing
    3. known-but-tiny sims (Condor, War Thunder, IL-2, X-Plane 10, ...) -> Others

A row survives only when *both* columns hold a proper answer.

Writes:
    data/survey_flows_all.csv          current,previous for every kept row
    data/survey_flows_switchers.csv    the switchers only
    data/survey_flow_matrix.csv        wide from->to grid, diagonal included
    data/survey_flow_matrix_switchers.csv  the same grid, diagonal zeroed
    data/survey_eda.md                 the EDA, as markdown
    public/data/survey_flow*.csv       copies for src/critique.js to fetch

The public/ copy lives here rather than in a separate exporter as in lab8: the
export is a copy of two small CSVs, and public/data/ is the only place Vite
copies to dist/, so without it the deployed page 404s on its own data.

Run:  uv run critique/prepare_survey.py
"""

from __future__ import annotations

import csv
import re
import shutil
import sys
import unicodedata
from collections import Counter
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "data"
PUBLIC_DATA = ROOT / "public" / "data"

SOURCE = HERE / "FlightSim-Community-Survey-2026-Data" / "survey_data_2026_shareable.csv"
CURRENT_COL = 117
SWITCH_COL = 118

# Category order, used for the output files and every table in the EDA.  The
# majors keep the order given in prompts-data-prep.md; the promoted minors
# follow, largest first, with the catch-all last.
LABELS = [
    "MSFS2024", "MSFS2020", "XP12", "XP11", "GeoFS", "P3D",
    "Infinite Flight", "DCS",
    "FlightGear", "AeroFly", "FSX", "Rortos", "Falcon BMS", "Aerowinx",
    "Others",
]

# Tier 1 and tier 2.  Order is load-bearing, not cosmetic:
#   - the 2024/2020 rules must run before any loose `fs` rule;
#   - `geo fs` before the bare `fs` alternative can see it;
#   - `flight simulator x` finds no 20/24 suffix, so it falls through to the
#     FSX rule rather than being caught as an MSFS.
MAJOR_SIMS = [
    ("MSFS2024", r"(microsoft )?(flight ?simulator|flightsimulator|ms ?fs|mfs|fs) ?(20)?24|ms ?2024"),
    ("MSFS2020", r"(microsoft )?(flight ?simulator|flightsimulator|ms ?fs|mfs|fs) ?(20)?20|ms ?2020"),
    ("XP12", r"(laminar research )?(x ?-? ?plane|xplane|xp) ?(12|twelve)"),
    ("XP11", r"(laminar research )?(x ?-? ?plane|xplane|xp) ?(11|eleven)"),
    ("GeoFS", r"geo ?fs"),
    ("P3D", r"(lockheed )?(martin )?(prepar ?3d|p3d)"),
    ("Infinite Flight", r"infinite ?flight"),
    ("DCS", r"dcs( world)?"),
]

MINOR_SIMS = [
    ("FSX", r"(microsoft )?(flight ?simulator x|fs ?x|ms ?fsx|mfsx|msfx)( ?(se|steam)( edition)?)?"),
    ("FlightGear", r"flight ?gear"),
    ("AeroFly", r"aerofly"),
    ("Rortos", r"rortos"),
    ("Falcon BMS", r"falcon bms"),
    ("Aerowinx", r"aerowinx"),
]

# Tier 3.  Recognisably a simulator, but only ever a handful of respondents.
OTHERS = re.compile(
    r"condor|war ?thunder|vtol ?vr|il ?-? ?2|sturmovik|rfs|real flight|fs ?9|fs ?200[24]"
    r"|ms2004|x ?-? ?plane|roblox|ptfs|project flight|elite|heli ?x|simple plane"
    r"|monaco|wright flyer|turboprop flight|airline commander|google earth|\bxp\b"
)

# Values that name no simulator at all, for the EDA's drop breakdown.  Anything
# reaching classify() and matching none of the above is dropped, so this only
# exists to explain *why* in the report.
REFUSALS = {
    "no", "n", "non", "none", "none of the above", "na", "nothing", "other",
    "idk", "i dont know", "i don t know", "dont know", "don t know", "i forgot",
    "i havent", "i dont have one", "i don t have one", "o", "r", "ok", "okay",
    "yes", "y",
}
PLATFORMS = {"android", "iphone", "ipad", "phone", "mobile", "apple", "google", "pc"}

# Submitted values that are not survey answers at all.  Nothing here is ever
# executed - it is matched only so the EDA can report it rather than silently
# folding it into "keyboard mash".
NON_ANSWER = re.compile(
    r"cmd exe|powershell|shell:|\.exe|<\s*script|rm -rf|curl |wget |\|\s*sh|/c start"
)

TOP_RAW = 25


def normalize(s: object) -> str:
    """Fold a raw cell to comparable text.

    Case, dashes and punctuation all vary between respondents, and the survey
    exports both "GeoFS" and "geofs".  NFKD also splits the accented characters
    a few respondents typed.
    """
    if pd.isna(s):
        return ""
    s = unicodedata.normalize("NFKD", str(s)).lower()
    s = s.replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9+\- ]", " ", s)).strip()


def classify(s: object) -> str | None:
    """Map one cell to a category, or None if it names no simulator."""
    text = normalize(s)
    if not text:
        return None
    # "Yes, from GeoFS" and a bare "GeoFS" carry the same information.  "grom"
    # is the commonest typo in the switch column.
    text = re.sub(r"^(yes )?(from |grom )?", "", text).strip()
    if not text:
        return None
    for label, pattern in MAJOR_SIMS:
        if re.search(pattern, text):
            return label
    for label, pattern in MINOR_SIMS:
        if re.search(pattern, text):
            return label
    if OTHERS.search(text):
        return "Others"
    return None


def drop_reason(s: object) -> str:
    """Explain why a value did not classify, for the EDA's drop table."""
    text = normalize(s)
    if not text:
        return "blank"
    if NON_ANSWER.search(text):
        return "not an answer (shell/script text)"
    if text in REFUSALS:
        return "refusal / no simulator named"
    if text in PLATFORMS:
        return "mobile platform, not a simulator"
    if len(text) <= 2:
        return "keyboard mash"
    return "unrecognised prose"


def load() -> pd.DataFrame:
    """Read only the two columns we need - the file is 197 MB of 1249 columns."""
    if not SOURCE.exists():
        raise SystemExit(f"missing survey export: {SOURCE}")
    df = pd.read_csv(
        SOURCE, usecols=[CURRENT_COL, SWITCH_COL],
        encoding="utf-8-sig", low_memory=False,
    )
    return df.set_axis(["current_raw", "switch_raw"], axis=1)


def build(df: pd.DataFrame) -> pd.DataFrame:
    """Attach the cleaned labels and the switcher flag."""
    out = df.copy()
    out["current"] = out["current_raw"].map(classify)

    # "No" is a real answer meaning "I did not switch"; it is not a simulator,
    # so it is removed before classifying and recorded as its own flag.
    said_no = out["switch_raw"].map(lambda s: normalize(s) == "no")
    from_text = out["switch_raw"].map(classify)
    out["switched"] = from_text.notna() & ~said_no
    out["previous"] = from_text.where(~said_no, out["current"])
    return out


def clean(df: pd.DataFrame) -> pd.DataFrame:
    """Keep rows where both columns hold a proper answer, and fill `previous`.

    A row with a valid `current` but an unreadable switch answer is dropped
    rather than assumed loyal: the survey never recorded that they stayed.
    """
    keep = df["current"].notna() & (df["switched"] | df["previous"].notna())
    out = df.loc[keep, ["current", "previous", "switched"]].copy()
    # Non-switchers stayed where they are, which is what makes the all-users
    # file a retention baseline as well as a flow table.
    out.loc[~out["switched"], "previous"] = out.loc[~out["switched"], "current"]
    order = {label: i for i, label in enumerate(LABELS)}
    out = out.sort_values(
        ["current", "previous"],
        key=lambda col: col.map(order),
        kind="stable",
    )
    return out.reset_index(drop=True)


def write_csvs(flows: pd.DataFrame) -> tuple[int, int]:
    DATA.mkdir(parents=True, exist_ok=True)
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)

    all_rows = flows[["current", "previous"]]
    # Keyed on having reported a switch, NOT on previous != current: about 2000
    # respondents moved away and back, and a != filter would drop them and make
    # this file disagree with the all-users one.
    switchers = flows.loc[flows["switched"], ["current", "previous"]]

    for name, frame in [
        ("survey_flows_all.csv", all_rows),
        ("survey_flows_switchers.csv", switchers),
    ]:
        frame.to_csv(DATA / name, index=False, quoting=csv.QUOTE_MINIMAL)
        shutil.copy2(DATA / name, PUBLIC_DATA / name)
    return len(all_rows), len(switchers)


def write_matrix(flows: pd.DataFrame) -> tuple[int, int]:
    """Wide from->to grids: one row per previous simulator, one column per current.

    The two files differ only in the diagonal, which keeps them trivially
    reconcilable:

        survey_flow_matrix.csv            every kept row, so the diagonal counts
                                          everyone who did not move - the
                                          loyalty baseline behind the redesign
        survey_flow_matrix_switchers.csv  the same grid with the diagonal zeroed,
                                          leaving genuine moves only

    Note the diagonal of the full grid is not just loyal respondents: it also
    holds the ~2000 who moved away and came back, who are indistinguishable
    from stayers once only the endpoint pair is recorded.

    Kept wide rather than tidy because that is the form you can check against
    ref.png by eye; a Sankey only has to walk the non-zero cells.
    """
    matrix = pd.crosstab(flows["previous"], flows["current"])
    matrix = matrix.reindex(index=LABELS, columns=LABELS, fill_value=0)

    switched = matrix.copy()
    for label in LABELS:
        switched.loc[label, label] = 0

    for name, frame in [
        ("survey_flow_matrix.csv", matrix),
        ("survey_flow_matrix_switchers.csv", switched),
    ]:
        out = frame.copy()
        out.index.name = "previous"
        out["total"] = frame.sum(axis=1)
        out.to_csv(DATA / name)
        shutil.copy2(DATA / name, PUBLIC_DATA / name)

    return int(matrix.values.sum()), int(switched.values.sum())


def md_table(rows: list[list[object]], header: list[str]) -> str:
    lines = ["| " + " | ".join(str(h) for h in header) + " |"]
    lines.append("|" + "|".join("---" for _ in header) + "|")
    for row in rows:
        lines.append("| " + " | ".join(str(c) for c in row) + " |")
    return "\n".join(lines)


def value_table(series: pd.Series, limit: int | None = None) -> str:
    counts = series.value_counts(dropna=False)
    if limit:
        counts = counts.head(limit)
    rows = [
        [f"`{'' if pd.isna(v) else v}`" if len(str(v)) < 60 else f"`{str(v)[:57]}...`", n]
        for v, n in counts.items()
    ]
    return md_table(rows, ["raw value", "rows"])


def drop_table(df: pd.DataFrame, column: str, valid_no: bool) -> str:
    """Raw values that survived into the output as nothing, grouped by reason."""
    raw = df[column]
    if valid_no:
        raw = raw.where(raw.map(lambda s: normalize(s) != "no"))
    unclassified = raw[raw.map(classify).isna() & raw.notna()]
    grouped: dict[str, Counter] = {}
    for value in unclassified:
        grouped.setdefault(drop_reason(value), Counter())[normalize(value)] += 1

    out = []
    total = 0
    for reason, counter in sorted(grouped.items(), key=lambda kv: -sum(kv[1].values())):
        n = sum(counter.values())
        total += n
        shown = ", ".join(
            f"`{v}` ({c})" if len(v) < 40 else f"`{v[:37]}...` ({c})"
            for v, c in counter.most_common(12)
        )
        more = f" _(+{len(counter) - 12} more)_" if len(counter) > 12 else ""
        out.append([reason, n, shown + more])
    out.append(["**total dropped here**", f"**{total}**", ""])
    return md_table(out, ["reason", "rows", "examples (count)"])


def build_eda(df: pd.DataFrame, flows: pd.DataFrame, n_all: int, n_sw: int) -> str:
    cur_counts = flows["current"].value_counts()
    prev_counts = flows["previous"].value_counts()
    matrix = pd.crosstab(flows["previous"], flows["current"])
    matrix = matrix.reindex(index=LABELS, columns=LABELS, fill_value=0)

    diag = int(sum(matrix.loc[c, c] for c in LABELS))

    parts = [
        "# FlightSim Community Survey 2026 - EDA of the recorded response format",
        "",
        "Generated by `critique/prepare_survey.py`. Do not edit by hand.",
        "",
        "## 1. Source",
        "",
        f"- `{SOURCE.relative_to(ROOT)}` - {len(df)} rows, 1249 columns, 197 MB.",
        "- Two columns are relevant, and neither records a previous simulator:",
        "",
        md_table(
            [
                [117, "`Which.one.is.currently.your.primary.flight.simulator.software.`"],
                [118, "`Have.you.switched.your.primary.flight.simulation.software.in.the.past.12.months.`"],
            ],
            ["index", "field"],
        ),
        "",
        "`previous` is therefore derived, by parsing the text after `Yes, from` in column 118.",
        "",
        "## 2. How dirty is the raw text?",
        "",
        md_table(
            [
                ["current", len(df), int(df["current_raw"].isna().sum()),
                 int(df["current_raw"].nunique(dropna=True)),
                 int(df["current"].nunique(dropna=True))],
                ["switch answer", len(df), int(df["switch_raw"].isna().sum()),
                 int(df["switch_raw"].nunique(dropna=True)),
                 int(flows["previous"].nunique(dropna=True))],
            ],
            ["column", "rows", "blank", "distinct raw", "labels after cleaning"],
        ),
        "",
        f"Cleaning resolves {df['current_raw'].nunique(dropna=True)} raw `current` values to "
        f"{cur_counts.size} labels. The rows below show why the raw text is unusable as-is.",
        "",
        "### Top 25 raw values - `current`",
        "",
        value_table(df["current_raw"], TOP_RAW),
        "",
        "### Top 25 raw values - switch answer",
        "",
        value_table(df["switch_raw"], TOP_RAW),
        "",
        "## 3. Dropped values",
        "",
        "Every value below names no simulator, so the row carrying it was dropped. Grouped by "
        "why. This is the only judgement call in the pipeline, so it is listed in full.",
        "",
        "### `current`",
        "",
        drop_table(df, "current_raw", valid_no=False),
        "",
        "### switch answer",
        "",
        "`No` is excluded here: it is a valid answer meaning the respondent did not switch.",
        "",
        drop_table(df, "switch_raw", valid_no=True),
        "",
        "## 4. Cleaned result",
        "",
        f"{n_all} rows survive both filters, of which {n_sw} reported a switch.",
        "",
        "### Label totals",
        "",
        md_table(
            [
                [label, int(cur_counts.get(label, 0)), int(prev_counts.get(label, 0))]
                for label in LABELS
            ],
            ["label", "current", "previous"],
        ),
        "",
        "### Previous -> current",
        "",
        f"{diag} respondents switched back to the simulator they came from, which is why the "
        "switchers file is keyed on having reported a switch rather than on `previous != current`.",
        "",
        md_table(
            [[f"**{from_}**"] + [int(matrix.loc[from_, to]) for to in LABELS] for from_ in LABELS],
            ["from \\ to"] + LABELS,
        ),
        "",
    ]
    return "\n".join(parts)


def main() -> int:
    raw = load()
    labelled = build(raw)
    flows = clean(labelled)

    n_all, n_sw = write_csvs(flows)
    n_grid, n_moves = write_matrix(flows)

    eda = build_eda(labelled, flows, n_all, n_sw)
    (DATA / "survey_eda.md").write_text(eda, encoding="utf-8")

    counts = flows["current"].value_counts()
    print(f"rows in survey          : {len(raw)}")
    print(f"current unreadable      : {int(labelled['current'].isna().sum())}")
    print(f"switch answer unreadable: {int((~labelled['switched'] & labelled['previous'].isna()).sum())}")
    print(f"rows kept               : {n_all}")
    print(f"  non-switchers         : {n_all - n_sw}")
    print(f"  switchers             : {n_sw}")
    print(f"labels                  : {len(LABELS)}")
    print("\ntop categories by current simulator:")
    for label, n in counts.items():
        print(f"  {n:>6}  {label}")
    print(f"\nflow matrix cells       : {n_grid} across {len(LABELS)}x{len(LABELS)}")
    print(f"  off-diagonal (moved)  : {n_moves}")
    print(f"  on-diagonal (stayed)  : {n_grid - n_moves}")
    print("\nwrote under data/ and public/data/:")
    for name in (
        "survey_flows_all.csv",
        "survey_flows_switchers.csv",
        "survey_flow_matrix.csv",
        "survey_flow_matrix_switchers.csv",
    ):
        print(f"  {name}")
    print("wrote data/survey_eda.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
