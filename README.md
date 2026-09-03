# Den's Deal Engine V7.6 — Artwork Enrichment

V7.6 fixes the V7.5 early-exit bug: identification and artwork lookup are now separate. The scanner queries every applicable exact-barcode source, merges matches, prioritises eBay GTIN artwork when the secure backend is configured, then UPC/ISBN/music artwork, with the CeX barcode-matched reference image as a final artwork candidate.

The camera still collapses immediately after a positive barcode lock. If an image is available from any matching source, it replaces the camera. If no matching source supplies an image, the app stays clean and says artwork is unavailable instead of showing a generic product.

For strongest game/Blu-ray artwork accuracy, deploy the included Cloudflare Worker and add eBay API credentials, then save its HTTPS URL in Scanner → Identification Connection.
