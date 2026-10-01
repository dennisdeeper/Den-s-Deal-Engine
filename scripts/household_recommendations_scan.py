#!/usr/bin/env python3
"""
Persistent household recommendations scanner.

Daily:
- re-check every known product for exact page, image, price and availability
- keep unavailable products in history instead of deleting them
- preserve curated primary recommendations while they remain available

Discovery:
- periodically discovers relevant alternatives from approved retailer category pages
- new discoveries are clearly labelled alternatives, not silently promoted over curated primaries
- older alternatives remain in the archive when replaced or unavailable
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36 GapSolver/1.0"
TIMEOUT = 20
MAX_DISCOVERIES_PER_PROBLEM = 2
MAX_ACTIVE_ALTERNATIVES = 4

ALLOWED_HOSTS = {
    "www.meaco.com","meaco.com",
    "www.lakeland.co.uk","lakeland.co.uk",
    "www.zooplus.co.uk","zooplus.co.uk",
    "www.litter-robot.com","litter-robot.com",
    "www.mykitsch.co.uk","mykitsch.co.uk",
}

DISCOVERY_SOURCES = (
    {
        "problem":"condensation-damp",
        "problemTitle":"Condensation & damp",
        "retailer":"Meaco",
        "url":"https://www.meaco.com/collections/compressor-dehumidifiers",
        "include":re.compile(r"\b(dehumidifier|air purifier)\b",re.I),
        "exclude":re.compile(r"\b(filter|hose|bracket|accessor|replacement)\b",re.I),
    },
    {
        "problem":"indoor-laundry",
        "problemTitle":"Indoor laundry drying",
        "retailer":"Lakeland",
        "url":"https://www.lakeland.co.uk/collections/drysoon",
        "include":re.compile(r"\b(heated airer|drying pod|heated hub)\b",re.I),
        "exclude":re.compile(r"\b(cover|hanger|mesh|castor|peg|accessor|shelf)\b",re.I),
    },
    {
        "problem":"cat-litter-tracking",
        "problemTitle":"Cat litter tracking",
        "retailer":"Zooplus",
        "url":"https://www.zooplus.co.uk/shop/cats/cat_litter_litter_boxes/deo_accessoires",
        "include":re.compile(r"\b(mat|rug)\b",re.I),
        "exclude":re.compile(r"\b(scoop|bag|filter|deodor)\b",re.I),
    },
)

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00","Z")

def validate_url(url: str):
    p = urlparse(url)
    if p.scheme != "https" or p.hostname not in ALLOWED_HOSTS:
        raise ValueError(f"unsupported URL: {url}")
    return p

def fetch_text(url: str) -> str:
    validate_url(url)
    req = Request(url, headers={
        "User-Agent":UA,
        "Accept":"text/html,application/xhtml+xml",
        "Accept-Language":"en-GB,en;q=0.9",
    })
    with urlopen(req,timeout=TIMEOUT) as resp:
        raw = resp.read(4_000_000)
    return raw.decode("utf-8","replace")

def flatten_json(v: Any):
    if isinstance(v,dict):
        yield v
        for x in v.values():
            yield from flatten_json(x)
    elif isinstance(v,list):
        for x in v:
            yield from flatten_json(x)

def ldjson(page: str) -> list[dict[str,Any]]:
    out=[]
    for raw in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',page,re.I|re.S):
        try:
            data=json.loads(html.unescape(raw).strip())
        except Exception:
            continue
        out.extend(x for x in flatten_json(data) if isinstance(x,dict))
    return out

def product_obj(page: str) -> dict[str,Any] | None:
    candidates=[]
    for obj in ldjson(page):
        typ=obj.get("@type")
        types=typ if isinstance(typ,list) else [typ]
        if any(str(x).lower()=="product" for x in types if x is not None):
            candidates.append(obj)
    if not candidates:
        return None
    candidates.sort(key=lambda x:(bool(x.get("offers")),bool(x.get("image")),bool(x.get("name"))),reverse=True)
    return candidates[0]

def meta(page: str,key: str) -> str:
    pats=(
        rf'<meta[^>]+property=["\']{re.escape(key)}["\'][^>]+content=["\']([^"\']+)["\']',
        rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']{re.escape(key)}["\']',
        rf'<meta[^>]+name=["\']{re.escape(key)}["\'][^>]+content=["\']([^"\']+)["\']',
        rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']{re.escape(key)}["\']',
    )
    for p in pats:
        m=re.search(p,page,re.I)
        if m:
            return html.unescape(m.group(1)).strip()
    return ""

def strip_text(page: str) -> str:
    x=re.sub(r"<script\b.*?</script>"," ",page,flags=re.I|re.S)
    x=re.sub(r"<style\b.*?</style>"," ",x,flags=re.I|re.S)
    x=re.sub(r"<[^>]+>"," ",x)
    return re.sub(r"\s+"," ",html.unescape(x)).strip()

def num(v: Any) -> float | None:
    if v is None: return None
    m=re.search(r"(\d+(?:[.,]\d{1,2})?)",str(v).replace(",",""))
    if not m: return None
    try: n=float(m.group(1))
    except: return None
    return n if n>0 else None

def offer_obj(product: dict[str,Any] | None) -> dict[str,Any]:
    if not product: return {}
    offers=product.get("offers")
    if isinstance(offers,dict): return offers
    if isinstance(offers,list):
        for x in offers:
            if isinstance(x,dict) and num(x.get("price")) is not None:
                return x
        for x in offers:
            if isinstance(x,dict): return x
    return {}

def availability(value: Any,text: str) -> str:
    s=(str(value or "")+" "+text[:25000]).lower()
    if any(x in s for x in ("outofstock","out of stock","sold out","currently unavailable")):
        return "Out of stock"
    if any(x in s for x in ("instock","in stock","add to basket","add to cart")):
        return "In stock"
    return "Unknown"

def parse_product(url: str,page: str) -> dict[str,Any]:
    p=product_obj(page)
    offer=offer_obj(p)
    text=strip_text(page)
    title=str((p or {}).get("name") or "").strip() or meta(page,"og:title")
    image=""
    images=(p or {}).get("image")
    if isinstance(images,str): image=images
    elif isinstance(images,list) and images:
        image=images[0] if isinstance(images[0],str) else str(images[0].get("url") or "") if isinstance(images[0],dict) else ""
    elif isinstance(images,dict): image=str(images.get("url") or "")
    image=image or meta(page,"og:image")

    price=num(offer.get("price"))
    if price is None:
        for pat in (
            r"(?:Current price|Sale price|Now|Price)\s*:?\s*£\s*([\d,.]+)",
            r"£\s*([\d,.]+)",
        ):
            m=re.search(pat,text,re.I)
            if m:
                price=num(m.group(1))
                if price is not None: break

    return {
        "title":title[:240],
        "image":image,
        "price":price,
        "availability":availability(offer.get("availability"),text),
        "url":url,
    }

def discover_links(page: str,source: dict[str,Any],limit: int=30) -> list[str]:
    links=[]
    seen=set()
    for raw in re.findall(r'href\s*=\s*["\']([^"\']+)["\']',page,re.I):
        full=urljoin(source["url"],html.unescape(raw)).split("#",1)[0].split("?",1)[0]
        try:
            p=validate_url(full)
        except Exception:
            continue

        is_meaco = "meaco.com" in (p.hostname or "") and p.path.startswith("/products/")
        is_lakeland = "lakeland.co.uk" in (p.hostname or "") and (
            p.path.startswith("/products/") or bool(re.match(r"^/\d+/[^/]+/?$",p.path))
        )
        is_zooplus = "zooplus.co.uk" in (p.hostname or "") and bool(re.search(r"/litter_box_mats/\d+/?$",p.path))
        if not (is_meaco or is_lakeland or is_zooplus):
            continue
        if full not in seen:
            seen.add(full)
            links.append(full)
            if len(links)>=limit: break
    return links

def stable_id(url: str,problem: str) -> str:
    p=urlparse(url)
    numeric=re.findall(r"(\d+)",p.path)
    tail=numeric[-1] if numeric else p.path.strip("/").split("/")[-1]
    slug=re.sub(r"[^a-z0-9]+","-",tail.lower()).strip("-")[:70]
    return f"{problem}-{slug}"[:110]

def summary_for(problem: str,title: str) -> str:
    if problem=="condensation-damp":
        return "Newly checked dehumidifier alternative. Capacity, room temperature and the source of the moisture still need to match the home."
    if problem=="indoor-laundry":
        return "Newly checked indoor-drying alternative. Compare drying capacity, footprint, running cost and whether room ventilation is adequate."
    if problem=="cat-litter-tracking":
        return "Newly checked litter-tracking alternative. Effectiveness depends on whether the cat actually walks across the mat and on litter type."
    return "Newly checked alternative. Confirm fit and suitability before buying."

def recheck_item(item: dict[str,Any]) -> dict[str,Any]:
    out=dict(item)
    stamp=now_iso()
    out["lastCheckedAt"]=stamp
    try:
        page=fetch_text(item["url"])
        p=parse_product(item["url"],page)
        if p["title"]:
            out["title"]=p["title"]
        if p["image"]:
            out["image"]=p["image"]
        if p["price"] is not None:
            old=out.get("price")
            if old is not None:
                out["previousPrice"]=old
            out["price"]=round(p["price"],2)
        out["availability"]=p["availability"]
        out["lastCheckOk"]=True
        if p["availability"]=="Out of stock":
            out["state"]="previous"
            out["previousReason"]="Currently unavailable"
        elif p["availability"]=="In stock":
            if out.get("tier")=="primary" or out.get("sourceType")=="curated":
                out["state"]="current"
            elif out.get("state")=="previous" and out.get("previousReason")=="Currently unavailable":
                out["state"]="current"
                out.pop("previousReason",None)
    except Exception as exc:
        out["lastCheckOk"]=False
        out["checkError"]=str(exc)[:180]
    return out

def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",default="data/household-recommendations.json")
    ap.add_argument("--output",default="data/household-recommendations.json")
    ap.add_argument("--discover",action="store_true")
    ap.add_argument("--summary",default="")
    args=ap.parse_args()

    data=json.loads(Path(args.input).read_text(encoding="utf-8"))
    existing=list(data.get("items") or [])
    checked=[recheck_item(x) for x in existing]
    by_url={str(x.get("url") or "").rstrip("/"):x for x in checked}

    discoveries=[]
    source_health=[]
    if args.discover:
        for source in DISCOVERY_SOURCES:
            try:
                page=fetch_text(source["url"])
                links=discover_links(page,source,30)
                source_health.append({"url":source["url"],"ok":True,"links":len(links)})
                added=0
                for link in links:
                    key=link.rstrip("/")
                    if key in by_url:
                        continue
                    try:
                        ppage=fetch_text(link)
                        parsed=parse_product(link,ppage)
                        title=parsed["title"]
                        if not title or not source["include"].search(title) or source["exclude"].search(title):
                            continue
                        if parsed["availability"]!="In stock":
                            continue
                        item={
                            "id":stable_id(link,source["problem"]),
                            "problem":source["problem"],
                            "problemTitle":source["problemTitle"],
                            "title":title,
                            "retailer":source["retailer"],
                            "url":link,
                            "image":parsed["image"],
                            "price":round(parsed["price"],2) if parsed["price"] is not None else None,
                            "availability":"In stock",
                            "state":"current",
                            "tier":"alternative",
                            "sourceType":"discovered",
                            "firstSeenAt":now_iso(),
                            "lastCheckedAt":now_iso(),
                            "lastCheckOk":True,
                            "summary":summary_for(source["problem"],title),
                        }
                        checked.append(item)
                        by_url[key]=item
                        discoveries.append(item)
                        added+=1
                        if added>=MAX_DISCOVERIES_PER_PROBLEM:
                            break
                    except Exception:
                        continue
                    finally:
                        time.sleep(0.1)
            except Exception as exc:
                source_health.append({"url":source["url"],"ok":False,"links":0,"error":str(exc)[:160]})

    # Keep only the newest MAX_ACTIVE_ALTERNATIVES discovered alternatives active per problem.
    problems={x.get("problem") for x in checked if x.get("problem")}
    for problem in problems:
        alts=[x for x in checked if x.get("problem")==problem and x.get("tier")=="alternative" and x.get("state")=="current"]
        alts.sort(key=lambda x:x.get("firstSeenAt") or "",reverse=True)
        for old in alts[MAX_ACTIVE_ALTERNATIVES:]:
            old["state"]="previous"
            old["previousReason"]="Superseded by newer checked alternatives"

    checked.sort(key=lambda x:(
        x.get("problem") or "",
        0 if x.get("state")=="current" else 1,
        0 if x.get("tier")=="primary" else 1,
        x.get("firstSeenAt") or ""
    ))

    payload={
        "generatedAt":now_iso(),
        "mode":"persistent-recommendations",
        "automation":{
            "dailyRecheck":True,
            "discoveryRun":bool(args.discover),
            "discoveredCount":len(discoveries),
            "sources":source_health,
        },
        "items":checked,
    }
    Path(args.output).write_text(json.dumps(payload,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")

    summary={
        "ok":True,
        "generatedAt":payload["generatedAt"],
        "total":len(checked),
        "current":sum(1 for x in checked if x.get("state")=="current"),
        "previous":sum(1 for x in checked if x.get("state")=="previous"),
        "discovered":len(discoveries),
        "sourceHealth":source_health,
    }
    if args.summary:
        Path(args.summary).write_text(json.dumps(summary,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(summary,indent=2))
    return 0

if __name__=="__main__":
    sys.exit(main())
