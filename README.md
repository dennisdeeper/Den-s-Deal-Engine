# Den's Deal Engine V7.7 — Reliable Artwork Proxy

V7.7 fixes the remaining artwork-delivery weakness.

## What changed
- The scanner still captures the barcode and immediately transitions away from the camera.
- The secure Cloudflare Worker now performs product lookup and also exposes `/image?url=...`.
- Exact product artwork from eBay/CeX/catalogue sources is proxied through the Worker, avoiding fragile direct hotlinks from GitHub Pages.
- The proxy is allow-listed to known image hosts and only accepts HTTPS image URLs.
- Exact artwork remains exact-source artwork; no generic replacement is used.
- The UI shows `ARTWORK PROXY ON` when the result came through the connected backend.

## Important: GitHub Pages alone cannot provide reliable exact artwork
The frontend can still use public browser fallbacks, but eBay credentials and server-side image fetching cannot safely run in GitHub Pages. Deploy the included Worker and connect its HTTPS URL in the app's Backend URL field.

## Cloudflare Worker setup
1. Create a Cloudflare Worker.
2. Replace its code with `backend/cloudflare-worker/worker.js`.
3. Add secrets `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`.
4. Optional: add `UPCITEMDB_USER_KEY` and `UPCITEMDB_KEY_TYPE`.
5. Deploy the Worker and copy its `https://...workers.dev` URL.
6. In Den's Deal Engine, paste that URL into the Backend URL field and save it.
7. Test `<worker-url>/health` in a browser; it should report `ok: true`.

## GitHub update
Replace `index.html` and `scanner.html` with the V7.7 versions. The Worker is deployed separately; do not put eBay secrets into GitHub.
