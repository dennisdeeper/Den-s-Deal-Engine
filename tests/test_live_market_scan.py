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
