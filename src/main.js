/**
 * Capterra Reviews Scraper
 *
 * Capterra is a Next.js app behind Cloudflare. Plain HTTP clients (CheerioCrawler)
 * get a 403 challenge page, so we use PlaywrightCrawler, which lets the challenge
 * resolve in a real browser.
 *
 * Once a reviews page has loaded, the full review data (including fields that are
 * never rendered, such as company size and validation status) is embedded in the
 * React Server Components payload (`self.__next_f.push(...)` scripts). We parse that
 * payload as the primary source and fall back to scraping the rendered review cards
 * if the payload format ever changes.
 *
 * Flow:
 *   products input ──► SEARCH (plain names only) ──► REVIEWS page 1 ──► page 2 ──► ...
 * Pages of one product are chained one after another by following the "next page"
 * link, which keeps de-duplication and limits simple. Different products run in parallel.
 */
import { Actor, log } from 'apify';
import { PlaywrightCrawler, playwrightUtils } from 'crawlee';
import { chromium as stealthChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
stealthChromium.use(StealthPlugin());

const BASE_URL = 'https://www.capterra.com';
const REVIEWS_PER_PAGE = 25;

const LABELS = {
    SEARCH: 'SEARCH',
    REVIEWS: 'REVIEWS',
};

await Actor.init();

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const input = (await Actor.getInput()) ?? {};
const {
    products = [],
    maxReviewsPerProduct = 0,
    maxPagesPerProduct = 0,
    maxConcurrency = 3,
    maxRequestRetries = 8,
    proxyConfiguration: proxyInput = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

// Accept the conventional `startUrls` shape too ([{ url }] or [string]).
const rawProducts = [
    ...products,
    ...(input.startUrls ?? []).map((s) => (typeof s === 'string' ? s : s?.url)),
].filter((p) => typeof p === 'string' && p.trim());

if (rawProducts.length === 0) {
    throw new Error('Input "products" is empty. Provide at least one Capterra URL, ID/slug pair or product name.');
}

// Locally, Apify Proxy is only available with an Apify token, so skip it if unavailable.
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput).catch((err) => {
    log.warning(`Proxy configuration failed, running without proxy: ${err.message}`);
    return undefined;
});

// ---------------------------------------------------------------------------
// Per-product progress, persisted so an actor migration can resume without
// producing duplicates or exceeding the limits.
// ---------------------------------------------------------------------------

/** @type {Record<string, { reviews: number, pages: number, seenIds: Record<string, true> }>} */
const productState = await Actor.useState('PRODUCT_STATE', {});

function getProductState(productId) {
    productState[productId] ??= { reviews: 0, pages: 0, seenIds: {} };
    return productState[productId];
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

/**
 * Turns a user-supplied product reference into a crawler request.
 * Supported forms:
 *   https://www.capterra.com/p/164283/Zendesk/            (any /p/ URL, incl. /reviews/)
 *   164283/Zendesk                                        (ID/slug pair)
 *   zendesk                                               (plain name -> resolved via search)
 */
function toRequest(raw) {
    const value = raw.trim();

    const idSlug = value.match(/(?:capterra\.com)?\/?p\/(\d+)\/([^/?#]+)/i) ?? value.match(/^(\d+)\/([^/?#]+)\/?$/);
    if (idSlug) {
        const [, productId, slug] = idSlug;
        return reviewsRequest({ productId, slug, page: 1, input: value });
    }

    if (/^https?:\/\//i.test(value)) {
        log.warning(`Unsupported URL, expected a Capterra product URL like ${BASE_URL}/p/164283/Zendesk/: ${value}`);
        return null;
    }

    // Plain product name: let Capterra search resolve it.
    return {
        url: `${BASE_URL}/search/?query=${encodeURIComponent(value)}`,
        label: LABELS.SEARCH,
        userData: { query: value, input: value },
    };
}

function reviewsUrl(productId, slug, page) {
    const url = `${BASE_URL}/p/${productId}/${slug}/reviews/`;
    return page > 1 ? `${url}?page=${page}` : url;
}

function reviewsRequest({ productId, slug, page, input: originalInput }) {
    return {
        url: reviewsUrl(productId, slug, page),
        label: LABELS.REVIEWS,
        // Product ID + page uniquely identify a page, regardless of slug casing.
        uniqueKey: `reviews:${productId}:${page}`,
        userData: { productId, slug, page, input: originalInput },
    };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Concatenates the React Server Components payload chunks embedded in the HTML.
 * Each chunk looks like: self.__next_f.push([1,"<JSON-escaped string>"])
 */
function extractFlightPayload(html) {
    const chunkRegex = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
    let payload = '';
    for (const match of html.matchAll(chunkRegex)) {
        try {
            payload += JSON.parse(match[1]);
        } catch {
            // A malformed chunk should not break the whole page.
        }
    }
    return payload;
}

/**
 * Finds every JSON array stored under `"key":[...]` inside a larger text blob by
 * bracket matching (the payload is not valid JSON as a whole).
 */
function extractJsonArrays(text, key) {
    const results = [];
    const needle = `"${key}":[`;
    let from = 0;

    while (true) {
        const keyIndex = text.indexOf(needle, from);
        if (keyIndex === -1) break;

        const start = keyIndex + needle.length - 1; // position of '['
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === '[' || ch === '{') depth++;
            else if (ch === ']' || ch === '}') {
                depth--;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }

        if (end === -1) break;
        try {
            results.push(JSON.parse(text.slice(start, end)));
        } catch {
            // Ignore fragments that are not valid JSON.
        }
        from = end;
    }

    return results;
}

/** Returns the list of raw review objects from the page payload, or null if not found. */
function extractReviewsFromPayload(html) {
    const payload = extractFlightPayload(html);
    if (!payload) return null;

    const candidates = extractJsonArrays(payload, 'textReviews')
        .filter((arr) => Array.isArray(arr) && arr.some((r) => r && (r.reviewId || r.globalReviewId)));
    if (candidates.length === 0) return null;

    // If several review lists are embedded, the main paginated one is the longest.
    return candidates.sort((a, b) => b.length - a.length)[0];
}

/** Reads the product name and aggregate rating from the JSON-LD block. */
function extractProductInfo(html) {
    const scripts = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
    for (const [, json] of scripts) {
        try {
            const data = JSON.parse(json);
            const items = Array.isArray(data) ? data : [data, ...(data['@graph'] ?? [])];
            const app = items.find((item) => /SoftwareApplication|Product/.test(item?.['@type']));
            if (app) {
                return {
                    productName: app.name ?? null,
                    productRating: toNumber(app.aggregateRating?.ratingValue),
                    productReviewCount: toNumber(app.aggregateRating?.reviewCount ?? app.aggregateRating?.ratingCount),
                };
            }
        } catch {
            // Ignore invalid JSON-LD.
        }
    }
    return { productName: null, productRating: null, productReviewCount: null };
}

function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number.parseFloat(String(value).replace(',', '.'));
    return Number.isFinite(num) ? num : null;
}

/** Empty strings, empty arrays and empty objects all become null. */
function orNull(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value.trim() || null;
    if (Array.isArray(value)) return value.length ? value : null;
    if (typeof value === 'object') return Object.keys(value).length ? value : null;
    return value;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "December 29, 2025" -> "2025-12-29" (null if the format is unknown). */
function toIsoDate(text) {
    const match = text?.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
    if (!match) return null;
    const month = MONTHS.indexOf(match[1].toLowerCase());
    if (month === -1) return null;
    return new Date(Date.UTC(Number(match[3]), month, Number(match[2]))).toISOString().slice(0, 10);
}

/**
 * The payload only includes `reviewSource` for some reviews, while `incentivized`
 * is always present and maps 1:1 to the source code. Descriptions seen on other
 * reviews are cached so they can be filled in for the rest.
 */
const INCENTIVE_TO_SOURCE_CODE = {
    NoIncentive: 'NO',
    VendorReferredIncentivized: 'VRI',
    NominalGift: 'NGC',
};
const sourceDescriptions = {};

function resolveReviewSource(raw) {
    const code = orNull(raw.reviewSource?.code) ?? INCENTIVE_TO_SOURCE_CODE[raw.incentivized] ?? null;
    const description = orNull(raw.reviewSource?.tooltip);
    if (code && description) sourceDescriptions[code] = description;
    if (!code && !description) return null;
    return { code, description: description ?? sourceDescriptions[code] ?? null };
}

/** Maps a raw payload review to the output item shape. */
function normalizeReview(raw, context) {
    const reviewer = raw.reviewer ?? {};
    const reviewId = raw.reviewId ?? raw.globalReviewId ?? raw.id ?? null;
    const productUrl = `${BASE_URL}/p/${context.productId}/${context.slug}/`;
    const productNames = (list) => orNull((list ?? []).map((p) => p?.productName).filter(Boolean));

    return {
        reviewId,
        // Capterra has no standalone review pages; review links resolve to this anchor.
        reviewUrl: reviewId ? `${productUrl}#${reviewId}` : null,
        productId: context.productId,
        productSlug: context.slug,
        productName: context.productName,
        productUrl,

        title: orNull(raw.title),
        date: orNull(raw.writtenOn),
        dateIso: toIsoDate(raw.writtenOn),
        summary: orNull(raw.generalComments),
        pros: orNull(raw.prosText),
        cons: orNull(raw.consText),
        reasonsForChoosing: orNull(raw.chosenReasons),
        reasonsForSwitching: orNull(raw.switchingReasons),
        adviceToOthers: orNull(raw.adviceToOthers),
        alternativesConsidered: productNames(raw.alternativeProducts),
        switchedFrom: productNames(raw.switchedProducts),
        vendorResponse: orNull(raw.vendorResponse),

        rating: {
            overall: toNumber(raw.overallRating),
            easeOfUse: toNumber(raw.easeOfUseRating),
            customerService: toNumber(raw.customerSupportRating),
            features: toNumber(raw.functionalityRating),
            valueForMoney: toNumber(raw.valueForMoneyRating),
            likelihoodToRecommend: toNumber(raw.recommendationRating), // 0-10 scale
        },

        reviewer: {
            name: orNull(reviewer.fullName),
            jobTitle: orNull(reviewer.jobTitle),
            industry: orNull(reviewer.industry),
            companySize: orNull(reviewer.companySize),
            timeUsedProduct: orNull(reviewer.timeUsedProduct),
            profilePicUrl: orNull(reviewer.profilePicUrl),
            linkedInVerified: reviewer.verifiedLinkedIn ?? null,
            anonymous: reviewer.anonymityOn ?? raw.anonymityOn ?? null,
        },

        // Capterra validates reviewers (e.g. proof of use) before publishing.
        isVerified: reviewer.isValidated ?? null,
        verificationMethods: orNull(reviewer.validationsPassed),
        incentivized: orNull(raw.incentivized),
        reviewSource: resolveReviewSource(raw),
        sourceSite: orNull(raw.sourceSite),

        page: context.page,
        scrapedAt: new Date().toISOString(),
        dataSource: 'payload',
    };
}

/**
 * Fallback: scrape the rendered review cards. Fewer fields are available here
 * (no company size, validation status or review ID), so they stay null.
 */
async function extractReviewsFromDom(page) {
    return page.evaluate(() => {
        const text = (el) => el?.textContent?.trim() || null;

        // A card is the outermost ancestor that still contains exactly one overall rating.
        const cards = [...document.querySelectorAll('[data-testid="Overall Rating-rating"]')].map((rating) => {
            let el = rating;
            while (el.parentElement && el.parentElement.querySelectorAll('[data-testid="Overall Rating-rating"]').length === 1) {
                el = el.parentElement;
            }
            return el;
        });

        const sectionText = (card, heading) => {
            const label = [...card.querySelectorAll('span')].find((s) => s.textContent.trim() === heading);
            return text(label?.closest('div')?.querySelector('p'));
        };

        const ratingValue = (card, name) => {
            const el = card.querySelector(`[data-testid="${name}-rating"]`);
            if (!el) return null;
            // "Likelihood to Recommend" is a progress bar labelled "8 /10" (with "80 %" inside).
            const raw = el.querySelector('progress')
                ? el.parentElement?.textContent?.match(/(\d+(?:\.\d+)?)\s*\/\s*10/)?.[1]
                : el.textContent?.match(/\d+(\.\d+)?/)?.[0];
            const num = Number.parseFloat(raw);
            return Number.isFinite(num) ? num : null;
        };

        return cards.map((card) => {
            const nameEl = card.querySelector('span.font-semibold');
            const headerLines = nameEl?.parentElement?.innerText.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
            const timeUsedLine = headerLines.find((l) => l.startsWith('Used the software for:'));
            const details = headerLines.slice(1).filter((l) => l !== timeUsedLine);
            const source = [...card.querySelectorAll('span')].find((s) => s.textContent.trim() === 'Review Source');
            const sourceTooltip = source?.parentElement?.querySelector('div:last-child');
            const heading = card.querySelector('h3');

            return {
                title: text(heading)?.replace(/^"|"$/g, '') ?? null,
                writtenOn: text(heading?.parentElement?.querySelector('div')),
                generalComments: text(card.querySelector('[data-testid="continue-reading-button"]')?.previousElementSibling),
                prosText: sectionText(card, 'Pros'),
                consText: sectionText(card, 'Cons'),
                overallRating: ratingValue(card, 'Overall Rating'),
                easeOfUseRating: ratingValue(card, 'Ease of Use'),
                customerSupportRating: ratingValue(card, 'Customer Service'),
                functionalityRating: ratingValue(card, 'Features'),
                valueForMoneyRating: ratingValue(card, 'Value for Money'),
                recommendationRating: ratingValue(card, 'Likelihood to Recommend'),
                reviewSource: sourceTooltip ? { code: null, tooltip: text(sourceTooltip) } : null,
                reviewer: {
                    fullName: text(nameEl),
                    jobTitle: details[0] ?? null,
                    industry: details[1] ?? null,
                    timeUsedProduct: timeUsedLine?.replace('Used the software for:', '').trim() || null,
                },
            };
        });
    });
}

/** Cloudflare interstitials use these titles. */
const isChallengeTitle = (title) => /just a moment|attention required|access denied/i.test(title ?? '');

/** Waits for Cloudflare's JS challenge to resolve; throws (-> retry with a new session) if it doesn't. */
async function waitForChallenge(page, session) {
    const title = await page.title();
    if (!isChallengeTitle(title)) return;

    log.info(`Cloudflare challenge on ${page.url()}, saving diagnostic screenshot and waiting...`);

    // Save a diagnostic screenshot to the KV store so we can inspect what
    // Cloudflare is showing (passive managed challenge vs. interactive CAPTCHA).
    try {
        const store = await Actor.openKeyValueStore();
        const screenshot = await page.screenshot();
        const key = `cf-challenge-${Date.now()}`;
        await store.setValue(key, screenshot, { contentType: 'image/png' });
        log.info(`Challenge screenshot saved as "${key}" in the default KV store.`);
    } catch (e) {
        log.warning(`Could not save challenge screenshot: ${e.message}`);
    }

    // Simulate human-like mouse movement; some managed challenges respond to activity.
    try {
        const vp = page.viewportSize() ?? { width: 1280, height: 720 };
        await page.mouse.move(vp.width * 0.4, vp.height * 0.4);
        await page.waitForTimeout(700);
        await page.mouse.move(vp.width * 0.6, vp.height * 0.5);
        await page.waitForTimeout(500);
    } catch { /* ignore */ }

    // If Cloudflare renders an interactive Turnstile iframe, try clicking the checkbox.
    try {
        const cfFrame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
        if (cfFrame) {
            log.info('Turnstile iframe detected, attempting checkbox interaction.');
            await cfFrame.waitForSelector('input[type="checkbox"]', { timeout: 5_000 }).catch(() => {});
            const checkbox = await cfFrame.$('input[type="checkbox"]');
            if (checkbox) {
                await checkbox.click();
                log.info('Clicked Turnstile checkbox.');
            }
        }
    } catch (e) {
        log.debug(`Turnstile interaction skipped: ${e.message}`);
    }

    try {
        await page.waitForFunction(
            () => !/just a moment|attention required|access denied/i.test(document.title),
            null,
            { timeout: 90_000 },
        );
        await page.waitForLoadState('domcontentloaded');
        log.info(`Cloudflare challenge resolved on ${page.url()}.`);
    } catch {
        session?.retire();
        throw new Error('Blocked by Cloudflare challenge, retrying with a new session.');
    }
}

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency,
    maxRequestRetries,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60,
    useSessionPool: true,
    persistCookiesPerSession: true, // keep the Cloudflare clearance cookie within a session
    sessionPoolOptions: {
        maxPoolSize: 50,
        // The Cloudflare challenge answers with 403 before resolving in the browser,
        // so we must not treat 403 as an immediate block. waitForChallenge handles it.
        blockedStatusCodes: [],
    },
    // Cloudflare blocks headless Chromium outright, and Crawlee's injected fingerprints
    // make the challenge fail even in headful mode. A plain headful browser passes.
    // On the Apify platform the Dockerfile starts XVFB, so headful mode works there too.
    headless: false,
    browserPoolOptions: {
        useFingerprints: false,
    },
    launchContext: {
        launcher: stealthChromium,
        launchOptions: {
            args: ['--ignore-certificate-errors', '--disable-blink-features=AutomationControlled'],
        },
    },

    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            // Hide automation fingerprints before any page script runs so Cloudflare
            // Turnstile resolves automatically. Patches: navigator.webdriver, CDP globals,
            // WebGL software-renderer string (Mesa/llvmpipe betrays XVFB on a server),
            // Permissions API inconsistency, and missing navigator.plugins (0 in headless).
            await page.addInitScript(() => {
                // navigator.webdriver
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
                // CDP cdc_* artefacts (rare with Playwright but cheap to clear)
                for (const key of Object.keys(window).filter((k) => k.startsWith('cdc_'))) {
                    try { delete window[key]; } catch { /* non-configurable */ }
                }
                // WebGL vendor/renderer: XVFB uses Mesa/llvmpipe; spoof real Intel hardware
                const _wp = (ctx) => {
                    const orig = ctx.prototype.getParameter;
                    ctx.prototype.getParameter = function (p) {
                        if (p === 37445) return 'Intel Inc.';
                        if (p === 37446) return 'Intel(R) Iris(TM) Plus Graphics 640';
                        return orig.call(this, p);
                    };
                };
                _wp(WebGLRenderingContext);
                if (typeof WebGL2RenderingContext !== 'undefined') _wp(WebGL2RenderingContext);
                // Permissions: avoid 'denied' for notifications (looks like sandboxed env)
                const _pq = navigator.permissions?.query?.bind(navigator.permissions);
                if (_pq) {
                    navigator.permissions.query = (p) =>
                        p?.name === 'notifications'
                            ? Promise.resolve({ state: Notification.permission, onchange: null })
                            : _pq(p);
                }
                // Plugins: headless Chrome has 0; real Chrome always has a few
                if (navigator.plugins.length === 0) {
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => Object.assign(
                            [{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                             { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                             { name: 'Native Client',     filename: 'internal-nacl-plugin' }],
                            { length: 3 }),
                    });
                    Object.defineProperty(navigator, 'mimeTypes', { get: () => ({ length: 2 }) });
                }
            });
            // Save bandwidth: reviews are in the HTML, images/fonts/media aren't needed.
            await playwrightUtils.blockRequests(page, {
                extraUrlPatterns: ['googletagmanager', 'doubleclick', 'hotjar', 'segment.io'],
            }).catch(() => {});
        },
    ],

    async requestHandler(context) {
        const { request, page, session } = context;
        await waitForChallenge(page, session);

        if (request.label === LABELS.SEARCH) return handleSearch(context);
        return handleReviews(context);
    },

    async failedRequestHandler({ request }, error) {
        log.error(`Request failed after ${request.retryCount + 1} attempts: ${request.url} (${error.message})`);
        await Actor.pushData({
            '#error': true,
            input: request.userData.input ?? null,
            url: request.url,
            errorMessage: error.message,
        });
    },
});

/** Resolves a plain product name to its Capterra reviews page via site search. */
async function handleSearch({ request, page, addRequests }) {
    const { query } = request.userData;
    await page.waitForSelector('a[href*="/p/"]', { timeout: 20_000 }).catch(() => {});

    const candidates = await page.$$eval('a[href*="/p/"]', (links) => links.map((a) => a.getAttribute('href')));
    const products = [];
    for (const href of candidates) {
        const match = href?.match(/\/p\/(\d+)\/([^/?#]+)/);
        if (match && !products.some((p) => p.productId === match[1])) {
            products.push({ productId: match[1], slug: match[2] });
        }
    }

    if (products.length === 0) {
        log.warning(`No Capterra product found for "${query}".`);
        return;
    }

    // Prefer an exact slug match (ignoring case and separators), else the top result.
    const normalize = (s) => decodeURIComponent(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const best = products.find((p) => normalize(p.slug) === normalize(query)) ?? products[0];
    log.info(`Resolved "${query}" to ${reviewsUrl(best.productId, best.slug, 1)}`);

    await addRequests([reviewsRequest({ ...best, page: 1, input: request.userData.input })]);
}

/** Extracts all reviews from one reviews page and enqueues the next page. */
async function handleReviews({ request, page, addRequests }) {
    const { productId, slug, page: pageNumber } = request.userData;
    const state = getProductState(productId);

    const title = await page.title();
    if (/doesn't exist|\(404\)/i.test(title)) {
        log.warning(`Product not found (404): ${request.url}`);
        return;
    }

    // Capterra only serves ~100 review pages; beyond that it redirects to page 1.
    const finalUrl = new URL(page.url());
    const servedPage = Number(finalUrl.searchParams.get('page') ?? 1);
    if (pageNumber > 1 && servedPage !== pageNumber) {
        log.info(`[${slug}] Page ${pageNumber} redirected to page ${servedPage}, Capterra exposes no more pages.`);
        return;
    }

    // Wait until either review cards or the empty-state content is present.
    await page
        .waitForSelector('[data-testid="Overall Rating-rating"], [data-testid="pagination-section"], h1', { timeout: 20_000 })
        .catch(() => {});

    const html = await page.content();
    const productInfo = extractProductInfo(html);
    const context = {
        productId,
        slug,
        page: pageNumber,
        productName: productInfo.productName ?? decodeURIComponent(slug).replace(/-/g, ' '),
    };

    let rawReviews = extractReviewsFromPayload(html);
    let dataSource = 'payload';
    if (!rawReviews) {
        rawReviews = await extractReviewsFromDom(page);
        dataSource = 'dom';
        if (rawReviews.length) log.warning(`[${slug}] Page payload not found, fell back to DOM parsing (fewer fields).`);
    }

    // No reviews and a title that isn't a reviews page is most likely a soft block: retry.
    if (rawReviews.length === 0 && !/reviews/i.test(title)) {
        throw new Error(`No reviews found on unexpected page "${title}", retrying.`);
    }

    // Normalise, de-duplicate and apply the per-product review limit.
    const items = [];
    for (const raw of rawReviews) {
        const item = { ...normalizeReview(raw, context), dataSource };
        // DOM fallback has no ID, so build a stable one from content.
        const dedupeKey = item.reviewId ?? `${item.reviewer.name}|${item.date}|${item.title}`;
        if (state.seenIds[dedupeKey]) continue;
        if (maxReviewsPerProduct > 0 && state.reviews + items.length >= maxReviewsPerProduct) break;
        state.seenIds[dedupeKey] = true;
        items.push(item);
    }

    state.reviews += items.length;
    state.pages += 1;
    if (items.length) await Actor.pushData(items);

    const total = productInfo.productReviewCount ? ` of ~${productInfo.productReviewCount}` : '';
    log.info(`[${slug}] Page ${pageNumber}: saved ${items.length} reviews (${state.reviews}${total} total).`);

    // ---- Pagination -------------------------------------------------------
    const reachedReviewLimit = maxReviewsPerProduct > 0 && state.reviews >= maxReviewsPerProduct;
    const reachedPageLimit = maxPagesPerProduct > 0 && state.pages >= maxPagesPerProduct;
    // A page whose reviews were all seen before means Capterra is recycling content.
    const noNewReviews = items.length === 0;

    if (reachedReviewLimit || reachedPageLimit || noNewReviews || rawReviews.length < REVIEWS_PER_PAGE) {
        log.info(`[${slug}] Finished with ${state.reviews} reviews over ${state.pages} pages.`);
        return;
    }

    // Follow the "next page" arrow in the pagination bar.
    const nextHref = await page
        .$eval('[data-testid="pagination-section"] a:has(i[aria-label="chevron-right"])', (a) => a.getAttribute('href'))
        .catch(() => null);

    if (!nextHref) {
        log.info(`[${slug}] No next page link, finished with ${state.reviews} reviews.`);
        return;
    }

    const nextPage = Number(new URL(nextHref, BASE_URL).searchParams.get('page'));
    if (!Number.isFinite(nextPage) || nextPage <= pageNumber) {
        log.info(`[${slug}] Next page link does not advance, finished with ${state.reviews} reviews.`);
        return;
    }

    await addRequests([reviewsRequest({ productId, slug, page: nextPage, input: request.userData.input })]);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const startRequests = rawProducts.map(toRequest).filter(Boolean);
log.info(`Starting with ${startRequests.length} product(s).`);

await crawler.run(startRequests);

const summary = Object.entries(productState).map(([id, s]) => `${id}: ${s.reviews} reviews / ${s.pages} pages`);
log.info(`Done. ${summary.join('; ') || 'No reviews scraped.'}`);

await Actor.exit();
// proxy: UNBLOCKER
