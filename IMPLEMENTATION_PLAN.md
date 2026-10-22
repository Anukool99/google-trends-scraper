# Google Trends Scraper — Implementation Plan

Status: draft for approval · 2026-10-22

**Value proposition:** Give the Actor a list of keywords and get back clean,
structured Google Trends data for each one: interest over time, plus related
queries and topics when Google returns them.

---

## 1. Data-source findings (probe run 2026-10-22, local residential IP)

Probe script: unofficial endpoints `trends/api/explore` → `widgetdata/multiline`
and `widgetdata/relatedsearches`, one keyword (`coffee`, `US`, `today 12-m`).

| Observation | Evidence | Consequence for design |
|---|---|---|
| First `explore` call always returns 429 and sets an `NID` cookie; the retry with the cookie succeeds | `429 → 200` on both runs | Client must keep a cookie jar and treat the first 429 as a "session warm-up", not a failure |
| `explore` returns 4 widgets with per-widget tokens | `TIMESERIES, GEO_MAP, RELATED_TOPICS, RELATED_QUERIES` | Two-step flow: explore, then fetch each widget with its token |
| `multiline` was rate-limited hard: 429 ×3, then 200 after ~14 s of backoff | 53 weekly points, `{time, formattedTime, value[], hasData[]}` | Bounded exponential backoff with jitter is required; concurrency must be very low |
| `RELATED_TOPICS` returned `{"rankedList":[]}` (HTTP 200) | 35-byte body | An empty result is valid. Report it as `empty`, not `failed` |
| `RELATED_QUERIES` got 429 on all 4 attempts | 4 × 429 | Some widgets fail even when others succeed, so status must be tracked per section |
| Responses are prefixed with the XSSI guard `)]}',` | all JSON bodies | Strip the prefix before `JSON.parse` |

### 1a. Part 0 measurement matrix (MEASURED, 2026-10-22 13:01–13:14 UTC, residential IP in India, no proxy)

Setup: 5 keywords (coffee, chatgpt, solar panels, zxqvbnm-nonexistent-term,
taylor swift) × geo (`""`, `US`) × time (`today 12-m`, `now 7-d`) = 20 combos,
plus 4 extras: custom range `2024-01-01 2024-06-30`, `US-CA`, category 71, and
`tz=300`. Requests ran one at a time with a ≥3 s gap. 429s got backoff of
4/8/16/32/64 s ×(0.75–1.25) jitter, max 5 retries, and the cookie jar was shared
across combos. Total: 122 requests in 708 s, with no sustained blocking and no
CAPTCHA/`sorry` page. Raw CSV and scripts are in the session scratchpad (not
committed). Fixtures are in `test/fixtures/` (see its README).

| Section (20 core combos) | ok | empty | failed | 429s / attempts | median latency | max latency |
|---|---|---|---|---|---|---|
| explore | 20 | 0 | 0 | 1 / 21 | 115 ms | 1085 ms |
| timeseries (multiline) | 18 | 2 (nonexistent term, 12-m) | 0 | 10 / 30 | 274 ms | 7547 ms |
| relatedQueries | 15 | 4 (nonexistent term) | 1 (429 ×6) | 16 / 35 | 1744 ms | 9040 ms |
| relatedTopics | 0 | **20** | 0 | 0 / 20 | 122 ms | 380 ms |

Latency is the sum of HTTP round-trips only, with backoff sleeps excluded. Overall
429 rate: 27/106 requests (25.5%). **All 27 were in the first 5 combos (first ~7.5
min)**, and the next 19 combos had zero 429s. Wall time per keyword: 75–180 s
during that early phase, and ~13 s in steady state, where the 3 s gap dominates.
The single failure (coffee/US/now 7-d related queries) used up all 5 retries. In
another case, timeseries succeeded only on the 6th attempt after a 54 s backoff.

Shape findings (measured, fixtures saved):
- **RELATED_TOPICS returned `{"default":{"rankedList":[]}}` on every call**: 24/24
  matrix runs, plus 3 diagnostics with browser-like headers, entity keyword
  `/m/02vqfm`, and `hl=en`. Every widget request carries
  `"userConfig":{"userType":"USER_TYPE_SCRAPER"}`, so Google is classifying the
  client. Editing that field breaks the token (HTTP 401). Topic entry shape
  (`mid/title/type`) was **never observed**. Assumed only: real browsers still get
  topics.
- Related queries: `rankedList[0]` = top and `[1]` = rising. Top entry:
  `{query, value, formattedValue, hasData:true, link}`. Rising entry:
  `{query, value, formattedValue, link}` (**no `hasData`**). Rising `value` is a
  percentage increase (`2450` ↔ `"+2,450%"`). `formattedValue:"Breakout"` was
  seen in 10 of 19 ok results (all 24 combos), up to 14 of 25 rising entries, with large
  `value` (e.g. 91000). An empty result has **two** empty lists. Empty topics have
  **zero** lists.
- Timeseries points: `{time (unix s, string), formattedTime, formattedAxisTime,
  value:[n], hasData:[bool], formattedValue:[s]}`. `isPartial:true` appears **only
  on the last point**; on all other points the key is absent rather than false.
  Resolution follows the range: 12-m → 53 × WEEK, now 7-d → 169 × HOUR, a
  6-month custom range → 182 × DAY (no partial).
- `tz` (minutes, like JS `getTimezoneOffset`) changes only the formatted strings:
  `tz=300` gives `8:00 AM` where `tz=0` gives `1:00 PM`, with the same `time`
  epoch. Hourly `formattedTime` = `Oct 15, 2026 at 1:00 PM` (U+202F before AM/PM).
  Weekly labels use U+2009 thin spaces around the en dash.
- Nonexistent term: explore still returns all 4 widgets. The 12-m timeseries is
  `timelineData: []`. The 7-d timeseries has 169 points, 167 with `hasData:[false]`
  and `value:[0]`, plus 2 noise points that do have data (100, 79).
- `US-CA` works (`geo: {region: "US-CA"}`), as do the custom date range and
  category 71 (different related queries, same 53-point series).
- 429 bodies: the explore 429 says "Too Many Requests". **Widget 429s say
  "Error 429 (Bad Request) … malformed. It should not be retried"**, but
  retrying worked. HTTP 401 with the same "malformed" text = token/request
  mismatch.

**Assessments (not yet tested):**
- Apify datacenter IPs are likely blocked harder than a home IP. We will
  probably need Apify **residential proxy**, which costs money. Measure this
  in Part 6 before quoting a price.
- Throughput was measured from one home IP only (~13 s/keyword in steady state,
  75–180 s during early 429 bursts). It is not yet known for proxies or Apify.
- The endpoints are unofficial and can change without notice. Fixtures and the
  smoke test detect breakage.

### 1b. Plan changes suggested (from Part 0; other sections NOT edited)
1. **Related topics**: expect `empty` almost always from this client. Either
   leave `includeRelatedTopics` off by default or keep it on with a README
   caveat. Check in a real browser before promising topics. §4 cannot yet
   specify the topic entry fields.
2. **Retry classifier (§6 Part 3)**: classify by HTTP status only. A 429 is
   retryable even when its body says "should not be retried". A 401 means the
   token doesn't match the request: don't retry it as is, at most re-run explore
   once.
3. **Pacing (§5)**: use a ≥3 s gap (measured clean in steady state) instead of
   1.5 s. Default `maxRetries` 4 → 5. One section needed 5 retries (~110 s of
   backoff) during early 429 bursts, and one failed even after 5.
4. **Output schema (§4)**: build `date` from `time` (epoch, UTC), not
   `formattedTime`. Use full ISO datetime for HOUR resolution.
   `isPartial` = `point.isPartial === true`. Add `resolution` values
   `hour|day|week|month`. Rising items should keep `formattedValue` and add a
   flag such as `isBreakout`, since `value` means % growth for rising and
   relative interest for top. The normalizer must accept a `rankedList` of length 0 or 2.
5. A nonexistent term can return noisy non-null points (hourly), so
   "no data" cannot be detected reliably. Report what Google returns.

## 2. MVP scope

**In:** batch of keywords (each queried separately), geo, time range, category,
interest over time, related queries (top and rising), status for each keyword
and each section, retries, proxy support, unit tests, a smoke test, README.
Related topics are **experimental and off by default**, because Part 0 got
them empty 23 times out of 23 (§1b.1).

**Out (for now):** comparing keywords on one shared scale (that's Actor #4,
"Batch Comparison"), interest by region (`GEO_MAP`), real-time trending
searches, YouTube/News/Shopping properties, scheduling.

> Each keyword is queried on its own, so its 0–100 values are scaled to that
> keyword only. Values are **not comparable across keywords**. The README will
> say this clearly.

## 3. Input schema (draft)

| Field | Type | Default | Validation |
|---|---|---|---|
| `keywords` | string[] | — (required) | 1–20 items, trimmed, non-empty, ≤100 chars, deduplicated |
| `geo` | string | `""` (worldwide) | `""` or ISO-3166 code / sub-region (`US`, `US-CA`) |
| `timeRange` | enum or string | `today 12-m` | `now 1-H`, `now 4-H`, `now 1-d`, `now 7-d`, `today 1-m`, `today 3-m`, `today 12-m`, `today 5-y`, `all`, or `YYYY-MM-DD YYYY-MM-DD` (start ≤ end, ≥ 2004-01-01) |
| `category` | integer | `0` | ≥ 0 |
| `language` | string | `en-US` | BCP-47-like |
| `includeRelatedQueries` | boolean | `true` | — |
| `includeRelatedTopics` | boolean | `false` | Experimental; usually empty (§1b.1) |
| `maxRetries` | integer | `5` | 0–8 |
| `proxyConfiguration` | object | Apify proxy, residential | Apify proxy editor |

Input errors fail the run immediately with a clear message, and nothing is
retried.

#### Validation rules (exact spec for Part 2: `parseInput(raw, now?)` in `src/input.ts`)

`parseInput(raw: unknown, now: Date = new Date())` returns a fully-defaulted
`ValidatedInput` or throws `InputError`. Rules:

- **All problems at once.** `InputError` lists every problem in one message,
  and `error.issues` is a `string[]` with one entry per problem. Each issue
  starts with the field path, e.g. `keywords[2]: …`.
- **Missing values.** `raw` that is `null`, `undefined` or not a plain object
  gives an `InputError` saying `keywords` is required. A field that is
  `undefined` or `null` gets its default. Unknown fields are ignored.
- **`keywords`:**
  - Must be an array of strings; any non-string item is an issue.
  - Each item is trimmed. An item that is empty after trimming is an issue.
  - An item longer than 100 characters (after trimming) is an issue.
  - Duplicates are removed **case-insensitively**, keeping the first
    occurrence and its original casing.
  - After deduplication the count must be 1–20. More than 20 is always
    reported, even alongside item issues. Fewer than 1 is reported only when
    no item has an issue, because fixing an item could resolve it.
- **`geo`:** a string. It is trimmed and upper-cased, then must match
  `^([A-Z]{2}(-[A-Z0-9]{1,3})?)?$`. `""` means worldwide.
- **`timeRange`:** a string, trimmed. It must be one of the presets
  (case-sensitive) or `YYYY-MM-DD YYYY-MM-DD`. For a custom range:
  - Both dates must be real calendar dates (`2024-02-30` is invalid).
  - The start must be ≥ `2004-01-01` and ≤ the end.
  - The end must be ≤ `now` (compared as UTC dates).
- **`category`:** an integer ≥ 0. Floats, negatives and strings are issues.
- **`language`:** a string matching `^[a-z]{2,3}(-[A-Za-z]{2,4})?$`.
- **`includeRelatedQueries`, `includeRelatedTopics`:** must be booleans.
  `"true"` and other strings are issues.
- **`maxRetries`:** an integer from 0 to 8.
- **`proxyConfiguration`:** optional. If present it must be a plain object,
  which is passed through unchanged. It is `undefined` when absent.

## 4. Output schema (draft: one dataset record per keyword)

```json
{
  "keyword": "coffee",
  "geo": "US",
  "timeRange": "today 12-m",
  "category": 0,
  "status": "ok",                       // ok | partial | failed
  "interestOverTime": {
    "status": "ok",                     // ok | empty | failed | skipped
    "resolution": "week",               // hour | day | week | month
    "points": [
      { "date": "2025-10-19T00:00:00.000Z", "label": "Oct 19 – 25, 2025", "interest": 65, "isPartial": false }
    ]
  },
  "relatedQueries": {
    "status": "ok",
    "top":    [ { "query": "coffee shop", "value": 100, "formattedValue": "100" } ],
    "rising": [ { "query": "coffee tariffs", "value": 4250, "formattedValue": "Breakout", "isBreakout": true } ]
  },
  "relatedTopics":  { "status": "skipped", "top": null, "rising": null },
  "scrapedAt": "2026-10-22T10:00:00.000Z"
}
```

Rules:
- **No invented values.** `hasData:false` becomes `interest: null`.
- **Failed vs empty.** A section that failed has `null` lists plus an `error`.
  A section that came back empty has `[]`.
- **Dates.** `date` comes from the epoch `time` field as a UTC ISO datetime,
  not from `formattedTime`. `isPartial` is `point.isPartial === true`.
- **Values.** `top` values are relative interest (0–100). `rising` values are
  % growth, and `isBreakout` marks `formattedValue === "Breakout"`.
- **Shapes.** The normalizer accepts a `rankedList` of length 0 or 2.
- **Summary.** A run summary (counts and duration) goes to the key-value store
  as `OUTPUT`.

**Decided (2026-10-22):** one record per keyword. A flat "one row per date"
option may come later.

## 5. Architecture

```
src/
  main.ts            Actor entry: read input → run queue → push data → summary
  input.ts           validation + defaults (pure)
  trends/
    client.ts        HTTP: cookie jar, proxy, XSSI strip, explore + widget calls
    retry.ts         bounded exp. backoff + jitter, retryable-error classifier
    errors.ts        typed errors: InputError, RateLimitedError, SourceChangedError…
  normalize.ts       raw widget JSON → output schema (pure)
  types.ts
test/
  fixtures/          recorded real responses (explore, multiline, relatedsearches, empty, 429 html)
  *.test.ts          vitest
scripts/smoke.ts     real-data smoke test (3 keywords), prints timings + success rate
.actor/              actor.json, input_schema.json, dataset_schema.json
Dockerfile, package.json, tsconfig.json, README.md
```

Stack: Node 22+, TypeScript, `apify` SDK v3, built-in `fetch` with
`undici` ProxyAgent for proxies, `vitest`. No browser, so memory and cost
stay low. Concurrency is fixed at 1 keyword at a time with a ≥3 s delay
between requests (measured clean in Part 0). That can be raised only after measurement.

## 6. Parts, test gates, and agent responsibilities

Each part ends at a **gate**. We move to the next part only after the gate
passes and the results are reported to you, with the exact commands and
output.

| Part | Deliverable | Owner agent | Agent's responsibility | Reviewer | Test gate (must pass) |
|---|---|---|---|---|---|
| **0. Source spike** | Findings table (§1) + recorded fixtures | **Source Researcher** (general-purpose) | Probe 5 keywords × 2 geos × 2 time ranges; record raw responses as fixtures; measure 429 rate and latency | Lead | Fixtures saved for: ok timeseries, ok related, empty related, 429 HTML. Findings written down |
| **1. Scaffold** | package.json, tsconfig, `.actor/*`, Dockerfile, lint, vitest | **Builder** (main session) | Project skeleton only, no scraping logic | Lead | `npm ci`, `npm run build`, `npm test` (placeholder test), `npm run lint` all succeed |
| **2. Input validation** | `src/input.ts` + tests | **Builder** | Defaults, limits, dedupe, custom-date parsing, clear error messages | **Test Engineer** | ≥15 unit cases: valid, each invalid field, boundaries (0/20/21 keywords), custom range errors |
| **3. Trends client + retry** | `src/trends/*` + tests | **Builder** | Cookie warm-up, two-step flow, XSSI strip, retry classifier by HTTP status only (retry 429/5xx/network even if the body says not to; no retry 400/401/parse; 401 → `TokenMismatchError`, and re-running explore once is Part 5's job because it needs the query), backoff with jitter and cap | **Test Engineer** | Mocked-fetch tests: 429→cookie→200; 429×N → `RateLimitedError` after exactly `maxRetries`; 400 not retried; malformed JSON → `SourceChangedError`; fake timers check the backoff delays |
| **4. Normalization** | `src/normalize.ts` + tests | **Builder** | Fixture → schema mapping; `hasData:false`→null; partial points; empty vs failed sections | **Test Engineer** | Fixture snapshot tests; output matches `dataset_schema.json` (schema-validated in the test) |
| **5. Orchestration** | `src/main.ts` | **Builder** | Sequential queue, per-keyword isolation (one failure doesn't stop the run), `status` rollup, `OUTPUT` summary, logs that leak no secrets | **Code Reviewer** (feature-dev:code-reviewer) | Integration test with mocked client: 3 keywords (ok / partial / failed) → 3 records with the right statuses; run exits 0. Invalid input exits non-zero |
| **6. Real-data verification** | `scripts/smoke.ts` + measured numbers | **Test Engineer** | Run locally on 3 keywords, inspect the output by hand, record duration, success rate per section and memory use | Lead + **you** | Smoke run produces schema-valid records; the numbers are recorded. **Apify cloud run (proxy cost) only with your approval** |
| **7. Audit** | Findings list + fixes | **Code Reviewer** + **Security Reviewer** (`/security-review`) | Retries are bounded, concurrency is bounded, no secrets in the repo or logs, `.gitignore` is complete, error paths are visible | Lead | No unresolved high-severity findings; `git ls-files` shows only intended files |
| **8. Docs & listing** | README, listing text, pricing notes | **Docs Writer** (general-purpose) | Input and output examples taken from real smoke output, limitations (§1, the cross-keyword scale caveat), measured cost per keyword | Lead + **you** | Every claim in the README traces to a test or a measurement; the definition-of-done checklist is ticked |
| **9. Release** | Push + Apify publish | **Lead** | Final checklist, commit, push | **you** | **Publishing requires your explicit approval** |

### Part 3 contract (`src/trends/*`, exact spec for tests)

**`errors.ts`**

- All errors extend `TrendsError` with these fields:
  - `code`: `RATE_LIMITED`, `TOKEN_MISMATCH`, `HTTP_ERROR`, `NETWORK_ERROR` or
    `SOURCE_CHANGED`
  - `retryable`
  - `attempts`, which defaults to 1
- `httpError(status, endpoint)` returns:
  - 429 → `RateLimitedError`, retryable
  - 401 → `TokenMismatchError`, not retryable
  - ≥500 → `HttpStatusError`, retryable
  - any other non-200 → `HttpStatusError`, not retryable
- Each error carries its `status`. Classification uses the status code only,
  never the body text.
- `NetworkError` is retryable. `SourceChangedError` is not.

**`retry.ts`**

- `backoffDelay(retry, base, max, random)` =
  `round(min(max, base·2^(retry−1)) · (0.5 + random()·0.5))`.
- `withRetry(fn, {maxRetries, baseDelayMs, maxDelayMs, sleep, random, onRetry})`
  calls `fn` at most `maxRetries + 1` times.
  - It retries only `TrendsError`s whose `retryable` is true. Anything else,
    including plain `Error`s, is thrown at once with no retry.
  - Before each retry it calls `onRetry({attempt, delayMs, error})`, then
    `sleep(delayMs)`.
  - The error finally thrown has `attempts` = the number of calls made.

**`client.ts`: `new TrendsClient({language, maxRetries, fetch, sleep, random, now, minRequestIntervalMs=3000, baseDelayMs=4000, maxDelayMs=60000, proxyUrl?, onRetry?})`**

- **Requests.**
  - Every request is a GET to `https://trends.google.com/trends/api/<endpoint>`
    with query params `hl=<language>`, `tz=0` and `req=<json>`, plus `token`
    for widget calls.
  - Headers include `User-Agent` and `Accept-Language`.
- **Pacing.** The start of each HTTP request is at least
  `minRequestIntervalMs` after the previous one's start, measured with `now()`
  and waited out with `sleep()`.
- **Cookies.**
  - `Set-Cookie` values, taken via `response.headers.getSetCookie()`, are
    stored by name. Later values overwrite earlier ones.
  - They are sent back as `Cookie: a=1; b=2` on every later request.
- **`explore({keyword, geo, timeRange, category})`.**
  - `req` = `{"comparisonItem":[{"keyword","geo","time":timeRange}],"category","property":""}`.
  - Returns `{timeseries?, relatedQueries?, relatedTopics?}`, each
    `{id, request, token}`, mapped from widget ids `TIMESERIES`,
    `RELATED_QUERIES` and `RELATED_TOPICS`. Other widgets such as `GEO_MAP`
    are ignored, and a missing widget is left `undefined`.
  - **Warm-up.** If the session had no cookies, the response is 429 and that
    response set a cookie, the request is repeated once at once (still
    paced). That repeat does not use up a retry.
  - A body without a `widgets` array → `SourceChangedError`.
  - A known widget without `token` or `request` → `SourceChangedError`.
- **`interestOverTime(widget)`** calls `widgetdata/multiline`, and
  **`relatedSearches(widget)`** calls `widgetdata/relatedsearches`.
  - Both send `req = JSON.stringify(widget.request)` and `token`.
  - Both return the parsed `default` object.
  - A missing or non-object `default` → `SourceChangedError`.
- **Parsing.**
  - The `)]}'` / `)]}',` first line is stripped before `JSON.parse`. A body
    without the prefix is parsed as is.
  - A body that is not JSON → `SourceChangedError`, which is not retried.
- **Errors.** Non-200 statuses go through `httpError`. A thrown `fetch`
  becomes `NetworkError`. Both are retried per `withRetry`.
- **Security.** Neither the proxy URL nor its password appears in error
  messages. The password is checked raw and percent-decoded, including when it
  appears outside the URL.
- **Clarifications** (raised by the Part 3 tests):
  - `status` lives on `HttpStatusError` and its subclasses, not on the base
    `TrendsError`.
  - `onRetry`'s `attempt` is the number of the call that just failed, so the
    first retry reports `attempt: 1`.
  - The warm-up repeat happens inside one retry attempt, so it is not counted
    in `attempts`.

### Agent roster

| Agent | Implemented as | Owns | Must not |
|---|---|---|---|
| **Lead** | Main Claude Code session | Plan, sequencing, gates, reporting to you, commits | Skip a gate or report something as working without test evidence |
| **Source Researcher** | `general-purpose` subagent | Endpoint behaviour, fixtures, rate-limit measurements | Write production code |
| **Builder** | Main session (keeps context between parts) | All `src/` code and config | Mark its own work as tested. That's the Test Engineer's job |
| **Test Engineer** | `general-purpose` subagent, fresh context | Writes and extends tests from the *spec* (§3–4), not from the code; runs the smoke test | Change `src/` to make a test pass. It reports failures to the Lead instead |
| **Code Reviewer** | `feature-dev:code-reviewer` subagent / `/code-review` | Correctness, error handling, concurrency, retry bounds | Make edits. It reports findings only |
| **Security Reviewer** | `/security-review` | Secrets, proxy credentials in logs, committed files | — |
| **Docs Writer** | `general-purpose` subagent | README and listing, based on measured results | Claim any speed, accuracy or scale that wasn't measured |
| **You** | — | Approve the schema (§4 open decision), approve proxy spend, approve publishing | — |

**Why split it this way:** a separate Test Engineer that writes tests from the
spec catches cases where the code and the tests share the same wrong
assumption. Reviewers that report but don't edit keep the changes
attributable. Subagents start with no context and cost tokens each time, so
only independent checks are delegated. Building stays in one session.

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Rate limiting / IP blocks on Apify | High | Residential proxy, session rotation on repeated 429, low concurrency. Measured in Part 6 |
| Endpoint or response shape changes | Medium | Typed `SourceChangedError`, fixture tests, a smoke test to re-run before each release |
| Proxy cost makes pricing uneconomic | Medium | Measure cost per keyword in Part 6 before setting a price |
| Users compare values across keywords | Medium | README caveat; point them to the future Comparison Actor |
| Terms-of-service exposure | — | Public, non-personal aggregate data; you should review Google's ToS before publishing |

## 8. Decisions (approved 2026-10-22)

1. Output shape: one record per keyword.
2. Keyword limit per run: 20.
3. Agent split as in §6.
4. Part 0 changes in §1b applied to §2–§6. Related topics are experimental and
   off by default.

**Cost gate:** nothing before Part 6 runs on Apify. Before any cloud run,
confirm whether the free plan includes residential proxy and get approval.
