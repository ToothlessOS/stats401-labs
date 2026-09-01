import requests
from bs4 import BeautifulSoup
import pandas as pd
import time

rating_map = {"One": 1, "Two": 2, "Three": 3, "Four": 4, "Five": 5}

results = []

base_url = "https://books.toscrape.com/"

for page in range(1, 6):  # Scrape the first 5 pages

    url = f"{base_url}catalogue/page-{page}.html"
    headers = {"User-Agent": "STATS401-Class-Exercise/1.0"}

    try:
        response = requests.get(url, headers=headers, timeout=10)
        soup = BeautifulSoup(response.text, "html.parser")

    except requests.RequestException as e:
        print(f"Error fetching {url}: {e}")
        continue

    print(response.status_code)
    books = soup.select("article.product_pod")

    for book in books:
        title = book.select_one("h3 a")["title"]
        link = f"{base_url}{book.select_one('h3 a')['href']}"
        print(link)
        price = book.select_one("p.price_color").get_text(strip=True).replace("Â£", "")
        rating = rating_map.get(book.select_one("p.star-rating")["class"][1])

        results.append({"title": title, "link": link, "price": price, "rating": rating})

    # Rate limiting
    time.sleep(1)

df = pd.DataFrame(results)
print(df)

df.to_csv("../data/books.csv", index=False)

df.to_json("../data/books.json", orient="records", indent=2)
