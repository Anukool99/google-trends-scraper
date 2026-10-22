# Test fixtures

Raw response bodies from the unofficial Google Trends endpoints, saved byte-for-byte
as received (including the `)]}',` XSSI prefix line on JSON bodies). Captured
2026-10-22 from a residential IP in India, no proxy, by the Part 0 source spike.

No cookies or request headers are stored. The bodies contain only public
aggregate data. Two things to know about them:
- `explore-ok.txt` contains per-widget `token`s, which are short-lived and bound to the
  exact widget `request`.
- Widget requests embed `"userCountryCode":"IN"` (the requester's country, as
  Google inferred it) and `"userConfig":{"userType":"USER_TYPE_SCRAPER"}`.

Common params: `hl=en-US`, `tz=0`, `category=0`, `property=""`, unless stated otherwise.
Explore `req` = `{"comparisonItem":[{"keyword":K,"geo":G,"time":T}],"category":0,"property":""}`.
Widget calls use `req=<widget.request>&token=<widget.token>` taken from the explore response.

| File | Endpoint | K / G / T | What it represents |
|---|---|---|---|
| `explore-ok.txt` | `api/explore` | coffee / US / today 12-m | 200, 4 widgets: TIMESERIES, GEO_MAP, RELATED_TOPICS, RELATED_QUERIES |
| `multiline-weekly-ok.txt` | `api/widgetdata/multiline` | coffee / US / today 12-m | 53 weekly points (`resolution: WEEK`). Only the last point has `isPartial: true`; on the others the key is absent |
| `multiline-hourly-ok.txt` | `api/widgetdata/multiline` | coffee / US / now 7-d | 169 hourly points (`HOUR`). `formattedTime` looks like `Oct 15, 2026 at 1:00 PM`, where the space before AM/PM is U+202F. Last point `isPartial: true` |
| `multiline-daily-custom-range-ok.txt` | `api/widgetdata/multiline` | coffee / US / 2024-01-01 2024-06-30 | 182 daily points (`DAY`). Past range, so no `isPartial` |
| `multiline-nonexistent-empty.txt` | `api/widgetdata/multiline` | zxqvbnm-nonexistent-term / "" / today 12-m | 200 with `{"default":{"timelineData":[],"averages":[]}}`. Explore still returned all 4 widgets |
| `multiline-nonexistent-hourly-nodata.txt` | `api/widgetdata/multiline` | zxqvbnm-nonexistent-term / "" / now 7-d | 169 points: 167 have `hasData:[false]` with `value:[0]`, and 2 noise points have data (100 and 79) |
| `relatedsearches-queries-ok.txt` | `api/widgetdata/relatedsearches` (RELATED_QUERIES) | taylor swift / US / today 12-m | `rankedList[0]` = top (25), `rankedList[1]` = rising (25, 14 of them `formattedValue: "Breakout"`) |
| `relatedsearches-queries-empty-lists.txt` | `api/widgetdata/relatedsearches` (RELATED_QUERIES) | zxqvbnm-nonexistent-term / "" / today 12-m | `rankedList` has 2 entries, both `rankedKeyword: []` |
| `relatedsearches-empty.txt` | `api/widgetdata/relatedsearches` (RELATED_TOPICS) | coffee / US / today 12-m | `{"default":{"rankedList":[]}}` (35 bytes). RELATED_TOPICS returned this on every call (see below) |
| `rate-limited-429.html` | `api/explore` | coffee / "" / today 12-m | HTTP 429 `Error 429 (Too Many Requests)`, from the first request of a fresh session (it sets the `NID` cookie) |
| `rate-limited-429-widget.html` | `api/widgetdata/multiline` | coffee / "" / today 12-m | HTTP 429 whose HTML says `Error 429 (Bad Request)` / "malformed. It should not be retried". This text is misleading: retrying after backoff succeeded. Classify by status code, not by body text |
| `token-mismatch-401.html` | `api/widgetdata/relatedsearches` | coffee / US / today 12-m, with `userConfig.userType` edited | HTTP 401: the token is bound to the exact `request` JSON. Not retryable |

**Not captured:** `relatedsearches-topics-ok.txt`. RELATED_TOPICS returned
`rankedList: []` in 24/24 matrix runs and 3/3 diagnostic runs (browser-like headers,
`/m/02vqfm` entity keyword, `hl=en`). No non-empty topics body could be obtained.

Entry shapes observed:
- Top query: `{query, value, formattedValue, hasData: true, link}`.
- Rising query: `{query, value, formattedValue, link}` with no `hasData`. `value` is the
  percentage increase, e.g. `2450` ↔ `"+2,450%"`. `"Breakout"` entries carry a
  large `value` (e.g. `91000`).
- Topic entries (`{topic:{mid,title,type}, ...}`) were never observed.
