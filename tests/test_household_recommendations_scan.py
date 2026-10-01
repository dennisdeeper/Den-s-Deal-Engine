import json
import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
import household_recommendations_scan as scan

class HouseholdRecommendationTests(unittest.TestCase):
    def test_parse_product_jsonld(self):
        product={
            "@context":"https://schema.org",
            "@type":"Product",
            "name":"Example 12L Dehumidifier",
            "image":["https://cdn.example.com/p.jpg"],
            "offers":{"@type":"Offer","price":"159.99","availability":"https://schema.org/InStock"}
        }
        page=f'<script type="application/ld+json">{json.dumps(product)}</script>'
        parsed=scan.parse_product("https://www.meaco.com/products/example",page)
        self.assertEqual(parsed["title"],"Example 12L Dehumidifier")
        self.assertEqual(parsed["price"],159.99)
        self.assertEqual(parsed["availability"],"In stock")
        self.assertEqual(parsed["image"],"https://cdn.example.com/p.jpg")

    def test_out_of_stock_moves_to_history(self):
        original_fetch=scan.fetch_text
        try:
            scan.fetch_text=lambda url: '<html><head><meta property="og:title" content="Example Product"></head><body>Out of stock</body></html>'
            item={
                "id":"x","problem":"condensation-damp","problemTitle":"Condensation & damp",
                "title":"Example Product","retailer":"Meaco","url":"https://www.meaco.com/products/example",
                "state":"current","tier":"primary","sourceType":"curated",
                "firstSeenAt":"2026-10-01T10:00:00Z","lastCheckedAt":"2026-10-01T10:00:00Z",
            }
            out=scan.recheck_item(item)
            self.assertEqual(out["state"],"previous")
            self.assertEqual(out["previousReason"],"Currently unavailable")
            self.assertTrue(out["lastCheckOk"])
        finally:
            scan.fetch_text=original_fetch

    def test_discovery_filters_accessories(self):
        source=[x for x in scan.DISCOVERY_SOURCES if x["problem"]=="indoor-laundry"][0]
        self.assertTrue(source["include"].search("Dry:Soon 3-Tier Heated Airer"))
        self.assertTrue(source["exclude"].search("Dry:Soon Heated Airer Cover"))

    def test_stable_id(self):
        x=scan.stable_id("https://www.zooplus.co.uk/shop/cats/cat_litter_litter_boxes/deo_accessoires/litter_box_mats/774094","cat-litter-tracking")
        self.assertIn("774094",x)
        self.assertTrue(x.startswith("cat-litter-tracking-"))

if __name__=="__main__":
    unittest.main()
