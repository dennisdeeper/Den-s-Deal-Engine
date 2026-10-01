import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import live_market_scan as scan


class LiveMarketScanTests(unittest.TestCase):
    def test_discovers_product_links(self):
        page = """
        <a href="/p/4k/example-limited-edition-4k/12345678/">One</a>
        <a href="/p/4k/example-limited-edition-4k/12345678/?x=1">Dup</a>
        <a href="https://www.zavvi.com/p/blu-ray/steelbook-title/98765432/">Two</a>
        """
        links = scan.discover_links(page, "https://www.zavvi.com/c/offers/sale/4k/", 10)
        self.assertEqual(len(links), 2)
        self.assertTrue(links[0].endswith("/12345678/"))
        self.assertTrue(links[1].endswith("/98765432/"))

    def test_discovers_hmv_product_links(self):
        page = """
        <a href="/store/film-tv/4k-ultra-hd-blu-ray/signs-(hmv-exclusive)-limited-edition-4k-ultra-hd">One</a>
        <a href="/store/film-tv/steelbooks/example-limited-edition-steelbook">Two</a>
        <a href="/store/film-tv/4k-ultra-hd-blu-ray">Category</a>
        """
        links = scan.discover_links(page, "https://hmv.com/store/hmv-offers/4k-ultra-hd-blu-ray-offers", 10)
        self.assertEqual(len(links), 2)
        self.assertTrue(links[0].startswith("https://hmv.com/store/film-tv/4k-ultra-hd-blu-ray/"))
        self.assertTrue(links[1].startswith("https://hmv.com/store/film-tv/steelbooks/"))

    def test_discovers_rarewaves_product_links(self):
        page = """
        <a href="/products/example-limited-edition-4k">One</a>
        <a href="https://www.rarewaves.com/products/another-4k-steelbook">Two</a>
        <a href="/collections/4k-ultra-hd-blu-ray">Collection</a>
        """
        links = scan.discover_links(page, "https://www.rarewaves.com/collections/4k-ultra-hd-blu-ray-offers", 10)
        self.assertEqual(len(links), 2)
        self.assertTrue(links[0].startswith("https://www.rarewaves.com/products/"))
        self.assertTrue(links[1].startswith("https://www.rarewaves.com/products/"))

    def test_parses_shopify_sale_price_fallback(self):
        page = """
        <html><head><meta property="og:title" content="Example Limited Edition 4K Ultra HD"></head>
        <body>Regular price £29.99 Sale price £17.99 In stock</body></html>
        """
        source = [x for x in scan.SOURCES if x.retailer == "Rarewaves UK"][0]
        parsed = scan.parse_product(
            "https://www.rarewaves.com/products/example-limited-edition-4k-ultra-hd",
            page,
            source,
        )
        self.assertEqual(parsed["price"], 17.99)
        self.assertEqual(parsed["referencePrice"], 29.99)
        self.assertEqual(parsed["availability"], "In stock")

    def test_parses_hmv_was_now_fallback(self):
        page = """
        <html><head><meta property="og:title" content="Example Limited Edition 4K Ultra HD Steelbook"></head>
        <body>Was £24.99 Now £15.99 Add to basket</body></html>
        """
        source = scan.Source("HMV UK", "https://hmv.com/", region="UK", tags=("hmv",))
        parsed = scan.parse_product(
            "https://hmv.com/store/film-tv/4k-ultra-hd-blu-ray/example-limited-edition-4k-ultra-hd",
            page,
            source,
        )
        self.assertEqual(parsed["price"], 15.99)
        self.assertEqual(parsed["referencePrice"], 24.99)
        self.assertEqual(parsed["availability"], "In stock")

    def test_parses_jsonld_product(self):
        product = {
            "@context":"https://schema.org",
            "@type":"Product",
            "name":"Example Limited Edition 4K UHD",
            "image":["https://cdn.example.com/cover.jpg"],
            "offers":{
                "@type":"Offer",
                "price":"14.99",
                "availability":"https://schema.org/InStock"
            }
        }
        page = f"""
        <html><head>
        <script type="application/ld+json">{json.dumps(product)}</script>
        </head><body>
        Recommended Retail Price: £29.99
        In stock
        </body></html>
        """
        parsed = scan.parse_product(
            "https://www.zavvi.com/p/4k/example-limited-edition-4k/12345678/",
            page,
            scan.SOURCES[0],
        )
        self.assertEqual(parsed["title"], "Example Limited Edition 4K UHD")
        self.assertEqual(parsed["price"], 14.99)
        self.assertEqual(parsed["referencePrice"], 29.99)
        self.assertEqual(parsed["availability"], "In stock")
        self.assertEqual(parsed["image"], "https://cdn.example.com/cover.jpg")

    def test_out_of_stock_rejected(self):
        parsed = {
            "title":"Example Limited Edition 4K UHD",
            "price":14.99,
            "referencePrice":29.99,
            "availability":"Out of stock",
            "image":"",
            "url":"https://www.zavvi.com/p/4k/example-limited-edition-4k/12345678/",
        }
        self.assertIsNone(scan.public_item(parsed, scan.SOURCES[0]))

    def test_score_prefers_large_discount_collector(self):
        a = {
            "title":"Example Limited Edition 4K UHD Steelbook",
            "price":10,
            "referencePrice":30,
            "tags":["steelbook","limited-edition","4k"],
        }
        b = {
            "title":"Plain 4K UHD",
            "price":20,
            "referencePrice":25,
            "tags":["4k"],
        }
        self.assertGreater(scan.score_item(a), scan.score_item(b))

    def test_rank_movement_and_price_drop_history(self):
        selected = [
            {
                "title":"Deal A","retailer":"Zavvi UK",
                "publicUrl":"https://www.zavvi.com/p/4k/deal-a/11111111/",
                "price":8.99,
            },
            {
                "title":"Deal B","retailer":"Arrow Films UK",
                "publicUrl":"https://www.arrowfilms.com/p/4k/deal-b/22222222/",
                "price":20.00,
            },
        ]
        previous = [
            {
                "title":"Deal B","publicUrl":"https://www.arrowfilms.com/p/4k/deal-b/22222222/",
                "rank":1,"price":25.00,"firstSeenAt":"2026-09-30T10:00:00Z","verifiedAt":"2026-10-01T10:00:00Z",
            },
            {
                "title":"Deal A","publicUrl":"https://www.zavvi.com/p/4k/deal-a/11111111/",
                "rank":2,"price":8.99,"firstSeenAt":"2026-09-30T10:00:00Z","verifiedAt":"2026-10-01T10:00:00Z",
            },
        ]
        out = scan.annotate_history(selected, previous)
        self.assertEqual(out[0]["rank"], 1)
        self.assertEqual(out[0]["rankChange"], 1)
        self.assertFalse(out[0]["isNew"])
        self.assertEqual(out[1]["rankChange"], -1)
        self.assertEqual(out[1]["priceDrop"], 5.0)
        self.assertEqual(out[1]["firstSeenAt"], "2026-09-30T10:00:00Z")

    def test_balancing_prevents_single_retailer_takeover(self):
        items = []
        for i in range(20):
            items.append({
                "title":f"Z {i}",
                "retailer":"Zavvi UK",
                "publicUrl":f"https://www.zavvi.com/p/x/z-{i}/{100000+i}/",
                "price":10+i/100,
                "_score":100-i,
            })
        for i in range(8):
            items.append({
                "title":f"A {i}",
                "retailer":"Arrow Films UK",
                "publicUrl":f"https://www.arrowfilms.com/p/x/a-{i}/{200000+i}/",
                "price":20+i/100,
                "_score":80-i,
            })
        selected = scan.select_balanced(items, 20)
        counts = {}
        for x in selected:
            counts[x["retailer"]] = counts.get(x["retailer"],0)+1
        self.assertLessEqual(counts["Zavvi UK"], 13)
        self.assertGreaterEqual(counts["Arrow Films UK"], 7)


if __name__ == "__main__":
    unittest.main()
