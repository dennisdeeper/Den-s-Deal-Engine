#!/usr/bin/env python3
"""
Hourly Live Market discovery + verification for Media Deal Engine.

Goals:
- discover exact product URLs from approved retailer collection pages
- verify price, stock, RRP and exact artwork from each product page
- re-verify existing feed items
- score and keep the strongest current collector opportunities
- fail closed rather than publish an empty/bad feed

No affiliate URLs are invented here. New items are discovery links only.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36 MediaDealEngine/8.3"
TIMEOUT = 18
MAX_ITEMS_DEFAULT = 20
MIN_SAFE_LIVE = 6


@dataclass(frozen=True)
class Source:
    retailer: str
    url: str
    region: str = "UK"
    label: str = ""
    offer_text: str = ""
    offer_signal: str = ""
    tags: tuple[str, ...] = ()
    max_links: int = 14


SOURCES = (
    Source(
        "Zavvi UK",
        "https://www.zavvi.com/c/offers/sale/4k/",
        tags=("zavvi", "4k", "sale"),
        max_links=16,
    ),
    Source(
        "Zavvi UK",
        "https://www.zavvi.com/c/offers/sale/film/",
        tags=("zavvi", "film", "sale"),
        max_links=14,
    ),
    Source(
        "Zavvi UK",
        "https://www.zavvi.com/c/offers/steelbooks/multi-buy/",
        offer_text="Selected Steelbooks are included in Zavvi's current multibuy offer; exact checkout price depends on the qualifying pair.",
        offer_signal="MULTIBUY",
        tags=("zavvi", "steelbook", "multibuy"),
        max_links=12,
    ),
    Source(
        "Arrow Films UK",
        "https://www.arrowfilms.com/c/offers/multibuy/uhds/",
        region="Region Free",
        label="Arrow Films",
        offer_text="Selected UHDs are currently 2 for £40; offer applies at checkout while stocks last and may be withdrawn.",
        offer_signal="2 FOR £40",
        tags=("arrow", "4k", "boutique", "multibuy"),
        max_links=18,
    ),
    Source(
        "Arrow Films UK",
        "https://www.arrowfilms.com/c/specialist/limited-editions/",
        region="Region Free",
        label="Arrow Films",
        tags=("arrow", "boutique", "limited-edition"),
        max_links=16,
    ),
    Source(
        "Rarewaves UK",
        "https://www.rarewaves.com/collections/4k-ultra-hd-blu-ray-offers",
        region="UK",
        tags=("rarewaves", "4k", "sale"),
        max_links=14,
    ),
    Source(
        "Rarewaves UK",
        "https://www.rarewaves.com/collections/2-for-30-offer",
        region="UK",
        offer_text="Selected 4K UHD titles are currently 2 for £30; offer applies to qualifying products while the retailer promotion remains live.",
        offer_signal="2 FOR £30",
        tags=("rarewaves", "4k", "multibuy"),
        max_links=14,
    ),
    Source(
        "Rarewaves UK",
        "https://www.rarewaves.com/collections/2-for-26-4k-ultra-hd-blu-ray",
        region="UK",
        offer_text="Selected 4K UHD titles are currently 2 for £26; offer applies to qualifying products while the retailer promotion remains live.",
        offer_signal="2 FOR £26",
        tags=("rarewaves", "4k", "multibuy"),
        max_links=14,
    ),
)

ALLOWED_HOSTS = {
    "www.zavvi.com",
    "zavvi.com",
    "www.arrowfilms.com",
    "arrowfilms.com",
    "www.hmv.com",
    "hmv.com",
    "www.rarewaves.com",
    "rarewaves.com",
}

MEDIA_RE = re.compile(
    r"\b(4k|ultra\s*hd|uhd|blu[- ]?ray|steelbook|limited edition|collector(?:'s)? edition|box ?set|ps4|ps5|xbox|switch|vinyl|cd)\b",
    re.I,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_url(url: str):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError(f"unsupported URL host: {url}")
    return parsed


def fetch_text(url: str) -> str:
    _validate_url(url)
    req = Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-GB,en;q=0.9",
        },
    )
    with urlopen(req, timeout=TIMEOUT) as resp:
        ctype = (resp.headers.get("Content-Type") or "").lower()
        if "text/html" not in ctype and "application/xhtml+xml" not in ctype:
            raise RuntimeError(f"unexpected content type: {ctype}")
        raw = resp.read(3_500_000)
    return raw.decode("utf-8", "replace")


def fetch_json_url(url: str) -> Any:
    _validate_url(url)
    req = Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Accept-Language": "en-GB,en;q=0.9",
        },
    )
    with urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read(5_000_000)
    return json.loads(raw.decode("utf-8", "replace"))


def flatten_json(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from flatten_json(child)
    elif isinstance(value, list):
        for child in value:
            yield from flatten_json(child)


def ldjson_objects(page: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for raw in re.findall(
        r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        page,
        flags=re.I | re.S,
    ):
        raw = html.unescape(raw).strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        for obj in flatten_json(data):
            if isinstance(obj, dict):
                out.append(obj)
    return out


def first_meta(page: str, key: str) -> str:
    patterns = (
        rf'<meta[^>]+property=["\']{re.escape(key)}["\'][^>]+content=["\']([^"\']+)["\']',
        rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']{re.escape(key)}["\']',
        rf'<meta[^>]+name=["\']{re.escape(key)}["\'][^>]+content=["\']([^"\']+)["\']',
        rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']{re.escape(key)}["\']',
    )
    for pattern in patterns:
        match = re.search(pattern, page, re.I)
        if match:
            return html.unescape(match.group(1)).strip()
    return ""


def strip_text(page: str) -> str:
    text = re.sub(r"<script\b.*?</script>", " ", page, flags=re.I | re.S)
    text = re.sub(r"<style\b.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def money_from(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).replace(",", "").strip()
    m = re.search(r"(\d+(?:\.\d{1,2})?)", text)
    if not m:
        return None
    try:
        n = float(m.group(1))
    except ValueError:
        return None
    return n if n > 0 else None


def availability_from(value: Any) -> str:
    text = str(value or "").lower()
    if any(x in text for x in ("outofstock", "out of stock", "soldout", "sold out", "unavailable")):
        return "Out of stock"
    if any(x in text for x in ("instock", "in stock", "limitedavailability", "preorder")):
        return "In stock"
    return ""


def discover_links(page: str, collection_url: str, max_links: int) -> list[str]:
    links: list[str] = []
    seen = set()
    for raw in re.findall(r'href\s*=\s*["\']([^"\']+)["\']', page, flags=re.I):
        href = html.unescape(raw)
        full = urljoin(collection_url, href).split("#", 1)[0].split("?", 1)[0]
        p = urlparse(full)
        if p.hostname not in ALLOWED_HOSTS:
            continue

        is_thg_product = bool(re.search(r"/p/(?:[^/?]+/)*[^/?]+/\d+/?$", p.path, re.I))
        is_hmv_product = bool(re.search(
            r"^/store/film-tv/(?:4k-ultra-hd-blu-ray|steelbooks?)/[^/]+/?$",
            p.path,
            re.I,
        ))
        is_rarewaves_product = bool(re.search(r"^/products/[^/]+/?$", p.path, re.I))
        if not (is_thg_product or is_hmv_product or is_rarewaves_product):
            continue

        if full not in seen:
            seen.add(full)
            links.append(full)
            if len(links) >= max_links:
                break
    return links


def find_product_object(page: str) -> dict[str, Any] | None:
    candidates = []
    for obj in ldjson_objects(page):
        typ = obj.get("@type")
        types = typ if isinstance(typ, list) else [typ]
        if any(str(x).lower() == "product" for x in types if x is not None):
            candidates.append(obj)
    if not candidates:
        return None
    candidates.sort(key=lambda x: (bool(x.get("offers")), bool(x.get("image")), bool(x.get("name"))), reverse=True)
    return candidates[0]


def offer_from(product: dict[str, Any] | None) -> dict[str, Any]:
    if not product:
        return {}
    offers = product.get("offers")
    if isinstance(offers, dict):
        return offers
    if isinstance(offers, list):
        choices = [x for x in offers if isinstance(x, dict)]
        for x in choices:
            if money_from(x.get("price")) is not None:
                return x
        return choices[0] if choices else {}
    return {}


def parse_product(url: str, page: str, source: Source | None = None) -> dict[str, Any]:
    product = find_product_object(page)
    offer = offer_from(product)
    text = strip_text(page)

    title = ""
    if product:
        title = str(product.get("name") or "").strip()
    title = title or first_meta(page, "og:title")
    if title:
        title = re.sub(r"\s*\|\s*(Zavvi UK|Arrow Films UK)\s*$", "", title, flags=re.I).strip()

    price = money_from(offer.get("price"))
    if price is None:
        for pat in (
            r"Current price:\s*£\s*([\d,.]+)",
            r"\bNow\s*£\s*([\d,.]+)",
            r"Sale price\s*£\s*([\d,.]+)",
        ):
            m = re.search(pat, text, re.I)
            if m:
                price = money_from(m.group(1))
                if price is not None:
                    break

    rrp = None
    for pat in (
        r"Recommended Retail Price:\s*£\s*([\d,.]+)",
        r"\bRRP:\s*£\s*([\d,.]+)",
        r"\bWas\s*£\s*([\d,.]+)",
        r"Regular price\s*£\s*([\d,.]+)",
    ):
        m = re.search(pat, text, re.I)
        if m:
            rrp = money_from(m.group(1))
            if rrp:
                break

    availability = availability_from(offer.get("availability"))
    if not availability:
        if re.search(r"\b(out of stock|sold out|currently unavailable)\b", text, re.I):
            availability = "Out of stock"
        elif re.search(r"\bin stock\b", text, re.I) or re.search(r"\badd to basket\b", text, re.I):
            availability = "In stock"

    image = ""
    if product:
        images = product.get("image")
        if isinstance(images, str):
            image = images
        elif isinstance(images, list) and images:
            first = images[0]
            image = first if isinstance(first, str) else str(first.get("url") or "") if isinstance(first, dict) else ""
        elif isinstance(images, dict):
            image = str(images.get("url") or "")
    image = image or first_meta(page, "og:image") or first_meta(page, "twitter:image")

    if not title:
        h1 = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.I | re.S)
        if h1:
            title = strip_text(h1.group(1))

    return {
        "title": title[:240],
        "price": price,
        "referencePrice": rrp,
        "availability": availability,
        "image": image.strip(),
        "url": url,
        "text": text[:120_000],
        "source": source,
    }


def product_id(url: str, retailer: str) -> str:
    p = urlparse(url)
    numeric = re.findall(r"(\d+)", p.path)
    suffix = numeric[-1] if numeric else re.sub(r"[^a-z0-9]+", "-", p.path.lower()).strip("-")[-48:]
    prefix = (
        "zavvi" if "zavvi" in retailer.lower()
        else "arrow" if "arrow" in retailer.lower()
        else "hmv" if "hmv" in retailer.lower()
        else "rarewaves" if "rarewaves" in retailer.lower()
        else "media"
    )
    slug = p.path.strip("/").split("/")[-2] if p.path.rstrip("/").split("/")[-1].isdigit() else p.path.strip("/").split("/")[-1]
    slug = re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-")[:54]
    return f"{prefix}-{slug}-{suffix}".strip("-")[:120]


def infer_format(title: str) -> str:
    t = title.lower()
    limited = "limited edition" in t
    steel = "steelbook" in t
    if "4k" in t or "ultra hd" in t or re.search(r"\buhd\b", t):
        if steel:
            return "4K UHD Steelbook"
        return "Limited Edition 4K UHD" if limited else "4K UHD"
    if "blu-ray" in t or "bluray" in t or "blu ray" in t:
        if steel:
            return "Blu-ray Steelbook"
        return "Limited Edition Blu-ray" if limited else "Blu-ray"
    if "ps5" in t:
        return "PS5"
    if "ps4" in t:
        return "PS4"
    if "vinyl" in t:
        return "Vinyl"
    if re.search(r"\bcd\b", t):
        return "CD"
    return "Collectible media"


def infer_tags(title: str, source: Source | None, retailer: str) -> list[str]:
    t = title.lower()
    tags = {"discovery"}
    if source:
        tags.update(source.tags)
    if "zavvi" in retailer.lower():
        tags.add("zavvi")
    if "arrow" in retailer.lower():
        tags.update(("arrow", "boutique"))
    if "hmv" in retailer.lower():
        tags.add("hmv")
    if "rarewaves" in retailer.lower():
        tags.add("rarewaves")
    for needle, tag in (
        ("4k", "4k"),
        ("ultra hd", "4k"),
        ("steelbook", "steelbook"),
        ("limited edition", "limited-edition"),
        ("collector", "collector-edition"),
        ("box set", "box-set"),
        ("boxset", "box-set"),
        ("blu-ray", "blu-ray"),
        ("ps5", "ps5"),
        ("ps4", "ps4"),
        ("vinyl", "vinyl"),
    ):
        if needle in t:
            tags.add(tag)
    if "exclusive" in t:
        tags.add("exclusive")
    return sorted(tags)


def score_item(item: dict[str, Any]) -> float:
    price = money_from(item.get("price"))
    rrp = money_from(item.get("referencePrice"))
    saving_pct = ((rrp - price) / rrp * 100.0) if price and rrp and rrp > price else 0.0
    absolute = (rrp - price) if price and rrp and rrp > price else 0.0
    title = str(item.get("title") or "").lower()
    tags = set(item.get("tags") or [])
    score = saving_pct * 1.7 + min(absolute, 40)
    if "steelbook" in tags or "steelbook" in title:
        score += 15
    if "limited-edition" in tags or "limited edition" in title:
        score += 13
    if "exclusive" in tags or "exclusive" in title:
        score += 9
    if "box-set" in tags or "box set" in title or "boxset" in title:
        score += 8
    if "boutique" in tags:
        score += 5
    if "multibuy" in tags:
        score += 7
    if price is not None and price <= 10:
        score += 9
    elif price is not None and price <= 20:
        score += 5
    return round(score, 3)


def public_item(parsed: dict[str, Any], source: Source | None, existing: dict[str, Any] | None = None) -> dict[str, Any] | None:
    title = str(parsed.get("title") or (existing or {}).get("title") or "").strip()
    price = money_from(parsed.get("price"))
    if not title or price is None or not MEDIA_RE.search(title):
        return None
    if parsed.get("availability") != "In stock":
        return None

    retailer = (source.retailer if source else str((existing or {}).get("retailer") or "")).strip()
    if not retailer:
        host = urlparse(parsed["url"]).hostname or ""
        retailer = "Zavvi UK" if "zavvi" in host else "Arrow Films UK" if "arrowfilms" in host else host

    rrp = money_from(parsed.get("referencePrice"))
    tags = infer_tags(title, source, retailer)
    fmt = infer_format(title)
    saving_pct = ((rrp - price) / rrp * 100.0) if rrp and rrp > price else 0.0

    signal = ""
    offer_text = ""
    if source and source.offer_signal:
        signal = source.offer_signal
        offer_text = source.offer_text
    elif saving_pct >= 20:
        signal = f"{round(saving_pct)}% OFF"
    elif rrp and rrp > price:
        signal = f"£{rrp-price:.2f} OFF"

    # Require either a meaningful discount or a collector-specific reason.
    collector = any(tag in tags for tag in ("steelbook", "limited-edition", "exclusive", "box-set", "boutique", "multibuy"))
    if saving_pct < 10 and not collector:
        return None

    reason_bits = [f"Exact {fmt} verified in stock at £{price:.2f}"]
    if rrp and rrp > price:
        reason_bits.append(f"versus £{rrp:.2f} RRP")
    if offer_text:
        reason_bits.append("with a current retailer multibuy")
    reason = ", ".join(reason_bits) + "."

    item = {
        "id": product_id(parsed["url"], retailer),
        "title": title,
        "price": round(price, 2),
        "referencePrice": round(rrp, 2) if rrp else None,
        "format": fmt,
        "label": source.label if source and source.label else str((existing or {}).get("label") or ""),
        "region": source.region if source else str((existing or {}).get("region") or "UK"),
        "image": str(parsed.get("image") or ""),
        "channel": "discovery",
        "retailer": retailer,
        "publicSeller": retailer,
        "publicUrl": parsed["url"],
        "status": "live",
        "availability": "In stock",
        "dealType": "flash" if saving_pct >= 30 else "hold",
        "tags": tags,
        "signal": signal or "VERIFIED",
        "reason": reason,
        "sourceVerified": True,
        "verifiedAt": now_iso(),
        "maxVerificationAgeHours": 3,
        "expiryVerified": False,
    }
    if offer_text:
        item["offerText"] = offer_text
    item["_score"] = score_item(item)
    return item


def source_for_existing(url: str) -> Source | None:
    host = urlparse(url).hostname or ""
    if "arrowfilms.com" in host:
        return Source("Arrow Films UK", "https://www.arrowfilms.com/", region="Region Free", label="Arrow Films", tags=("arrow", "boutique"))
    if "zavvi.com" in host:
        return Source("Zavvi UK", "https://www.zavvi.com/", tags=("zavvi",))
    if "hmv.com" in host:
        return Source("HMV UK", "https://hmv.com/", region="UK", tags=("hmv",))
    if "rarewaves.com" in host:
        return Source("Rarewaves UK", "https://www.rarewaves.com/", region="UK", tags=("rarewaves",))
    return None


def select_balanced(items: list[dict[str, Any]], max_items: int) -> list[dict[str, Any]]:
    # Deduplicate exact URLs, keeping the strongest source context.
    by_url: dict[str, dict[str, Any]] = {}
    for item in items:
        key = item["publicUrl"].rstrip("/")
        prior = by_url.get(key)
        if prior is None or item.get("_score", 0) > prior.get("_score", 0):
            by_url[key] = item

    ranked = sorted(by_url.values(), key=lambda x: (-float(x.get("_score", 0)), x.get("price") or 999999, x["title"]))

    # Avoid one retailer overwhelming the storefront if multiple sources are healthy.
    per_retailer_cap = max(8, int(max_items * 0.65))
    counts: dict[str, int] = {}
    selected: list[dict[str, Any]] = []
    overflow: list[dict[str, Any]] = []
    for item in ranked:
        retailer = item["retailer"]
        if counts.get(retailer, 0) >= per_retailer_cap:
            overflow.append(item)
            continue
        selected.append(item)
        counts[retailer] = counts.get(retailer, 0) + 1
        if len(selected) >= max_items:
            break

    if len(selected) < max_items:
        for item in overflow:
            selected.append(item)
            if len(selected) >= max_items:
                break

    for item in selected:
        item.pop("_score", None)
    return selected


def annotate_history(
    selected: list[dict[str, Any]],
    existing_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    previous_rank: dict[str, int] = {}
    previous_by_url: dict[str, dict[str, Any]] = {}
    for idx, item in enumerate(existing_items, 1):
        url = str(item.get("publicUrl") or item.get("url") or "").rstrip("/")
        if not url:
            continue
        previous_by_url[url] = item
        rank = item.get("rank")
        try:
            previous_rank[url] = int(rank) if rank is not None else idx
        except Exception:
            previous_rank[url] = idx

    stamp = now_iso()
    for idx, item in enumerate(selected, 1):
        key = str(item.get("publicUrl") or "").rstrip("/")
        prior = previous_by_url.get(key)
        old_rank = previous_rank.get(key)

        item["rank"] = idx
        item["rankChange"] = (old_rank - idx) if old_rank is not None else None
        item["isNew"] = old_rank is None
        item["firstSeenAt"] = (
            str((prior or {}).get("firstSeenAt") or (prior or {}).get("verifiedAt") or stamp)
        )

        old_price = money_from((prior or {}).get("price"))
        new_price = money_from(item.get("price"))
        if old_price is not None and new_price is not None and new_price < old_price - 0.005:
            item["priceDrop"] = round(old_price - new_price, 2)
        else:
            item["priceDrop"] = 0

    return selected


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="data/live-market.json")
    ap.add_argument("--output", default="data/live-market.json")
    ap.add_argument("--max-items", type=int, default=MAX_ITEMS_DEFAULT)
    ap.add_argument("--summary", default="")
    args = ap.parse_args()

    input_path = Path(args.input)
    existing_data: dict[str, Any] = {}
    if input_path.exists():
        existing_data = json.loads(input_path.read_text(encoding="utf-8"))
    existing_items = existing_data.get("items", []) if isinstance(existing_data, dict) else []

    candidates: dict[str, Source] = {}
    source_stats = []
    errors = []

    for source in SOURCES:
        try:
            host = urlparse(source.url).hostname or ""
            if "rarewaves.com" in host:
                endpoint = source.url.rstrip("/") + "/products.json?limit=50"
                data = fetch_json_url(endpoint)
                products = data.get("products", []) if isinstance(data, dict) else []
                links = []
                for product in products:
                    handle = str(product.get("handle") or "").strip()
                    if not handle:
                        continue
                    links.append("https://www.rarewaves.com/products/" + handle)
                    if len(links) >= source.max_links:
                        break
            else:
                page = fetch_text(source.url)
                links = discover_links(page, source.url, source.max_links)

            for link in links:
                candidates.setdefault(link.rstrip("/") + "/", source)
            source_stats.append({"source": source.url, "links": len(links), "ok": len(links) > 0})
            if not links:
                errors.append(f"collection {source.url}: no product links discovered")
        except Exception as exc:
            errors.append(f"collection {source.url}: {exc}")
            source_stats.append({"source": source.url, "links": 0, "ok": False})

    # Always reverify existing links too, so known good items can survive a temporary collection-page failure.
    existing_by_url = {}
    for item in existing_items:
        url = str(item.get("publicUrl") or item.get("url") or "").strip()
        if not url:
            continue
        url = url.rstrip("/") + "/"
        existing_by_url[url] = item
        if urlparse(url).hostname in ALLOWED_HOSTS:
            candidates.setdefault(url, source_for_existing(url))

    verified: list[dict[str, Any]] = []
    for idx, (url, source) in enumerate(list(candidates.items())):
        try:
            page = fetch_text(url)
            parsed = parse_product(url, page, source)
            item = public_item(parsed, source, existing_by_url.get(url))
            if item:
                verified.append(item)
        except Exception as exc:
            errors.append(f"product {url}: {exc}")
        if idx and idx % 10 == 0:
            time.sleep(0.25)

    selected = select_balanced(verified, max(1, min(args.max_items, 40)))
    selected = annotate_history(selected, existing_items)
    if len(selected) < MIN_SAFE_LIVE:
        print(json.dumps({"ok": False, "verified": len(selected), "errors": errors[-12:]}, indent=2))
        raise SystemExit(f"Fail-closed: only {len(selected)} verified live deals; refusing to replace feed")

    payload = {
        "generatedAt": now_iso(),
        "automation": {
            "mode": "hourly-retailer-scan",
            "verifiedCount": len(selected),
            "candidateCount": len(candidates),
            "sources": source_stats,
        },
        "items": selected,
    }

    Path(args.output).write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    summary = {
        "ok": True,
        "generatedAt": payload["generatedAt"],
        "verifiedCount": len(selected),
        "candidateCount": len(candidates),
        "retailers": sorted({x["retailer"] for x in selected}),
        "topDeals": [
            {"title": x["title"], "price": x["price"], "signal": x["signal"], "retailer": x["retailer"]}
            for x in selected[:8]
        ],
        "sourceHealth": source_stats,
        "errors": errors[-12:],
    }
    if args.summary:
        Path(args.summary).write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
