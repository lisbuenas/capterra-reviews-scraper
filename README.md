# Capterra Reviews Scraper

Scrape every review from any [Capterra](https://www.capterra.com) software listing: overall and sub-ratings, pros and cons, reviewer job title, industry and company size, review dates, and verification details. Each review becomes one item in the Apify dataset.

## Features

- **Flexible input**: product URLs, `ID/slug` pairs, or plain product names resolved through Capterra search.
- **Full review text**: the text is read from the page's embedded data, so it isn't cut off by "Continue reading".
- **Fields that aren't shown on the page**: company size, reviewer validation status and method, and review source codes.
- **Automatic pagination** by following Capterra's next-page link.
- **Resilient**: waits out Cloudflare challenges, rotates proxy sessions, retries failed pages, de-duplicates reviews, and falls back to parsing the rendered HTML if the embedded data changes.
- **Limits** on reviews or pages per product.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `products` | array of strings | **required** | `https://www.capterra.com/p/164283/Zendesk/`, `164283/Zendesk`, or `zendesk` |
| `maxReviewsPerProduct` | integer | `0` (no limit) | Stop after N reviews per product |
| `maxPagesPerProduct` | integer | `0` (no limit) | Stop after N pages (25 reviews each) per product |
| `maxConcurrency` | integer | `3` | Parallel browser pages |
| `maxRequestRetries` | integer | `8` | Retries per page, each with a fresh proxy session |
| `proxyConfiguration` | object | `{ "useApifyProxy": true }` | Apify Proxy settings. Residential proxies give the best results against Cloudflare. |

Example:

```json
{
  "products": [
    "https://www.capterra.com/p/164283/Zendesk/",
    "asana"
  ],
  "maxReviewsPerProduct": 500,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

## Output

One dataset item per review:

```json
{
  "reviewId": "Capterra___7070758",
  "reviewUrl": "https://www.capterra.com/p/164283/Zendesk/#Capterra___7070758",
  "productId": "164283",
  "productSlug": "Zendesk",
  "productName": "Zendesk Suite",
  "productUrl": "https://www.capterra.com/p/164283/Zendesk/",
  "title": "Getting started with Zendesk from scratch",
  "date": "December 29, 2025",
  "dateIso": "2025-12-29",
  "summary": "As a self-taught Zendesk Admin, having an engaged community ...",
  "pros": "Excellent customer support platform, making it easy to centralize service channels ...",
  "cons": "Many simple but useful features are left out in order to focus on new products ...",
  "reasonsForChoosing": "Support history, native channels, integrations",
  "reasonsForSwitching": null,
  "adviceToOthers": null,
  "alternativesConsidered": ["Jira", "Movidesk"],
  "switchedFrom": null,
  "vendorResponse": null,
  "rating": {
    "overall": 4,
    "easeOfUse": 4,
    "customerService": 5,
    "features": 4,
    "valueForMoney": 3,
    "likelihoodToRecommend": 8
  },
  "reviewer": {
    "name": "Leonardo S.",
    "jobTitle": "Support Analyst",
    "industry": "Information Technology and Services",
    "companySize": "201-500 employees",
    "timeUsedProduct": "2+ years",
    "profilePicUrl": null,
    "linkedInVerified": false,
    "anonymous": false
  },
  "isVerified": true,
  "verificationMethods": ["ProofOfLink"],
  "incentivized": "VendorReferredIncentivized",
  "reviewSource": {
    "code": "VRI",
    "description": "Vendor Referred - Incentive Offered: This reviewer was invited by the software vendor ..."
  },
  "sourceSite": "Capterra",
  "page": 1,
  "scrapedAt": "2026-09-15T12:00:00.000Z",
  "dataSource": "payload"
}
```

Missing values are always `null`. `rating.likelihoodToRecommend` uses a 0–10 scale; the other ratings use 1–5.

`dataSource` is `payload` when the data came from the page's embedded JSON (all fields available). It is `dom` when the scraper fell back to the rendered HTML, where `reviewId`, `companySize` and `isVerified` are `null`.

Pages that still fail after all retries are saved as items with `"#error": true`, the URL and the error message.

## Limitations

- Capterra serves at most **100 review pages (2,500 reviews)** per product through its public pages. Later pages redirect to page 1, and the scraper stops there.
- Capterra is protected by Cloudflare. Runs without a proxy, or with datacenter proxies, may be blocked. Use Apify residential proxies for reliable results.

## Run locally

```bash
npm install
npx playwright install chromium
mkdir -p storage/key_value_stores/default
echo '{"products":["164283/Zendesk"],"maxPagesPerProduct":2}' > storage/key_value_stores/default/INPUT.json
npm start
```

Results are written to `storage/datasets/default/`.

## Tech

Node.js 20, [Crawlee](https://crawlee.dev) `PlaywrightCrawler`, and the [Apify SDK](https://docs.apify.com/sdk/js). Capterra returns a Cloudflare 403 challenge to plain HTTP clients, so `CheerioCrawler` doesn't work and a real browser is required.
