# MDE Live Market feed contract (v8)

The public page requests:

`GET https://deal-engine-api.dennis-deeper.workers.dev/live-market`

Return either an array of items or:

```json
{
  "generatedAt": "2026-09-22T08:15:00+01:00",
  "items": []
}
```

## Public-safe item fields

- `id`
- `title`
- `price` — GBP
- `marketLow` / `marketHigh` — realistic market comparison in GBP
- `format`
- `label`
- `region`
- `image`
- `url`
- `channel` — `affiliate`, `owned`, or `dropship`
- `publicSeller`
- `retailer` — only when the retailer is intentionally public, e.g. affiliate partner
- `status` — must be `live` to display
- `availability`
- `dealType` — `flash`, `immediate`, `hold`, or `preorder`
- `tags`
- `signal`
- `reason`
- `roi`
- `marginSafe` — `false` hides the item immediately
- `verifiedAt`
- `maxVerificationAgeHours`
- `expiresAt` — only supply when a real promotion expiry is known

## Internal fields that should NOT be sent to the public page

Keep these in the Worker/admin data layer:

- source retailer for MDE-owned/dropship stock
- source purchase URL
- acquisition cost
- supplier account identifiers
- partner credentials
- API keys/secrets
- internal margin logic/thresholds
- sourcing notes

## Safety behaviour already implemented in the browser

The v8 page:
- refuses to display non-live items
- refuses stale verification data
- removes expired items
- hides items where `marginSafe === false`
- does not fabricate countdown timers
- does not show an internal source retailer
- clearly discloses affiliate links
- refreshes the feed every 5 minutes
