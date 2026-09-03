# Media Flip Scanner V4

This version adds the requested one-tap camera mode.

## Main button

Open `index.html` and tap:

**📷 OPEN CAMERA SCANNER**

Inside camera mode, tap:

**📷 SWITCH CAMERA MODE ON**

The scanner then:
- opens the rear camera
- continuously scans common retail barcodes
- stops automatically when it detects one
- vibrates on supported phones
- shows the barcode
- provides a **SCAN NEXT ITEM** button
- provides £1/£2/£3/£4/£5 quick-buy buttons
- calculates net profit, ROI and maximum purchase price

## Important hosting note

For iPhone camera access to work reliably, serve the files from an HTTPS website. Opening local HTML files directly on a phone may not grant camera access consistently.

## Current valuation step

The scanner itself is working independently from the resale data source. Enter the eBay SOLD benchmark manually for now.

The next integration is:

BARCODE → exact product identity → SOLD evidence → automated resale benchmark → BUY / WATCH / PASS

That automated SOLD-price step still requires a reliable sold-history source. The scanner deliberately does not substitute active eBay asking prices.
