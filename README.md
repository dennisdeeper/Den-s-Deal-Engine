# Den’s Deal Engine V7.4 — Exact Image Matching

V7.4 is the professional artwork reliability release. The scanner still keeps the resilient barcode-identification chain from V7.3, but it now treats artwork as verified product data rather than decoration.

## What changed

- Exact artwork only: the app shows an image only when it was supplied by a catalogue or marketplace result matched to the scanned barcode/GTIN.
- No generic substitutes: if the exact product cannot be identified, V7.4 deliberately displays no product artwork rather than risk showing the wrong game, film, album or book.
- Professional artwork frame: covers are contained at their natural proportions inside a clean presentation card instead of being stretched or cropped.
- Image recovery: when an exact-match image URL is broken, V7.4 automatically tries the next image candidate from the same barcode-matched result set.
- Clear trust state: identified products can display an “Exact barcode artwork” badge and source label. Unresolved barcodes show “Awaiting exact match”.
- Stronger eBay backend artwork: the included Cloudflare Worker keeps multiple image candidates from GTIN-constrained eBay Browse results and prioritises those before UPC catalogue images.

## Identification order

1. Optional secure Deal Engine backend (recommended; eBay GTIN + UPC lookup)
2. UPC catalogue fallback
3. Google Books / Open Library for ISBNs
4. MusicBrainz for music releases

If no provider returns an exact product, the barcode remains available for exact eBay sold-result searching, but the app will not invent an image.

## GitHub Pages update

Replace your existing `index.html` and `scanner.html` with the V7.4 versions. This gives you the new professional artwork behaviour immediately for the public fallbacks.

For the strongest game/Blu-ray/product identification, deploy the optional Worker in `backend/cloudflare-worker/`, add your eBay credentials as Cloudflare secrets, then save the Worker HTTPS URL in the app’s Identification Connection panel. Do not place eBay credentials in GitHub Pages.

## Important market-data note

The eBay Browse API data used for product identification is active-listing/catalogue evidence; it is not represented as completed/sold history. The app still treats sold-market evidence separately.
