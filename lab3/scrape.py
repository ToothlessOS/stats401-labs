import requests
from bs4 import BeautifulSoup
import pandas as pd
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

rating_map = {"One": 1, "Two": 2, "Three": 3, "Four": 4, "Five": 5}

base_url = "https://books.toscrape.com/"
HEADERS = {"User-Agent": "STATS401-Class-Exercise/1.0"}


def fetch_book_details(book):
    title = book.select_one("h3 a")["title"]
    link = f"{base_url}catalogue/{book.select_one('h3 a')['href']}"

    try:
        product_response = requests.get(link, headers=HEADERS, timeout=10)
        details = BeautifulSoup(product_response.text, "html.parser")
        genre = details.select_one("ul.breadcrumb li:nth-child(3) a").get_text(
            strip=True
        )
        availability = details.select_one(
            "table.table-striped tr:nth-child(6) td"
        ).get_text(strip=True)
    except requests.RequestException as e:
        print(f"Error fetching product page for {title}: {e}")
        return None

    price = book.select_one("p.price_color").get_text(strip=True).replace("Â£", "")
    rating = rating_map.get(book.select_one("p.star-rating")["class"][1])

    return {
        "title": title,
        "genre": genre,
        "price": price,
        "rating": rating,
        "availability": availability,
        "link": link,
    }


def scrape_books(page_start, page_end, max_workers=10):
    results = []

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        for page in range(page_start, page_end + 1):
            url = f"{base_url}catalogue/page-{page}.html"
            try:
                response = requests.get(url, headers=HEADERS, timeout=10)
                soup = BeautifulSoup(response.text, "html.parser")
            except requests.RequestException as e:
                print(f"Error fetching {url}: {e}")
                continue

            print(response.status_code)
            books = soup.select("article.product_pod")

            futures = [executor.submit(fetch_book_details, book) for book in books]
            for future in as_completed(futures):
                result = future.result()
                if result is not None:
                    results.append(result)

            time.sleep(1)

    return results


if __name__ == "__main__":
    start = time.time()
    results = scrape_books(1, 50)
    elapsed = time.time() - start

    df = pd.DataFrame(results)
    print(df)
    print(f"\nScraped {len(results)} books in {elapsed:.1f}s")

    df.to_csv("../data/books.csv", index=False)
    df.to_json("../data/books.json", orient="records", indent=2)
