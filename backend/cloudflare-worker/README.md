# Den's Deal Engine secure lookup backend

This Cloudflare Worker keeps marketplace credentials off the public GitHub Pages site and serves the verified Live Market feed.

## What it does

- `GET /health` confirms the service is running and reports Live Market storage readiness.
- `GET /live-market` returns only currently eligible, recently verified opportunities.
- `GET /live-market/status` reports the active storage mode and whether private admin writes are ready.
- `POST /admin/live-market` writes a verified feed when KV + admin authentication are configured.
- `GET /lookup?barcode=0711719720148` looks up a GTIN/EAN/UPC.
- Uses UPCitemdb, CeX UK and, when configured, the eBay Browse API.
- Returns title, category, model/edition clues, product image(s), and current marketplace references.
- This endpoint does **not** claim active eBay listings are sold-price history.

## Required Cloudflare secrets for eBay enrichment

- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`

Optional:

- `UPCITEMDB_USER_KEY`
- `UPCITEMDB_KEY_TYPE` (normally `3scale`)
- `EBAY_MARKETPLACE_ID=EBAY_GB`

## Live Market: production storage setup

The repository's `data/live-market.json` is only a safe public fallback. It must **not** be treated as permanently verified inventory. Items automatically disappear when their `verifiedAt` age exceeds `maxVerificationAgeHours`.

To enable the writable Live Market:

1. In Cloudflare, open **Workers & Pages → KV** and create a namespace, for example `mde-live-market`.
2. Open the `deal-engine-api` Worker → **Settings → Bindings**.
3. Add a **KV Namespace** binding with variable name exactly `MDE_MARKET_KV`, pointing to that namespace.
4. Under Worker **Variables and Secrets**, add a secret named exactly `MDE_ADMIN_TOKEN`. Use a long random value and never commit it to GitHub.
5. Deploy the Worker.
6. Open `/health`. Expected values:
   - `"marketStorage":"kv"`
   - `"marketAdminConfigured":true`
7. Open `/live-market/status`. Expected values:
   - `"storage":"kv"`
   - `"adminWriteReady":true`

Do **not** copy stale fallback items into KV merely to make the feed non-empty. Re-verify exact edition, current price, stock/availability and source URL first, then give the item a fresh `verifiedAt`.

## Admin update contract

Send JSON to `POST /admin/live-market` with:

- `Authorization: Bearer <MDE_ADMIN_TOKEN>`
- `Content-Type: application/json`
- body `{"items":[...]}`

The Worker caps updates at 250 items and the public endpoint still applies verification-age, availability, expiry, affiliate, source-verification and margin safeguards.

## Secure lookup connection

After deployment, copy the Worker URL (currently expected to be `https://deal-engine-api.dennis-deeper.workers.dev`) into **Scanner → Identification Connection → Secure Backend URL** and press **SAVE CONNECTION**.

V7.5+ also queries the CeX UK product service by barcode and returns current sell/cash/voucher reference prices when available.
