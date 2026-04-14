"""
Final GMGN scraper test - extract structured security data from token page.
"""
import json
import os
import re

os.environ["PYTHONIOENCODING"] = "utf-8"

mint = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'  # WIF
url = f"https://gmgn.ai/sol/token/{mint}"

print(f"Scraping {url}")

from scrapling.fetchers import StealthyFetcher

page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
text = page.get_all_text() if hasattr(page, 'get_all_text') else ''

# Print ALL text so we can see the full content
print("\n=== FULL PAGE TEXT ===")
for i, line in enumerate(text.split('\n')):
    line = line.strip()
    if line:
        print(f"{i:3}: {line[:200]}")
