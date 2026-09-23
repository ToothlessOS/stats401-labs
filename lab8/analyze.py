"""Lab 8 - Tasks 3-10 and 14: embed, project, cluster, label, and export.

Reads the passage table from preprocess.py, builds MiniLM embeddings and their
cosine similarities, projects to 2-D with UMAP, clusters the *original* vectors
with KMeans, names the clusters from TF-IDF terms, and writes the three tables
every later step reads:

    data/processed_bulletin.csv          full analysis table (provenance + terms)
    data/lab8_embedding_map.csv          Task 10: what the D3 map loads
    data/lab8_topic_section_matrix.csv   Task 14: View 2

Run:  uv run lab8/analyze.py
"""

from pathlib import Path

import pandas as pd
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import KMeans
from sklearn.preprocessing import normalize
import numpy as np
import umap

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"

df = pd.read_csv(DATA / "bulletin_passages.csv")

df = df.dropna(subset=["text"])
df = df.drop_duplicates(subset=["text"])

df["text_clean"] = df["text"].str.replace(r"\s+", " ", regex=True).str.strip()

# 11 passages sit under no formal section (the welcome letter, the calendar, the
# contacts page) and 188 under no subsection.  Filled here, once, so no
# downstream reader has to special-case an empty string - and so the strings in
# the CSV match what the page displays.
NO_SECTION, NO_SUBSECTION = "(no section)", "(no subsection)"
df["section"] = df["section"].fillna(NO_SECTION)
df["subsection"] = df["subsection"].fillna(NO_SUBSECTION)

# Basic Corpus Analysis
df["word_count"] = df["text_clean"].str.split().str.len()

print("\nWord Count:")
print(df["word_count"].describe())

print("\nSections:")
print(df["section"].value_counts())

# Semantic analysis

# Embedding
model = SentenceTransformer("all-MiniLM-L6-v2")
embeddings = model.encode(df["text_clean"].tolist(), normalize_embeddings=True)
print(embeddings.shape)  # (paragraphs, 384)

# Semantic Similarity
similarity = cosine_similarity(embeddings)
print(similarity.shape)  # (paragraphs, paragraphs)

# Nearest neighbours, exported rather than left to the browser: the 384-d
# vectors are never written to disk, so the page cannot recompute 1368 of these
# (it would need the whole embedding matrix), and the ones it could derive from
# the 2-D UMAP coordinates are not the same neighbours - UMAP distorts
# distances, which is the whole reason Task 8 says not to read the axes.
N_NEIGHBOURS = 5
np.fill_diagonal(similarity, -1.0)  # a passage is not its own neighbour
neighbour_idx = np.argsort(-similarity, axis=1)[:, :N_NEIGHBOURS]
neighbour_sim = np.take_along_axis(similarity, neighbour_idx, axis=1)

ids = df["passage_id"].to_numpy()
df["nn"] = [" ".join(ids[row]) for row in neighbour_idx]
df["nn_sim"] = [" ".join(f"{s:.3f}" for s in row) for row in neighbour_sim]

print(f"neighbours: top {N_NEIGHBOURS} per passage")
print(f"  mean top-1 cosine: {neighbour_sim[:, 0].mean():.3f}"
      f"   weakest top-1: {neighbour_sim[:, 0].min():.3f}")
cross = (df["section"].to_numpy()[neighbour_idx] != df["section"].to_numpy()[:, None])
print(f"  {cross.mean() * 100:.0f}% of neighbour links cross a formal section")

# UMAP
reducer = umap.UMAP(
    n_components=2, n_neighbors=15, min_dist=0.15, metric="cosine", random_state=401
)

coords = reducer.fit_transform(embeddings)

df["x"] = coords[:, 0]
df["y"] = coords[:, 1]

# Cluster and Label Semantic Topics
X = normalize(
    embeddings, norm="l2", axis=1
)  # Normalize first (to play with cosine similairty)
kmeans = KMeans(n_clusters=11, random_state=401, n_init="auto")
# Use k = 11 based on intertia and silhoutte score analysis, see `elbow.png`

df["cluster"] = kmeans.fit_predict(X)

# Characteristic Terms per Cluster (TF-IDF) -> cluster labels
#
# The embeddings place the passages; TF-IDF only names the groups.  Stop words
# are dropped here and nowhere else, since removing them would hurt the
# embeddings above.
vectorizer = TfidfVectorizer(
    stop_words="english",
    ngram_range=(1, 2),  # "study away", "academic integrity"
    min_df=3,
    sublinear_tf=True,
    token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z'\-]+\b",  # words, not course codes
)
T = vectorizer.fit_transform(df["text_clean"])
terms = vectorizer.get_feature_names_out()
is_word = np.array([" " not in t for t in terms])
is_phrase = np.array([" " in t for t in terms])
print(f"\nTF-IDF matrix: {T.shape[0]} passages x {T.shape[1]} terms")


def cluster_terms(mask, top=12):
    """Terms the cluster uses more than the corpus as a whole does.

    Mean tf-idf inside the cluster over mean tf-idf outside it, so terms that
    are merely common everywhere ("university", "students") score near 1 and
    drop out.  A term also has to appear in a minimum share of the cluster's
    passages, otherwise one odd passage can top the list with a huge ratio;
    phrases are rarer than single words, so they get the lower bar.
    """
    inside = np.asarray(T[mask].mean(axis=0)).ravel()
    outside = np.asarray(T[~mask].mean(axis=0)).ravel()
    share = np.asarray((T[mask] > 0).mean(axis=0)).ravel()

    score = inside / (outside + 1e-9)

    def best(keep, min_share):
        idx = np.where(keep & (share >= min_share) & (inside > 0))[0]
        idx = idx[np.argsort(-score[idx])][:top]
        return [terms[i] for i in idx]

    return best(is_word, 0.10), best(is_phrase, 0.04)


def passage_terms(mask, top=12):
    score = np.asarray(T[mask].mean(axis=0)).ravel()

    def best(keep):
        idx = np.where(keep)[0]
        idx = idx[np.argsort(-score[idx])][:top]
        return [terms[i] for i in idx]

    return best(is_word), best(is_phrase)


# Labels read off the terms above plus the sample passages printed at the end.
# They are an interpretation of the clusters, not an output of the model, so
# check them against the samples before using them in the write-up.
CLUSTER_LABELS = {
    0: "Biology, Chemistry & Environmental Science",
    1: "Advanced Placement, Credit & Electives",
    2: "China & Asia (DKU Background Info; China & Asia stuides)",
    3: "Course Prerequisites",
    4: "Media, Film & Visual Arts",
    5: "Interdisciplinary Seminars & Learning Goals",
    6: "History, Religion & Society",
    7: "Institutional & Transfer Credit",
    8: "Public Policy & Economics",
    9: "Academic Standing, Leave & Withdrawal",
    10: "Computer Science, Math & Data Science",
}

# The matrix has 11 columns and the full labels above run to 44 characters, so
# each column needs a form that fits under a ~78px header.  Kept beside the long
# labels, and written into the same CSV, so the two can never drift apart.
CLUSTER_SHORT_LABELS = {
    0: "Bio / Chem / Env",
    1: "AP & Electives",
    2: "China & Asia",
    3: "Prerequisites",
    4: "Media & Film",
    5: "Seminars",
    6: "History & Religion",
    7: "Transfer Credit",
    8: "Policy & Economics",
    9: "Standing & Leave",
    10: "CS / Math / Data",
}

# Inspect: each label against the passages it was read off.
# Set PREVIEW_CHARS = 0 to print the passages in full.
PREVIEW_CHARS = 200

for c in sorted(df["cluster"].unique()):
    subset = df[df["cluster"] == c]
    label = CLUSTER_LABELS.get(c, "UNLABELLED")
    print(f"\nCLUSTER {c} - {label}  ({len(subset)} passages)")
    for text in subset["text_clean"].head(10):
        if PREVIEW_CHARS and len(text) > PREVIEW_CHARS:
            text = text[:PREVIEW_CHARS].rstrip() + " ..."
        print("-", text)

rows = []
for c in sorted(df["cluster"].unique()):
    mask = (df["cluster"] == c).to_numpy()
    print(mask.shape)
    words, phrases = cluster_terms(mask)

    print(f"\nCLUSTER {c}  ({mask.sum()} passages)")
    print("  words   :", ", ".join(words))
    print("  phrases :", ", ".join(phrases))

    rows.append(
        {
            "cluster": c,
            "n_passages": int(mask.sum()),
            "label": CLUSTER_LABELS.get(c, "?"),
            "short_label": CLUSTER_SHORT_LABELS.get(c, "?"),
            "top_words": ", ".join(words),
            "top_phrases": ", ".join(phrases),
        }
    )


df["cluster_name"] = df["cluster"].map(CLUSTER_LABELS)
df["cluster_short"] = df["cluster"].map(CLUSTER_SHORT_LABELS)
print("\nwrote data/lab8_cluster_terms.csv")

print("\ncluster sizes and labels")
print(df.groupby(["cluster", "cluster_name"]).size().to_string())

pd.DataFrame(rows).to_csv(DATA / "lab8_cluster_terms.csv", index=False)

# Append Each Passage's TF-IDF Terms into the df
# dtype=object, not str: np.full(..., dtype=str) gives a fixed-width <U1
# array, which silently truncates every term list to its first character.
add_TF_IDF = np.full((T.shape[0], 2), "", dtype=object)
for i in range(T.shape[0]):
    mask = np.zeros(T.shape[0], dtype=bool)
    mask[i] = True
    words, phrases = passage_terms(mask)
    add_TF_IDF[i, 0] = ", ".join(words)
    add_TF_IDF[i, 1] = ", ".join(phrases)
add_TF_IDF = pd.DataFrame(add_TF_IDF, columns=["words", "phrases"], index=df.index)
df = pd.concat([df, add_TF_IDF], axis=1)

print(df.info())
print(df.head())

df.to_csv(DATA / "processed_bulletin.csv", index=False)

# ---------------------------------------------------------------------------
# Task 14 - View 2: the Topic x Bulletin Section matrix
# ---------------------------------------------------------------------------
#
# Sparse on purpose - it mirrors the groupby().size() the assignment sketches,
# and the 727 empty (section, topic) pairs are as much a finding as the 142
# filled ones.  The page reads a missing key as zero.
#
# Both shares ship because they answer different questions and can disagree
# sharply.  prop_of_section is the page's default fill: the matrix is read
# row-wise ("what is this section made of?"), and a row normalised by section
# sums to 1, which is what makes the diversity question answerable off the row.
# Normalising by topic instead would make every row track global cluster size
# and flatten all 79 other sections next to Course Descriptions.
print("\nmatrix")
n_topic = df.groupby("cluster").size()
matrix = (
    df.groupby(["section", "cluster", "cluster_name", "cluster_short"])
    .size()
    .reset_index(name="count")
)
matrix["n_section"] = matrix["section"].map(df.groupby("section").size())
matrix["prop_of_section"] = (matrix["count"] / matrix["n_section"]).round(4)
matrix["prop_of_topic"] = (matrix["count"] / matrix["cluster"].map(n_topic)).round(4)

# Row order in the file is the default row order on the page: biggest section
# first.  "(no section)" carries 11 passages, so it sorts in among the small
# real sections rather than last - the page marks it out by label instead.
matrix = matrix.sort_values(
    ["n_section", "section", "cluster"], ascending=[False, True, True]
)

n_sections = df["section"].nunique()
print(f"  {len(matrix)} non-empty cells of {n_sections} x {df['cluster'].nunique()}"
      f"  ({1 - len(matrix) / (n_sections * df['cluster'].nunique()):.0%} empty)")
print(f"  totals {matrix['count'].sum()} passages across all rows")
matrix.to_csv(DATA / "lab8_topic_section_matrix.csv", index=False)

# ---------------------------------------------------------------------------
# Task 10 - View 1: the table the D3 map loads
# ---------------------------------------------------------------------------
#
# A subset of processed_bulletin.csv.  text_clean is byte-identical to text for
# every row here, and heading_path and kind are never read by the page.  The
# per-passage words/phrases columns stay out as well: they are 0.4 MB of TF-IDF
# terms for a detail panel that already shows the passage itself, and the
# cluster-level terms they were derived from are in lab8_cluster_terms.csv.
MAP_COLUMNS = [
    "passage_id", "chapter", "section", "subsection", "page",
    "cluster", "cluster_name", "cluster_short",
    "x", "y", "word_count", "text", "nn", "nn_sim",
]

map_df = df[MAP_COLUMNS].copy()
map_df["x"] = map_df["x"].round(4)  # 4 dp is well under a pixel at 920px wide
map_df["y"] = map_df["y"].round(4)
map_df.to_csv(DATA / "lab8_embedding_map.csv", index=False)

print(f"\nwrote data/processed_bulletin.csv, data/lab8_embedding_map.csv "
      f"({len(map_df)} rows), data/lab8_topic_section_matrix.csv")
