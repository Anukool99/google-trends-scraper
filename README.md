# Google Trends Scraper

Give this Actor a list of up to 20 keywords and it returns structured Google
Trends data for each one: **interest over time** (0–100) and **related queries**
(top and rising, with Google's "Breakout" flag). It is meant for marketers, SEO
specialists and analysts who want Trends data in a dataset (JSON, CSV, Excel)
instead of copying charts from trends.google.com by hand.

The Actor reads the same unofficial web endpoints that the Google Trends website
uses. It is not an official Google API, and Google can change those endpoints at
any time (see [Limitations](#limitations-and-data-caveats)).

## What data you get

| Section | Default | What it contains |
|---|---|---|
| Interest over time | always on | One point per hour, day or week (Google picks the step from the time range), each with a 0–100 interest value. The last point is flagged when its period isn't over yet. |
| Related queries | on | **Top** queries (relative interest 0–100) and **rising** queries (% growth, with `isBreakout: true` when Google shows "Breakout"). |
| Related topics | **off**, experimental | Google returned an empty topic list to this Actor in every test (24 of 24 test queries, 3 diagnostic requests and a local test run), although a browser shows topics for the same search. Turn it on if you want to check, but expect `status: "empty"`. |

Each keyword is looked up **on its own**, so its 0–100 values are scaled to that
keyword only. You can't compare two keywords' values with each other (more on
this [below](#limitations-and-data-caveats)).

## How to use

### In Apify Console

1. Open the Actor and enter your keywords (one per line).
2. Optionally set **Region** (e.g. `US`, `US-CA`, empty = worldwide) and **Time range**.
3. Leave **Proxy configuration** on Apify Proxy, group `RESIDENTIAL` (the prefilled value).
4. Click **Start**. Records appear in the **Output** / dataset tab, one per keyword.

### Example input

This is the input used for the measured cloud run below:

```json
{
    "keywords": ["coffee", "solar panels", "chatgpt"],
    "geo": "US",
    "timeRange": "today 12-m",
    "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

When you start the Actor through the API, `proxyConfiguration` is **not** filled
in for you. If you leave it out, the Actor runs without a proxy.

### From code (apify-client for JavaScript)

```js
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

const run = await client.actor('bytebee/google-trends-scraper').call({
    keywords: ['coffee', 'solar panels'],
    geo: 'US',
    timeRange: 'today 12-m',
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
const summary = await client.keyValueStore(run.defaultKeyValueStoreId).getRecord('OUTPUT');
```

## Input

| Field | Type | Default | Rules |
|---|---|---|---|
| `keywords` | string[] | — (required) | 1–20 keywords. Each one is trimmed and must be non-empty, ≤ 100 characters, and contain no control characters (e.g. an inner line break). Duplicates are removed case-insensitively, keeping the first spelling. |
| `geo` | string | `""` (worldwide) | Empty, a 2-letter country code (`US`) or a sub-region (`US-CA`). Trimmed and upper-cased. Pattern `^([A-Z]{2}(-[A-Z0-9]{1,3})?)?$`. |
| `timeRange` | string | `today 12-m` | One of `now 1-H`, `now 4-H`, `now 1-d`, `now 7-d`, `today 1-m`, `today 3-m`, `today 12-m`, `today 5-y`, `all` (case-sensitive), or a custom range `YYYY-MM-DD YYYY-MM-DD`. A custom range must use real calendar dates, start on or after `2004-01-01`, have start ≤ end, and end no later than today (UTC). |
| `category` | integer | `0` | Google Trends category ID, ≥ 0. `0` = all categories. |
| `language` | string | `en-US` | Language for labels and related queries. Pattern `^[a-z]{2,3}(-[A-Za-z]{2,4})?$`. |
| `includeRelatedQueries` | boolean | `true` | Collect top and rising related queries. |
| `includeRelatedTopics` | boolean | `false` | Experimental; usually `empty` (see above). |
| `maxRetries` | integer | `5` | 0–8. Retries per request after a 429, timeout, network error or 5xx. Waits grow from about 4 s up to 60 s. A request that stays blocked can take about 5 minutes at the default and about 10 minutes at 8. |
| `proxyConfiguration` | object | prefilled with Apify Proxy `RESIDENTIAL` in Console; none via API | Standard Apify proxy settings. If you ask for a proxy and none can be obtained, the run fails instead of continuing without one. |

Invalid input fails the run at once and lists every problem in one message
(e.g. `keywords[2]: contains control characters (e.g. a line break)`). Nothing
is requested from Google and no records are written.

## Output

The dataset has **one record per keyword**, in input order. This is a real record
from the cloud run (`coffee`, US, past 12 months), with long arrays trimmed:

```jsonc
{
    "keyword": "coffee",
    "geo": "US",
    "timeRange": "today 12-m",
    "category": 0,
    "status": "ok",
    "interestOverTime": {
        "status": "ok",
        "resolution": "week",
        "points": [
            { "date": "2025-10-19T00:00:00.000Z", "label": "Oct 19 – 25, 2025", "interest": 65, "isPartial": false },
            { "date": "2025-10-26T00:00:00.000Z", "label": "Oct 26 – Nov 1, 2025", "interest": 58, "isPartial": false },
            // … 50 more weekly points …
            { "date": "2026-10-18T00:00:00.000Z", "label": "Oct 18 – 24, 2026", "interest": 64, "isPartial": true }
        ]
    },
    "relatedQueries": {
        "status": "ok",
        "top": [
            { "query": "coffee near me", "value": 100, "formattedValue": "100", "link": "https://trends.google.com/trends/explore?q=coffee+near+me&date=today+12-m&geo=US", "isBreakout": false },
            { "query": "coffee shop", "value": 87, "formattedValue": "87", "link": "https://trends.google.com/trends/explore?q=coffee+shop&date=today+12-m&geo=US", "isBreakout": false }
            // … 23 more (25 in total) …
        ],
        "rising": [
            { "query": "top songs this week", "value": 5900, "formattedValue": "Breakout", "link": "https://trends.google.com/trends/explore?q=top+songs+this+week&date=today+12-m&geo=US", "isBreakout": true },
            // … entries omitted …
            { "query": "gardening ideas", "value": 4950, "formattedValue": "+4,950%", "link": "https://trends.google.com/trends/explore?q=gardening+ideas&date=today+12-m&geo=US", "isBreakout": false }
            // … 25 in total …
        ]
    },
    "relatedTopics": { "status": "skipped", "top": null, "rising": null },
    "scrapedAt": "2026-10-22T14:43:53.891Z"
}
```

Note the off-topic rising queries for "coffee". That is Google's own data; see
[Limitations](#limitations-and-data-caveats).

### Fields

| Field | Meaning |
|---|---|
| `keyword`, `geo`, `timeRange`, `category` | The query as it was sent (after trimming and deduplication). |
| `status` | Record status: `ok`, `partial` or `failed` (see below). |
| `interestOverTime.resolution` | Step between points as Google reports it, lower-cased (seen in tests: `hour` for `now 7-d`, `day` for a 6-month custom range, `week` for `today 12-m` and `today 5-y`). |
| `points[].date` | Start of the period as a UTC ISO datetime, taken from Google's epoch timestamp. |
| `points[].label` | Google's label for the period, with special spaces replaced by normal spaces. |
| `points[].interest` | 0–100 relative interest, or `null` when Google marks the point as having no data. No values are filled in or interpolated. |
| `points[].isPartial` | `true` only for a period that isn't finished yet (in tests, only ever the last point). |
| `relatedQueries.top[]` | `query`, `value` (relative interest 0–100), `formattedValue`, `link`, `isBreakout` (always `false` here). |
| `relatedQueries.rising[]` | `query`, `value` (% growth, e.g. `4950` = `+4,950%`), `formattedValue`, `link`, `isBreakout` (`true` when `formattedValue` is `"Breakout"`). |
| `link` | Link to that query on trends.google.com, or `null` if Google's link is missing or would point anywhere else. |
| `relatedTopics` | Same layout as related queries, with topic items `{mid, title, type, value, formattedValue, link, isBreakout}`. Google has never returned a topic item in testing, so this item layout is unverified. |
| `error` | Present on a failed section: `"<CODE>: <message>"`. |
| `scrapedAt` | When the record was finished (UTC ISO datetime). |

### Status values

**Section status** (`interestOverTime`, `relatedQueries`, `relatedTopics`):

| Status | Meaning | Lists |
|---|---|---|
| `ok` | Google returned data. | arrays |
| `empty` | Google answered, but with no data. This is a valid result, not an error. | `[]` (a timeline with no data keeps its all-`null` points) |
| `failed` | The request failed after retries; see `error`. | `null` |
| `skipped` | You turned the section off. | `null` |

**Record status:** skipped sections are ignored. `ok` = no section failed (all
`empty` still counts as `ok`). `failed` = every remaining section failed.
`partial` = some failed, some didn't.

**Error codes** in `error`:

| Code | Meaning |
|---|---|
| `RATE_LIMITED` | Google kept answering 429 after all retries. |
| `TOKEN_MISMATCH` | HTTP 401: Google rejected the request token. The Actor gets a fresh token once per keyword and retries before reporting this. |
| `HTTP_ERROR` | Another HTTP error (5xx after retries, or a non-retryable 4xx). |
| `NETWORK_ERROR` | Connection error or the 30 s per-request timeout, after retries. |
| `SOURCE_CHANGED` | Google's response didn't have the expected shape (e.g. not JSON, missing widget). The endpoints may have changed. |
| `ABORTED` | Not requested, because the run stopped after 3 failed keywords in a row. |
| `INTERNAL` | An unexpected error inside the Actor. |

### Run summary (`OUTPUT` in the key-value store)

Each run also saves a summary under the key `OUTPUT`. Its shape, with the counts
and duration from the cloud run below (timestamps are illustrative):

```json
{
    "keywords": 3,
    "ok": 3,
    "partial": 0,
    "failed": 0,
    "sections": {
        "interestOverTime": { "ok": 3, "empty": 0, "failed": 0, "skipped": 0 },
        "relatedQueries": { "ok": 3, "empty": 0, "failed": 0, "skipped": 0 },
        "relatedTopics": { "ok": 0, "empty": 0, "failed": 0, "skipped": 3 }
    },
    "aborted": false,
    "startedAt": "2026-10-22T14:43:43.700Z",
    "finishedAt": "2026-10-22T14:44:11.774Z",
    "durationMs": 28074
}
```

**Run outcome:** the run succeeds unless one of these happens:
- Every keyword failed: "All N keywords failed …".
- The circuit breaker stopped it: "Stopped early: 3 keywords in a row
  failed …". This happens even if earlier keywords have data.

Records for every keyword are written either way.

## Cost and performance

Measured on 2026-10-22. These are single runs, not averages, so treat them as
indications.

| Run | Keywords | Duration | Peak memory | Retries | Cost |
|---|---|---|---|---|---|
| Apify cloud, residential proxy, 256 MB | 3 (US, 12 months) | 28.1 s scraping, 31.0 s billed | 64 MB | 0 | **$0.00088** total (≈ $0.0003 per keyword): $0.00043 compute (0.00216 CU) + $0.00032 residential proxy (~40 KB) |
| Apify cloud, residential proxy, **4096 MB** | 20 (US, 12 months) | 219.2 s scraping, 221.3 s billed | 85 MB | 6 (on 3 keywords, all recovered) | **$0.0513** total: $0.0492 compute (0.246 CU at 4096 MB) + $0.0019 residential proxy (~0.24 MB). At 256 MB the compute part would be about 1/16 (estimated ≈ $0.005 total). |
| Local, no proxy | 3 | 29.3 s | 109 MB | 0 | — |
| Local, no proxy | 10 (worldwide, 5 years) | 96.0 s | 109 MB | 1 | — |

- Locally, a keyword took about 8–13 s (≈ 10 s on average), mostly because the
  Actor waits at least 3 s between requests and makes 3 requests per keyword
  (one more with related topics on).
- In the cloud, a 20-keyword run took 3 min 39 s (≈ 11 s per keyword), and all
  20 keywords came back `ok`.
- Peak memory never went above 109 MB, so **256 MB** (the default) is enough.
  Compute is billed by the memory you allocate, not by what is used, so a
  larger setting only costs more.
- Retries add time (up to about 5 minutes per blocked request at the default
  `maxRetries`) and therefore cost.
- Prices are from the Apify FREE plan at the time of the test. Apify pricing can
  change, and proxy traffic is billed separately from compute.

## Limitations and data caveats

- **Values aren't comparable across keywords.** Google scales each query so its
  own peak is 100. Because each keyword is queried separately, "coffee = 65" and
  "chatgpt = 100" in the same week say nothing about which one is searched more.
  This Actor does not put keywords on a shared scale.
- **The last point is usually partial** (`isPartial: true`): that period isn't
  over yet, so its value may change.
- **Rising queries are Google's raw data and can be off-topic.** For example, the
  US 12-month rising list for "coffee" included "home workout routines" and "top
  songs this week". We checked trends.google.com in a browser for the same search,
  and it showed the same list in the same order. The Actor returns what Google
  returns, without filtering.
- **Related topics are usually empty** for automated clients (see above).
- **A term with almost no searches can show one isolated 100.** In a test with a
  made-up term over 5 years, 1 of 262 points had data (interest 100) and the
  rest were `null`, so the timeline was `ok`. Check how many points are non-null
  before treating a spike as real.
- **Rate limiting.** Google answers automated traffic with HTTP 429. In the first
  test from a home IP, 27 of 106 requests got 429, all of them in the first
  ~7.5 minutes, and one section still failed after all retries. Later runs saw
  0–1 429s. The Actor retries with growing waits, and if 3
  keywords in a row fail it stops requesting and marks the rest `ABORTED`.
  A 20-keyword cloud run on residential proxies saw 6 retries on 3 keywords,
  and all of them recovered.
- **One keyword at a time.** There is no parallelism, by design, to stay under
  Google's rate limits. The run uses one proxy session that doesn't rotate.
- **Unofficial endpoints.** If Google changes them, sections fail with
  `SOURCE_CHANGED` until the Actor is updated.
- **Residential proxy is recommended.** Datacenter proxies and no proxy on Apify
  have not been tested.
- **Not included:** interest by region, real-time trending searches, YouTube /
  News / Shopping search, and comparing keywords on one chart.

## FAQ

**Why don't my numbers match a comparison chart on trends.google.com?**
When you compare several terms on the website, Google scales them together. This
Actor queries each keyword alone, so each one has its own 0–100 scale.

**What does "Breakout" mean?**
Google shows "Breakout" for a rising query whose growth is very large. The Actor
keeps Google's text in `formattedValue`, the number in `value`, and sets
`isBreakout: true`.

**A keyword came back `partial` or `failed`. What should I do?**
Look at the `error` field on the failed section. `RATE_LIMITED` usually means
Google was throttling: run that keyword again later, with a residential proxy.
`SOURCE_CHANGED` means the response format changed; please report it.

**Why is `relatedTopics` empty?**
Google returns topics to browsers but, in every test so far, not to this Actor.
It's off by default for that reason.

**Can I get more than 20 keywords?**
Not in one run. Split the list across several runs. Values from different runs
aren't on the same scale either.

## Local development

Requires Node.js 22.12 or later.

```bash
npm ci
npm run build       # compile to dist/
npm test            # vitest: 452 tests, using mocks and recorded fixtures (no network)
npm run lint
npm run typecheck
npm run start:dev   # run src/main.ts with tsx against local Apify storage
```

`scripts/smoke.ts` runs the built Actor against real Google Trends (it uses the
network, no proxy) and prints timings and per-section results:

```bash
npm run build
npx tsx scripts/smoke.ts coffee "solar panels" chatgpt --geo US --time "today 12-m"
# options: --geo= (worldwide), --topics, --no-queries, --max-retries N
```

Recorded Google responses used by the tests are in `test/fixtures/`.
