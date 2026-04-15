"""
GMGN Token Safety Checker — scrapes GMGN token page via Scrapling.

Scoring system (max 120 pts):
  +20  Mint renounced (NoMint)
  +20  No Blacklist
  +20  LP Burned 100%
  +20  Top10 <= 15%   (+15 if 15-20%)
  +10  Insiders <= 5%  (+5 if 5-10%)
  +10  Dev = 0%
  +10  Phishing <= 5%  (+5 if 5-10%)
  +10  Bundler < 5%    (+5 if 5-10%)

Hard gates (reject regardless of score):
  - Holders > 1000

Usage:
    python scripts/gmgn-token-safety.py <mint1> [mint2] ...
    echo '["mint1","mint2"]' | python scripts/gmgn-token-safety.py --stdin

Output: JSON array to stdout.
"""

import json
import sys
import os
import re
import time

os.environ["PYTHONIOENCODING"] = "utf-8"

GMGN_BASE = "https://gmgn.ai/sol/token"
REQUEST_DELAY = 4.0  # Safe 4 seconds delay between requests (240s for 50 tokens = 4 min)


def _pct_after(lines: list[str], idx: int) -> float:
    """Return the percentage value from the line after index, or -1."""
    if idx + 1 >= len(lines):
        return -1.0
    m = re.match(r'([\d.]+)\s*%', lines[idx + 1])
    return float(m.group(1)) if m else -1.0


def _pct_near(lines: list[str], idx: int, window: int = 3) -> float:
    """Search nearby lines for the first percentage value."""
    start = max(0, idx + 1)
    end = min(len(lines), idx + 1 + window)
    for i in range(start, end):
        m = re.search(r'([\d.]+)\s*%', lines[i])
        if m:
            return float(m.group(1))
    return -1.0


def _parse_count(text: str) -> int:
    """Parse '490.2K', '14,483', '1.2M' etc."""
    m = re.match(r'([\d,.]+)\s*([KkMm])?', text)
    if not m:
        return 0
    num = float(m.group(1).replace(',', ''))
    suffix = (m.group(2) or '').upper()
    if suffix == 'K':
        num *= 1_000
    elif suffix == 'M':
        num *= 1_000_000
    return int(num)


def _parse_money(text: str) -> float:
    """Parse '$235.87', '$1.2M', '$42.5K' etc."""
    m = re.search(r'\$\s*([\d,.]+)\s*([KkMmBb])?', text)
    if not m:
        return -1.0
    num = float(m.group(1).replace(',', ''))
    suffix = (m.group(2) or '').upper()
    if suffix == 'K':
        num *= 1_000
    elif suffix == 'M':
        num *= 1_000_000
    elif suffix == 'B':
        num *= 1_000_000_000
    return num


def parse_page_text(mint: str, text: str) -> dict:
    """Parse GMGN token page text into structured safety result with scoring."""
    lines = [l.strip() for l in text.split('\n') if l.strip()]

    # --- Raw metrics ---
    metrics = {
        "isMintRenounced": False,
        "noBlacklist": False,
        "isLpBurned": False,
        "top10Pct": -1.0,      # %
        "insidersPct": -1.0,   # % (老鼠仓)
        "devPct": -1.0,        # %
        "phishingPct": -1.0,   # % (钓鱼钱包)
        "bundlerPct": -1.0,    # % (捆绑交易)
        "holders": 0,
        "bluechipPct": -1.0,   # %
        "bluechipHolders": 0,
        "snipersPct": -1.0,    # %
        "rugPct": -1.0,        # %
        "volume24hUsd": -1.0,  # whole-token 24h volume in USD
    }

    for i, line in enumerate(lines):
        low = line.lower()

        # Audit booleans (appear as standalone words)
        if low == 'nomint':
            metrics["isMintRenounced"] = True
        elif low == 'no blacklist':
            metrics["noBlacklist"] = True
        elif low in ('burnt', 'burned'):
            metrics["isLpBurned"] = True

        # Key-value pairs: label on line i, value on line i+1
        if i + 1 >= len(lines):
            continue
        next_line = lines[i + 1]

        if low == 'top 10':
            p = _pct_after(lines, i)
            if p < 0:
                p = _pct_near(lines, i)
            if p >= 0:
                metrics["top10Pct"] = p

        elif low == 'insiders' or low == '老鼠仓':
            p = _pct_after(lines, i)
            if p < 0:
                p = _pct_near(lines, i)
            if p >= 0:
                metrics["insidersPct"] = p

        elif low == 'dev':
            p = _pct_after(lines, i)
            if p < 0:
                p = _pct_near(lines, i)
            if p >= 0:
                metrics["devPct"] = p

        elif low == 'phishing' or low == '钓鱼钱包':
            p = _pct_after(lines, i)
            if p < 0:
                p = _pct_near(lines, i)
            if p >= 0:
                metrics["phishingPct"] = p

        elif low == 'bundler' or low == '捆绑交易':
            p = _pct_after(lines, i)
            if p < 0:
                p = _pct_near(lines, i)
            if p >= 0:
                metrics["bundlerPct"] = p

        elif low == 'holders' or low == '持有者':
            cnt = _parse_count(next_line)
            if cnt <= 0 and i + 3 < len(lines):
                for candidate in lines[i + 1:i + 4]:
                    cnt = _parse_count(candidate)
                    if cnt > 0:
                        break
            if cnt > 0:
                metrics["holders"] = cnt

        elif low == 'snipers' or low == '狙击者':
            if next_line == '--':
                metrics["snipersPct"] = 0.0
            else:
                p = _pct_after(lines, i)
                if p < 0:
                    p = _pct_near(lines, i)
                if p >= 0:
                    metrics["snipersPct"] = p

        elif low == 'rug %':
            p = _pct_after(lines, i)
            if p < 0:
                p = _pct_near(lines, i)
            if p >= 0:
                metrics["rugPct"] = p
            elif next_line in ('0', '0%'):
                metrics["rugPct"] = 0.0

        elif low in ('24h vol', '24h volume', '24h成交额', '24h 交易量', '24h交易量'):
            amount = _parse_money(next_line)
            if amount < 0 and i + 2 < len(lines):
                amount = _parse_money(lines[i + 2])
            if amount >= 0:
                metrics["volume24hUsd"] = amount

        # Bluechip: may appear as English label or Chinese "蓝筹持有者" block.
        elif ('blue' in low and ('chip' in low or 'holder' in low)) or ('蓝筹' in line):
            p = _pct_after(lines, i)
            if p < 0:
                p = _pct_near(lines, i, window=6)
            if p >= 0:
                metrics["bluechipPct"] = p

            # also try to capture bluechip holder count from nearby lines
            for candidate in lines[i:i + 6]:
                cnt = _parse_count(candidate)
                if cnt > 0:
                    metrics["bluechipHolders"] = cnt
                    break

        # Also search for "Red." label which appears near the bluechip area
        # In the GMGN page, the holder analysis section has Top10/DEV/.../Red.
        # "Red." line might precede numeric info we want
        elif low == 'red.':
            # Check if this is part of the holder section
            pass

    # ==================================================================
    # Scoring (max 120)
    # ==================================================================
    score = 0
    score_breakdown: dict[str, int] = {}

    # 1. Mint renounced: +20
    if metrics["isMintRenounced"]:
        score += 20
        score_breakdown["mint_renounced"] = 20

    # 2. No Blacklist: +20
    if metrics["noBlacklist"]:
        score += 20
        score_breakdown["no_blacklist"] = 20

    # 3. LP Burned 100%: +20
    if metrics["isLpBurned"]:
        score += 20
        score_breakdown["lp_burned"] = 20

    # 4. Top 10 holders
    t10 = metrics["top10Pct"]
    if t10 >= 0:
        if t10 <= 15:
            score += 20
            score_breakdown["top10"] = 20
        elif t10 < 20:
            score += 15
            score_breakdown["top10"] = 15
        else:
            score_breakdown["top10"] = 0

    # 5. Insiders (老鼠仓)
    ins = metrics["insidersPct"]
    if ins >= 0:
        if ins <= 5:
            score += 10
            score_breakdown["insiders"] = 10
        elif ins < 10:
            score += 5
            score_breakdown["insiders"] = 5
        else:
            score_breakdown["insiders"] = 0

    # 6. Dev = 0%
    dev = metrics["devPct"]
    if dev >= 0:
        if dev == 0:
            score += 10
            score_breakdown["dev"] = 10
        else:
            score_breakdown["dev"] = 0

    # 7. Phishing (钓鱼钱包)
    phi = metrics["phishingPct"]
    if phi >= 0:
        if phi <= 5:
            score += 10
            score_breakdown["phishing"] = 10
        elif phi < 10:
            score += 5
            score_breakdown["phishing"] = 5
        else:
            score_breakdown["phishing"] = 0

    # 8. Bundler (捆绑交易)
    bun = metrics["bundlerPct"]
    if bun >= 0:
        if bun < 5:
            score += 10
            score_breakdown["bundler"] = 10
        elif bun < 10:
            score += 5
            score_breakdown["bundler"] = 5
        else:
            score_breakdown["bundler"] = 0

    # 9. Bluechip bonus (no longer a hard gate)
    bc = metrics["bluechipPct"]
    if bc >= 1.5:
        score += 30
        score_breakdown["bluechip"] = 30
    elif bc >= 0.8:
        score += 20
        score_breakdown["bluechip"] = 20
    elif bc >= 0.3:
        score += 15
        score_breakdown["bluechip"] = 15
    elif bc >= 0.1:
        score += 10
        score_breakdown["bluechip"] = 10
    elif bc >= 0:
        score_breakdown["bluechip"] = 0

    # ==================================================================
    # Hard gates
    # ==================================================================
    hard_gate_pass = True
    reject_reasons: list[str] = []

    # Holders > 1000
    if metrics["holders"] <= 1000:
        hard_gate_pass = False
        reject_reasons.append(f"holders={metrics['holders']}<=1000")

    # Whole-token GMGN 24h volume >= 500000 USD
    if metrics["volume24hUsd"] < 500000:
        hard_gate_pass = False
        reject_reasons.append(f"volume24hUsd={metrics['volume24hUsd']:.2f}<500000")

    return {
        "mint": mint,
        "safe": hard_gate_pass,
        "safetyScore": score,
        "maxScore": 120,
        "scoreBreakdown": score_breakdown,
        "rejectReasons": reject_reasons,
        # raw metrics for downstream use
        "holders": metrics["holders"],
        "top10Pct": metrics["top10Pct"],
        "insidersPct": metrics["insidersPct"],
        "devPct": metrics["devPct"],
        "phishingPct": metrics["phishingPct"],
        "bundlerPct": metrics["bundlerPct"],
        "bluechipPct": metrics["bluechipPct"],
        "bluechipHolders": metrics["bluechipHolders"],
        "snipersPct": metrics["snipersPct"],
        "rugPct": metrics["rugPct"],
        "volume24hUsd": metrics["volume24hUsd"],
        "isMintRenounced": metrics["isMintRenounced"],
        "noBlacklist": metrics["noBlacklist"],
        "isLpBurned": metrics["isLpBurned"],
    }


def fetch_token_safety_batch(mints: list[str]) -> list[dict]:
    """Fetch GMGN token safety data for a batch of mints."""
    from scrapling.fetchers import StealthyFetcher

    results = []

    for i, mint in enumerate(mints):
        if not mint or len(mint) < 32:
            results.append({"mint": mint, "error": "invalid_mint", "safe": False, "safetyScore": 0})
            continue

        url = f"{GMGN_BASE}/{mint}"

        try:
            page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
            text = page.get_all_text() if hasattr(page, 'get_all_text') else ''

            if not text or len(text) < 100:
                results.append({
                    "mint": mint,
                    "error": "empty_page",
                    "safe": False,
                    "safetyScore": 0,
                })
                continue

            result = parse_page_text(mint, text)
            results.append(result)

        except Exception as e:
            results.append({
                "mint": mint,
                "error": str(e),
                "safe": False,
                "safetyScore": 0,
            })

        # Rate limiting between requests
        if i < len(mints) - 1:
            time.sleep(REQUEST_DELAY)

    return results


def main():
    mints: list[str] = []

    if "--stdin" in sys.argv:
        raw = sys.stdin.read().strip()
        mints = json.loads(raw) if raw else []
    else:
        mints = [a for a in sys.argv[1:] if not a.startswith("-")]

    if not mints:
        json.dump([], sys.stdout)
        sys.stdout.write("\n")
        return

    results = fetch_token_safety_batch(mints)
    json.dump(results, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
