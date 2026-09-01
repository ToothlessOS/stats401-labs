import requests
import pandas as pd

url = "https://api.vatsim.net/v2/members/1658712/history"

payload = {}
headers = {"Accept": "application/json"}

response = requests.request("GET", url, headers=headers, data=payload)

records = []
for item in response.json()["items"]:
    record = {
        "callsign": item["callsign"],
        "cid": item["id"],
        "server": item["server"],
        "logon_time": item["start"],
        "logoff_time": item["end"],
    }
    records.append(record)

df = pd.DataFrame(records)
df["duration"] = pd.to_datetime(df["logoff_time"]) - pd.to_datetime(df["logon_time"])
print(df)
df.to_csv("../data/vatsim_history.csv", index=False)
