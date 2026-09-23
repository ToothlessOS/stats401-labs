"""Lab 8 - publish the browser-facing slice of the analysis.

`analyze.py` writes the full analytical tables, which carry provenance columns
and per-passage TF-IDF terms that the page never reads.  This trims those to the
one file the D3 map loads and copies everything the page fetches into public/,
which is the only place Vite copies to dist/ - the other files under lab8/ are
not served, so without this step the deployed page 404s on its own data.

Nothing is recomputed here.  The nearest-neighbour lists already came out of
analyze.py, which is the only place the 384-d embeddings ever exist.

Writes:
    public/data/lab8_embedding_map.csv         the map (Task 10)
    public/data/lab8_topic_section_matrix.csv  the matrix (Task 14)
    public/data/lab8_cluster_terms.csv         topic table and legend
    public/data/lab8_kmeans_k.csv              the k table beside elbow.png

elbow.png is deliberately not copied here: lab8/index.html references it
relatively, so Vite picks it up from the source tree and fingerprints it into
assets/, and a copy under public/ would just be a second untracked duplicate.

Run:  uv run lab8/export_web.py
"""

from __future__ import annotations

import shutil
from pathlib import Path
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "data"
PUBLIC_DATA = ROOT / "public" / "data"

# Expected shape of the analysis tables.  Checked rather than assumed: a change
# in analyze.py that silently drops a cluster or a passage would otherwise show
# up as a subtly wrong map rather than as a failure here.
N_PASSAGES, N_TOPICS, N_NEIGHBOURS = 1368, 11, 5

# The page reads all of these; text_clean is byte-identical to text for every
# row, and heading_path/kind/words/phrases are never displayed.
MAP_COLUMNS = [
    "passage_id", "chapter", "section", "subsection", "page",
    "cluster", "cluster_name", "cluster_short",
    "x", "y", "word_count", "text", "nn", "nn_sim",
]

COPIED = [
    "lab8_topic_section_matrix.csv",
    "lab8_cluster_terms.csv",
    "lab8_kmeans_k.csv",
]


def check(df: pd.DataFrame) -> None:
    """Fail loudly on anything the page would render as a wrong picture."""
    problems = []
    if len(df) != N_PASSAGES:
        problems.append(f"{len(df)} passages, expected {N_PASSAGES}")
    if df["cluster"].nunique() != N_TOPICS:
        problems.append(f"{df['cluster'].nunique()} topics, expected {N_TOPICS}")

    blanks = df[["chapter", "section", "subsection", "text"]].isna().sum().sum()
    if blanks:
        # analyze.py fills these; a NaN here would reach the page as "NaN".
        problems.append(f"{blanks} unfilled labels")

    nn_len = df["nn"].str.split().str.len()
    sim_len = df["nn_sim"].str.split().str.len()
    if not (nn_len == N_NEIGHBOURS).all() or not (sim_len == N_NEIGHBOURS).all():
        problems.append("neighbour columns are not all 5 long")

    ids = set(df["passage_id"])
    referenced = set(" ".join(df["nn"]).split())
    if not referenced <= ids:
        problems.append(f"{len(referenced - ids)} neighbours point at unknown ids")
    if any(pid in row.split() for pid, row in zip(df["passage_id"], df["nn"])):
        problems.append("a passage lists itself as its own neighbour")

    if problems:
        raise SystemExit("export_web: " + "; ".join(problems))


def main() -> None:
    df = pd.read_csv(DATA / "lab8_embedding_map.csv")
    check(df)

    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)

    df[MAP_COLUMNS].to_csv(PUBLIC_DATA / "lab8_embedding_map.csv", index=False)

    for name in COPIED:
        shutil.copy2(DATA / name, PUBLIC_DATA / name)

    print(f"{len(df)} passages, {df['cluster'].nunique()} topics")
    for path in sorted(PUBLIC_DATA.glob("lab8_*.csv")):
        print(f"  {path.relative_to(ROOT)}  ({path.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
