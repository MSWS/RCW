#!/usr/bin/env python3
"""
RCW Scraper (parallel)
Output: ./rcw/<title>/<chapter>/<section>.txt
"""

import requests
from bs4 import BeautifulSoup
import time
import re
import json
import logging
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests.adapters import HTTPAdapter

WORKERS = 16
SESSION_POOL_SIZE = WORKERS + 2

BASE_URL = "https://app.leg.wa.gov/RCW/default.aspx"
OUTPUT_DIR = Path("rcw")
STATE_FILE = Path("rcw_scrape_state.json")
DELAY = 0.01

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

state_lock = threading.Lock()

session = requests.Session()
session.headers.update({"User-Agent": "RCW-archiver/1.0 (personal research)"})
adapter = HTTPAdapter(pool_connections=1, pool_maxsize=SESSION_POOL_SIZE)
session.mount("https://", adapter)
session.mount("http://", adapter)
session.headers.update({"User-Agent": "RCW-archiver/1.0 (personal research)"})


def get(cite=None):
    params = {"Cite": cite} if cite else {}
    for attempt in range(3):
        try:
            r = session.get(BASE_URL, params=params, timeout=15)
            r.raise_for_status()
            return BeautifulSoup(r.text, "html.parser")
        except Exception as e:
            log.warning(f"Attempt {attempt+1} failed for Cite={cite}: {e}")
            time.sleep(2 ** attempt)
    log.error(f"Failed to fetch Cite={cite} after 3 attempts")
    return None


def extract_links(soup, pattern):
    results = []
    for a in soup.find_all("a", href=True):
        m = re.search(r"[Cc]ite=([^&\"]+)", a["href"])
        if m and re.match(pattern, m.group(1)):
            results.append(m.group(1))
    return results


def get_titles(soup):
    return extract_links(soup, r"^\d+[A-Z]?$")

def get_chapters(soup, title):
    return extract_links(soup, rf"^{re.escape(title)}\.\w+$")

def get_sections(soup, chapter):
    return extract_links(soup, rf"^{re.escape(chapter)}\.\d+$")


def extract_section_text(soup):
    content_div = (
        soup.find("div", {"id": "contentWrapper"})
        or soup.find("div", class_=re.compile(r"content", re.I))
        or soup.body
    )
    if not content_div:
        return ""
    for tag in content_div(["script", "style", "nav", "header", "footer"]):
        tag.decompose()
    return content_div.get_text(separator="\n", strip=True)


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"done_sections": []}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def fetch_section(section, done, state):
    out_path = OUTPUT_DIR / section.split(".")[0] / ".".join(section.split(".")[:2]) / f"{section}.txt"

    with state_lock:
        if section in done:
            return

    out_path.parent.mkdir(parents=True, exist_ok=True)
    soup = get(section)
    if not soup:
        return

    text = extract_section_text(soup)
    out_path.write_text(text, encoding="utf-8")
    log.info(f"  {section}")

    with state_lock:
        done.add(section)
        state["done_sections"] = list(done)
        save_state(state)

    time.sleep(DELAY)


def main():
    state = load_state()
    done = set(state["done_sections"])

    log.info("Fetching title list...")
    root_soup = get()
    if not root_soup:
        log.error("Can't reach RCW root, aborting.")
        return

    titles = get_titles(root_soup)
    log.info(f"Found {len(titles)} titles")

    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        for title in titles:
            log.info(f"Title {title}")
            title_soup = get(title)
            if not title_soup:
                continue

            chapters = get_chapters(title_soup, title)
            log.info(f"  {len(chapters)} chapters")

            for chapter in chapters:
                chapter_soup = get(chapter)
                if not chapter_soup:
                    continue

                sections = get_sections(chapter_soup, chapter)
                futures = {
                    executor.submit(fetch_section, s, done, state): s
                    for s in sections
                    if s not in done
                }
                for future in as_completed(futures):
                    exc = future.exception()
                    if exc:
                        log.error(f"Error on {futures[future]}: {exc}")

    log.info("Done.")


if __name__ == "__main__":
    main()
