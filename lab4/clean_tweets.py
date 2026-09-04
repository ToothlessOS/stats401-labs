import pandas as pd
import re

# Dataset: https://www.kaggle.com/datasets/kazanova/sentiment140
cols = ["target", "ids", "date", "flag", "user", "text"]
df = pd.read_csv(
    "training.1600000.processed.noemoticon.csv",
    encoding="latin-1",
    header=None,
    names=cols,
)

# Convert the df['date'] datatype to datetime
df["date"] = (
    pd.to_datetime(
        df["date"].str.replace(" PDT", ""),
        errors="raise",
        format="%a %b %d %H:%M:%S %Y",
    )
).dt.tz_localize(
    "America/Los_Angeles",
    ambiguous="NaT",
    nonexistent="shift_forward",
)

# Add a new column for the weekday
# Objective analysis: Determine if there is a correlation between the day of the week and the sentiment of the tweets.
# Everyone hates Mondays...
df["weekday"] = df["date"].dt.day_name()

print("Preview:")
print(df.head())
print(df.tail())
print("Shape:")
print(df.shape)
# print(df.info())
# print(df.describe(include="all"))

# Check for missing/duplicate values
print("Missing values:")
print(df.isna().sum())
print("Duplicate values:")
print(df.duplicated().sum())
print("Info:")
print(df.info())

# Sample a subset of the data for analysis
sampled_df = (
    df.groupby("weekday", group_keys=False)
    .sample(n=250, random_state=42)
    .reset_index(drop=True)
)

print("Sampled subset:")
print(sampled_df["weekday"].value_counts())
print(sampled_df.shape)


# Normalize and clean the text data in sampled_df
# Remove the usernames
def clean_text(text):
    text = str(text)
    text = re.sub(r"@\w+", "@user", text)
    text = re.sub(r"https?://\S+|www\.\S+", "[http]", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


sampled_df["text"] = sampled_df["text"].apply(clean_text)
sampled_df.to_csv("cleaned_sampled_tweets.csv", index=False)
