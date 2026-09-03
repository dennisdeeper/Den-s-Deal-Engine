# Den's Deal Engine secure lookup backend

This optional Cloudflare Worker keeps marketplace credentials off the public GitHub Pages site.

## What it does

- `GET /health` confirms the service is running.
- `GET /lookup?barcode=0711719720148` looks up a GTIN/EAN/UPC.
- Uses UPCitemdb and, when eBay credentials are configured, the eBay Browse API.
- Returns title, category, model/edition clues, product image(s), and an active eBay listing reference when available.
- This endpoint does **not** claim active eBay listings are sold-price history.

## Secrets to add in Cloudflare

Required for eBay enrichment:

- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`

Optional for a paid UPCitemdb plan:

- `UPCITEMDB_USER_KEY`
- `UPCITEMDB_KEY_TYPE` (normally `3scale`)

Set `EBAY_MARKETPLACE_ID` to `EBAY_GB` for the UK market.

After deployment, copy the Worker URL (for example `https://dens-deal-engine-api.<account>.workers.dev`) into **Scanner → Identification Connection → Secure Backend URL** and press **SAVE CONNECTION**.
