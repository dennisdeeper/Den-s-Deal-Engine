# Media Flip Scanner V5 — Product Identification

Replace your existing GitHub Pages files with:
- index.html
- scanner.html

README.md is optional.

After scanning, V5 attempts product identification using the UPCitemdb free trial lookup endpoint.

It can display title, barcode, brand/publisher, category, model, description, image, inferred PS5/PS4/4K UHD/Blu-ray format, edition clues and region clues.

The **OPEN eBAY SOLD RESULTS** button opens eBay UK with Sold + Completed filters using the title and barcode.

Important: the free UPCitemdb service is rate-limited and will not contain every media barcode. When product information is incomplete the app says so instead of inventing an edition.

Static GitHub Pages cannot safely store private eBay API client secrets, so a fully automatic eBay API valuation step should later use a small backend/serverless function.
