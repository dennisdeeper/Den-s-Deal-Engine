# Den's Deal Engine secure lookup backend

This Cloudflare Worker keeps marketplace credentials off the public GitHub Pages site and serves the barcode lookup plus Live Market APIs.

## Endpoints

- `GET /health` — service/configuration health.
- `GET /lookup?barcode=0711719720148` — GTIN/EAN/UPC lookup.
- `GET /live-market` — public verified Live Market feed.
- `GET /live-market/status` — Live Market storage/write readiness.
- `POST /admin/live-market` — authenticated Live Market feed update.

## Cloudflare bindings and secrets

Required for Live Market managed storage:

- KV binding: `MDE_MARKET_KV` → the dedicated Live Market KV namespace.
- Admin secret: `MDE_ADMIN_TOKEN`.

For backward compatibility the Worker also accepts the existing `ADMIN_TOKEN` secret, so an existing deployment can be upgraded without rotating the secret.

Required for eBay enrichment:

- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`

Optional:

- `UPCITEMDB_USER_KEY`
- `UPCITEMDB_KEY_TYPE` (normally `3scale`)
- `EBAY_MARKETPLACE_ID=EBAY_GB`
- `MDE_MIN_IMMEDIATE_ROI=50`
- `MDE_DEFAULT_FEE_RATE=0.13`

## Live Market safety

Do not copy stale fallback items into KV or simply refresh their timestamps. Re-verify the exact edition, current price, current stock/availability and source URL before updating `verifiedAt`.

After deployment, check:

- `/health` → `marketStorage: "kv"` and `marketAdminConfigured: true`
- `/live-market/status` → `storage: "kv"` and `adminWriteReady: true`

The public endpoint deliberately filters stale, unavailable and expired items.

V7.5+ also queries the CeX UK product service by barcode and returns current sell/cash/voucher reference prices when available.
