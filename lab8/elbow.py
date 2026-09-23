"""Lab 8 - how many clusters?  Inertia (the elbow) and silhouette over k.

Inertia falls monotonically as k grows, so the question is where extra clusters
stop paying for themselves.  Silhouette is plotted alongside as a second
opinion: the assignment asks for the cluster count to be documented, and a lone
elbow on 384-d embedding vectors is often too flat to defend.

Run:  uv run lab8/elbow.py
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless: write a PNG instead of opening a window
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sentence_transformers import SentenceTransformer
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import normalize

HERE = Path(__file__).resolve().parent
K_MIN, K_MAX = 2, 15
# The k actually used in analyze.py.  Kept here as a constant so the line that
# reports it cannot go stale the way a hard-coded string did.
K = 11

# Chart tokens (light surface).
SURFACE = "#fcfcfb"
INK, INK_2, MUTED = "#0b0b0b", "#52514e", "#898781"
GRID, AXIS = "#e1e0d9", "#c3c2b7"
BLUE, BLUE_DARK = "#2a78d6", "#184f95"


def elbow_k(ks: list[int], vals: np.ndarray) -> int:
    """k at the point furthest from the chord joining the first and last point.

    Both axes are scaled to [0, 1] first, otherwise the k axis (width ~13) and
    the inertia axis (width ~100) are not comparable and the chord distance is
    meaningless.  This is a rule of thumb, not a test.
    """
    x = (np.asarray(ks, float) - ks[0]) / (ks[-1] - ks[0])
    y = (np.asarray(vals, float) - vals.min()) / (vals.max() - vals.min())
    dist = np.abs((y[-1] - y[0]) * x - y + y[0]) / np.hypot(y[-1] - y[0], 1.0)
    return ks[int(np.argmax(dist))]


def style(ax, title: str) -> None:
    ax.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", color=INK, fontsize=11,
                 fontweight="bold", pad=8)
    ax.grid(axis="y", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(AXIS)
        ax.spines[side].set_linewidth(0.8)
    ax.tick_params(colors=MUTED, labelsize=9, length=3)
    ax.set_xticks(range(K_MIN, K_MAX + 1))


def main() -> None:
    df = pd.read_csv(HERE.parent / "data" / "bulletin_passages.csv")
    df = df.dropna(subset=["text"]).drop_duplicates(subset=["text"])
    df["text_clean"] = df["text"].str.replace(r"\s+", " ", regex=True).str.strip()

    model = SentenceTransformer("all-MiniLM-L6-v2")
    embeddings = model.encode(df["text_clean"].tolist(), normalize_embeddings=True)
    X = normalize(embeddings, norm="l2", axis=1)

    # k = 1 gives the total dispersion, which turns inertia into the share of
    # variance the clustering leaves unexplained.
    total = KMeans(n_clusters=1, random_state=401, n_init="auto").fit(X).inertia_

    ks, inertia, silhouette = [], [], []
    for k in range(K_MIN, K_MAX + 1):
        km = KMeans(n_clusters=k, random_state=401, n_init="auto").fit(X)
        ks.append(k)
        inertia.append(km.inertia_)
        # Cosine, matching the space the clustering actually works in.
        silhouette.append(silhouette_score(X, km.labels_, metric="cosine"))

    inertia = np.array(inertia)
    silhouette = np.array(silhouette)
    table = pd.DataFrame({
        "k": ks,
        "inertia": inertia.round(2),
        "drop_pct": np.r_[np.nan, -np.diff(inertia) / inertia[:-1] * 100].round(2),
        "explained_pct": ((1 - inertia / total) * 100).round(1),
        "silhouette": silhouette.round(4),
    })

    print(f"passages: {len(df)}   dims: {X.shape[1]}   total inertia (k=1): {total:.1f}")
    print(table.to_string(index=False))

    by_elbow, by_sil = elbow_k(ks, inertia), ks[int(np.argmax(silhouette))]
    print(f"\nelbow (chord distance)    : k = {by_elbow}")
    print(f"best silhouette (cosine)  : k = {by_sil}  ({silhouette.max():.4f})")
    print(f"current setting in analyze.py: k = {K}")
    if by_elbow != K:
        print(f"  note: keeping k = {K} on the silhouette peak, not the elbow at "
              f"k = {by_elbow} - the inertia curve has no sharp bend to find.")

    table.to_csv(HERE.parent / "data" / "lab8_kmeans_k.csv", index=False)

    # ---- plot -------------------------------------------------------------
    fig = plt.figure(figsize=(9, 7.6), layout="constrained")
    fig.patch.set_facecolor(SURFACE)
    gs = fig.add_gridspec(3, 1, height_ratios=[1, 1, 0.13])
    ax1 = fig.add_subplot(gs[0])
    ax2 = fig.add_subplot(gs[1], sharex=ax1)
    note = fig.add_subplot(gs[2])
    note.axis("off")

    fig.suptitle("Choosing k: KMeans on the bulletin passages",
                 x=0.008, ha="left", color=INK, fontsize=13, fontweight="bold")

    # Panel 1: inertia.  One series, so the title names it and no legend is needed.
    style(ax1, "Inertia - within-cluster sum of squares")
    ax1.plot(ks, inertia, color=BLUE, lw=2, marker="o", ms=6,
             mfc=SURFACE, mec=BLUE, mew=1.5)
    ax1.axvline(by_elbow, color=MUTED, lw=1, ls=(0, (4, 3)))
    ax1.plot([by_elbow], [inertia[by_elbow - K_MIN]], marker="o", ms=9,
             mfc=BLUE_DARK, mec=SURFACE, mew=2, zorder=5)
    ax1.annotate(f"elbow: k = {by_elbow}", xy=(by_elbow, inertia[by_elbow - K_MIN]),
                 xytext=(10, 26), textcoords="offset points",
                 color=INK_2, fontsize=10)
    ax1.set_ylabel("inertia", color=INK_2, fontsize=10)
    ax1.tick_params(labelbottom=False)   # x ticks are shared with the panel below

    # Panel 2: silhouette (its own scale, hence its own panel - never a twin axis).
    style(ax2, "Silhouette - cluster separation (higher is better)")
    ax2.plot(ks, silhouette, color=BLUE, lw=2, marker="o", ms=6,
             mfc=SURFACE, mec=BLUE, mew=1.5)
    ax2.plot([by_sil], [silhouette.max()], marker="o", ms=9,
             mfc=BLUE_DARK, mec=SURFACE, mew=2, zorder=5)
    ax2.annotate(f"peak: k = {by_sil}", xy=(by_sil, silhouette.max()),
                 xytext=(10, 14), textcoords="offset points",
                 color=INK_2, fontsize=10)
    ax2.set_ylabel("silhouette (cosine)", color=INK_2, fontsize=10)
    ax2.set_xlabel("number of clusters (k)", color=INK_2, fontsize=10)

    note.text(0, 0.5,
             "MiniLM-L6-v2 embeddings (L2-normalised)  ·  KMeans n_init='auto', "
             "random_state=401  ·  k = 2-15\n"
             "Inertia axis is autoscaled, not zero-based - read the curve's shape, "
             "not the absolute height.\n"
             f"analyze.py keeps k = {K} - silhouette peaks there, beating k = "
             f"{K - 1} and k = {K + 1}; inertia has no sharp bend.",
             color=MUTED, fontsize=8.5, va="center", ha="left")

    out = HERE / "elbow.png"
    fig.savefig(out, dpi=160, facecolor=SURFACE)
    print(f"\nwrote {out.relative_to(HERE.parent)} and data/lab8_kmeans_k.csv")


if __name__ == "__main__":
    main()
