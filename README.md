# Den's Deal Engine V7.3 — Resilient Identification

V7.3 fixes the "barcode detected, product identification unavailable / Load failed" weakness in V7.2.

## Front-end changes

The scanner now keeps barcode capture separate from catalogue identification. After a valid barcode is captured it tries, in order:

1. Optional secure Den's Deal Engine backend
2. UPCitemdb public catalogue
3. Google Books for ISBN-13 barcodes
4. Open Library for ISBN-13 barcodes
5. MusicBrainz for music-release barcodes

If one provider fails, V7.3 continues to the next provider rather than presenting the whole scan as failed. The status line reports the provider being tried and the successful source is shown as a badge on the product card.

If no catalogue identifies the item, the barcode remains usable and the eBay sold-results button searches by that barcode so the exact edition can still be verified manually.

## Product images

Images are loaded from whichever successful catalogue supplies one. A broken image URL is hidden automatically rather than leaving a broken-image icon.

## Secure eBay lookup backend

`backend/cloudflare-worker/` contains an optional Cloudflare Worker. It can use eBay's Browse API to search by GTIN and enrich the identification with title, category, model clues, image, and current listing information while keeping the eBay Client Secret off GitHub Pages.

Do **not** paste an eBay Client Secret into `index.html` or `scanner.html`.

The eBay Browse information in this backend is active-listing/product-identification data. It is not presented as completed/sold-price history. V7.3 continues to use the eBay completed/sold search link and manual Market Radar samples for sold evidence until a lawful sold-data source is connected.

## Upload to GitHub Pages

Replace the current site's `index.html` and `scanner.html` with the V7.3 versions. The `backend/` folder is source code for the optional secure service and does not run on GitHub Pages by itself.
