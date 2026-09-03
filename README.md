# Den’s Deal Engine V7.5 — Exact Image Matching

V7.5 is the professional artwork reliability release. The scanner still keeps the resilient barcode-identification chain from V7.3, but it now treats artwork as verified product data rather than decoration.

## What changed

- Exact artwork only: the app shows an image only when it was supplied by a catalogue or marketplace result matched to the scanned barcode/GTIN.
- No generic substitutes: if the exact product cannot be identified, V7.5 deliberately displays no product artwork rather than risk showing the wrong game, film, album or book.
- Professional artwork frame: covers are contained at their natural proportions inside a clean presentation card instead of being stretched or cropped.
- Image recovery: when an exact-match image URL is broken, V7.5 automatically tries the next image candidate from the same barcode-matched result set.
- Clear trust state: identified products can display an “Exact barcode artwork” badge and source label. Unresolved barcodes show “Awaiting exact match”.
- Stronger eBay backend artwork: the included Cloudflare Worker keeps multiple image candidates from GTIN-constrained eBay Browse results and prioritises those before UPC catalogue images.

## Identification order

1. Optional secure Deal Engine backend (recommended; eBay GTIN + UPC lookup)
2. UPC catalogue fallback
3. Google Books / Open Library for ISBNs
4. MusicBrainz for music releases

If no provider returns an exact product, the barcode remains available for exact eBay sold-result searching, but the app will not invent an image.

## GitHub Pages update

Replace your existing `index.html` and `scanner.html` with the V7.5 versions. This gives you the new professional artwork behaviour immediately for the public fallbacks.

For the strongest game/Blu-ray/product identification, deploy the optional Worker in `backend/cloudflare-worker/`, add your eBay credentials as Cloudflare secrets, then save the Worker HTTPS URL in the app’s Identification Connection panel. Do not place eBay credentials in GitHub Pages.

## Important market-data note

The eBay Browse API data used for product identification is active-listing/catalogue evidence; it is not represented as completed/sold history. The app still treats sold-market evidence separately.


## V7.5 additions
- Instant camera-to-artwork transition after a successful barcode lock.
- CeX UK lookup added as a live market-reference source for WeSell, cash-buy and voucher-buy prices.
- CeX is treated as a pricing/reference source; eBay GTIN remains preferred for exact marketplace artwork when the secure backend is configured.
- The CeX web service used here is not a documented public developer API and may change; the Cloudflare Worker keeps this integration isolated so it can be updated without exposing secrets in GitHub Pages.

Note: CeX states that website images are for illustration purposes, so V7.5 uses CeX for live price/reference data rather than treating CeX artwork as verified exact cover art.
