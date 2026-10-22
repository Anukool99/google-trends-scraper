// Tests written from IMPLEMENTATION_PLAN.md §6 "Part 3 contract" (client.ts), not from the implementation.
// No real network: fetch, sleep, random and the clock are all fakes (see helpers/fake-fetch.ts).
import { describe, expect, it, vi } from 'vitest';
import {
    HttpStatusError,
    NetworkError,
    RateLimitedError,
    SourceChangedError,
    TokenMismatchError,
    TrendsError,
} from '../src/trends/errors.js';
import { TrendsClient, parseXssi } from '../src/trends/client.js';
import { type Harness, fixture, fixtureJson, header, makeHarness, ok } from './helpers/fake-fetch.js';

const BASE = 'https://trends.google.com/trends/api/';
const QUERY = { keyword: 'coffee', geo: 'US', timeRange: 'today 12-m', category: 0 };

interface Widget {
    id: string;
    request: unknown;
    token: string;
}
const EXPLORE = fixtureJson('explore-ok.txt') as { widgets: (Widget & Record<string, unknown>)[] };
const widget = (id: string): Widget => {
    const w = EXPLORE.widgets.find((x) => x.id === id);
    if (!w) throw new Error(`fixture has no ${id}`);
    return { id: w.id, request: w.request, token: w.token };
};

/** Builds an explore body (with XSSI prefix) from the fixture, after an edit. */
const exploreBody = (edit: (data: { widgets: Record<string, unknown>[] }) => void): string => {
    const data = structuredClone(EXPLORE) as unknown as { widgets: Record<string, unknown>[] };
    edit(data);
    return `)]}'\n${JSON.stringify(data)}`;
};

function client(h: Harness, extra: Partial<ConstructorParameters<typeof TrendsClient>[0]> = {}) {
    return new TrendsClient({
        language: 'en-US',
        maxRetries: 5,
        fetch: h.fetch,
        sleep: h.sleep,
        random: () => 0.5,
        now: h.now,
        ...extra,
    });
}

const expectRejects = async (p: Promise<unknown>): Promise<TrendsError> => {
    const err = await p.then(
        () => {
            throw new Error('expected rejection');
        },
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TrendsError);
    return err as TrendsError;
};

describe('parseXssi', () => {
    it.each([
        [')]}\'', ")]}'\n{\"a\":1}"],
        [')]}\',', ")]}',\n{\"a\":1}"],
        ['no prefix', '{"a":1}'],
    ])('parses a body with %s', (_label, text) => {
        expect(parseXssi(text, 'explore')).toEqual({ a: 1 });
    });

    it('parses the recorded fixtures', () => {
        expect(parseXssi(fixture('relatedsearches-empty.txt'), 'widgetdata/relatedsearches')).toEqual({
            default: { rankedList: [] },
        });
        expect(parseXssi(fixture('explore-ok.txt'), 'explore')).toEqual(EXPLORE);
    });

    it.each([
        ['HTML page', fixture('rate-limited-429.html')],
        ['truncated JSON', ")]}',\n{\"default\":{"],
        ['empty body', ''],
    ])('non-JSON (%s) -> SourceChangedError', (_label, text) => {
        let err: unknown;
        try {
            parseXssi(text, 'explore');
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(SourceChangedError);
        expect((err as TrendsError).code).toBe('SOURCE_CHANGED');
        expect((err as TrendsError).retryable).toBe(false);
    });
});

describe('explore', () => {
    it('sends a GET to api/explore with hl, tz=0 and the exact req JSON, plus UA and Accept-Language', async () => {
        const h = makeHarness([ok(fixture('explore-ok.txt'))]);
        await client(h).explore(QUERY);
        expect(h.calls).toHaveLength(1);
        const { url, headers } = h.calls[0]!;
        expect(`${url.origin}${url.pathname}`).toBe(`${BASE}explore`);
        expect(url.searchParams.get('hl')).toBe('en-US');
        expect(url.searchParams.get('tz')).toBe('0');
        expect(url.searchParams.has('token')).toBe(false);
        expect(JSON.parse(url.searchParams.get('req')!)).toEqual({
            comparisonItem: [{ keyword: 'coffee', geo: 'US', time: 'today 12-m' }],
            category: 0,
            property: '',
        });
        expect(header(headers, 'User-Agent')).toBeTruthy();
        expect(header(headers, 'Accept-Language')).toBeTruthy();
    });

    it('passes keyword, geo, time and category through to req', async () => {
        const h = makeHarness([ok(fixture('explore-ok.txt'))]);
        await client(h, { language: 'de' }).explore({
            keyword: 'solar panels',
            geo: 'US-CA',
            timeRange: '2024-01-01 2024-06-30',
            category: 71,
        });
        const url = h.calls[0]!.url;
        expect(url.searchParams.get('hl')).toBe('de');
        expect(JSON.parse(url.searchParams.get('req')!)).toEqual({
            comparisonItem: [{ keyword: 'solar panels', geo: 'US-CA', time: '2024-01-01 2024-06-30' }],
            category: 71,
            property: '',
        });
    });

    it('returns the 3 known widgets with id/request/token and ignores GEO_MAP', async () => {
        const h = makeHarness([ok(fixture('explore-ok.txt'))]);
        const result = await client(h).explore(QUERY);
        expect(result).toEqual({
            timeseries: widget('TIMESERIES'),
            relatedQueries: widget('RELATED_QUERIES'),
            relatedTopics: widget('RELATED_TOPICS'),
        });
        expect(JSON.stringify(result)).not.toContain('GEO_MAP');
    });

    it('a missing widget (RELATED_TOPICS) is left undefined', async () => {
        const body = exploreBody((d) => {
            d.widgets = d.widgets.filter((w) => w.id !== 'RELATED_TOPICS');
        });
        const result = await client(makeHarness([ok(body)])).explore(QUERY);
        expect(result.relatedTopics).toBeUndefined();
        expect(result.timeseries).toEqual(widget('TIMESERIES'));
        expect(result.relatedQueries).toEqual(widget('RELATED_QUERIES'));
    });

    it('a GEO_MAP widget without a token is ignored, not an error', async () => {
        const body = exploreBody((d) => {
            delete d.widgets.find((w) => w.id === 'GEO_MAP')!.token;
        });
        const result = await client(makeHarness([ok(body)])).explore(QUERY);
        expect(result.timeseries).toEqual(widget('TIMESERIES'));
    });

    it.each([
        ['no widgets key', ")]}'\n{\"keywords\":[]}"],
        ['widgets not an array', ")]}'\n{\"widgets\":{}}"],
        ['JSON null', ")]}'\nnull"],
    ])('body with %s -> SourceChangedError, not retried', async (_label, body) => {
        const h = makeHarness([ok(body), ok(fixture('explore-ok.txt'))]);
        const err = await expectRejects(client(h).explore(QUERY));
        expect(err).toBeInstanceOf(SourceChangedError);
        expect(err.code).toBe('SOURCE_CHANGED');
        expect(h.calls).toHaveLength(1);
    });

    it.each([
        ['TIMESERIES', 'token'],
        ['RELATED_QUERIES', 'token'],
        ['RELATED_TOPICS', 'request'],
    ])('known widget %s without %s -> SourceChangedError', async (id, field) => {
        const body = exploreBody((d) => {
            delete d.widgets.find((w) => w.id === id)![field];
        });
        const h = makeHarness([ok(body)]);
        const err = await expectRejects(client(h).explore(QUERY));
        expect(err).toBeInstanceOf(SourceChangedError);
        expect(h.calls).toHaveLength(1);
    });

    it('malformed JSON (200 HTML) -> SourceChangedError, not retried', async () => {
        const h = makeHarness([ok(fixture('rate-limited-429.html')), ok(fixture('explore-ok.txt'))]);
        const err = await expectRejects(client(h).explore(QUERY));
        expect(err).toBeInstanceOf(SourceChangedError);
        expect(err.retryable).toBe(false);
        expect(h.calls).toHaveLength(1);
    });
});

describe('cookie warm-up on explore', () => {
    const warm = { status: 429, body: fixture('rate-limited-429.html'), setCookie: ['NID=abc123; expires=Fri, 23-Apr-2027 13:01:00 GMT; path=/; domain=.google.com; HttpOnly'] };

    it('429 + Set-Cookie on a fresh session -> repeated with the cookie -> 200', async () => {
        const h = makeHarness([warm, ok(fixture('explore-ok.txt'))]);
        const result = await client(h).explore(QUERY);
        expect(result.timeseries).toEqual(widget('TIMESERIES'));
        expect(h.calls).toHaveLength(2);
        expect(header(h.calls[0]!.headers, 'Cookie') ?? '').toBe('');
        expect(header(h.calls[1]!.headers, 'Cookie')).toBe('NID=abc123');
        expect(h.calls[1]!.url.toString()).toBe(h.calls[0]!.url.toString());
    });

    it('the warm-up repeat does not use up a retry (maxRetries=0 still succeeds)', async () => {
        const h = makeHarness([warm, ok(fixture('explore-ok.txt'))]);
        const result = await client(h, { maxRetries: 0 }).explore(QUERY);
        expect(result.relatedQueries).toEqual(widget('RELATED_QUERIES'));
        expect(h.calls).toHaveLength(2);
    });

    it('the warm-up repeat is paced but has no backoff sleep', async () => {
        const h = makeHarness([warm, ok(fixture('explore-ok.txt'))]);
        await client(h, { maxRetries: 0, minRequestIntervalMs: 3000 }).explore(QUERY);
        expect(h.calls[1]!.startedAt - h.calls[0]!.startedAt).toBeGreaterThanOrEqual(3000);
        // Only pacing (3000), never a backoff delay (base 4000 * jitter >= 2000 on top).
        expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(3000);
    });

    it('with maxRetries=0, a 429 without Set-Cookie fails after one call', async () => {
        const h = makeHarness([{ status: 429, body: fixture('rate-limited-429.html') }, ok(fixture('explore-ok.txt'))]);
        const err = await expectRejects(client(h, { maxRetries: 0 }).explore(QUERY));
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err.attempts).toBe(1);
        expect(h.calls).toHaveLength(1);
    });

    it('no warm-up once the session already has cookies: a 429 with cookie then counts as a retry', async () => {
        const h = makeHarness([
            ok(fixture('explore-ok.txt'), ['NID=first; path=/']),
            { ...warm, setCookie: ['NID=second; path=/'] },
            ok(fixture('explore-ok.txt')),
        ]);
        const c = client(h, { maxRetries: 0 });
        await c.explore(QUERY);
        const err = await expectRejects(c.explore(QUERY));
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(h.calls).toHaveLength(2);
    });
});

describe('interestOverTime / relatedSearches', () => {
    const ts = widget('TIMESERIES');
    const rq = widget('RELATED_QUERIES');
    const rt = widget('RELATED_TOPICS');

    it.each([
        'multiline-weekly-ok.txt',
        'multiline-hourly-ok.txt',
        'multiline-daily-custom-range-ok.txt',
        'multiline-nonexistent-empty.txt',
        'multiline-nonexistent-hourly-nodata.txt',
    ])('interestOverTime calls widgetdata/multiline and returns default (%s)', async (name) => {
        const h = makeHarness([ok(fixture(name))]);
        const result = await client(h).interestOverTime(ts);
        expect(result).toEqual((fixtureJson(name) as { default: unknown }).default);
        const { url } = h.calls[0]!;
        expect(`${url.origin}${url.pathname}`).toBe(`${BASE}widgetdata/multiline`);
        expect(url.searchParams.get('req')).toBe(JSON.stringify(ts.request));
        expect(url.searchParams.get('token')).toBe(ts.token);
        expect(url.searchParams.get('hl')).toBe('en-US');
        expect(url.searchParams.get('tz')).toBe('0');
    });

    it.each([
        ['relatedsearches-queries-ok.txt', rq],
        ['relatedsearches-queries-empty-lists.txt', rq],
        ['relatedsearches-empty.txt', rt],
    ])('relatedSearches calls widgetdata/relatedsearches and returns default (%s)', async (name, w) => {
        const h = makeHarness([ok(fixture(name))]);
        const result = await client(h).relatedSearches(w);
        expect(result).toEqual((fixtureJson(name) as { default: unknown }).default);
        const { url, headers } = h.calls[0]!;
        expect(`${url.origin}${url.pathname}`).toBe(`${BASE}widgetdata/relatedsearches`);
        expect(url.searchParams.get('req')).toBe(JSON.stringify(w.request));
        expect(url.searchParams.get('token')).toBe(w.token);
        expect(url.searchParams.get('hl')).toBe('en-US');
        expect(url.searchParams.get('tz')).toBe('0');
        expect(header(headers, 'User-Agent')).toBeTruthy();
        expect(header(headers, 'Accept-Language')).toBeTruthy();
    });

    it('the related queries fixture has top (25) and rising (25) lists', async () => {
        const result = (await client(makeHarness([ok(fixture('relatedsearches-queries-ok.txt'))])).relatedSearches(rq)) as {
            rankedList: { rankedKeyword: unknown[] }[];
        };
        expect(result.rankedList).toHaveLength(2);
        expect(result.rankedList[0]!.rankedKeyword).toHaveLength(25);
        expect(result.rankedList[1]!.rankedKeyword).toHaveLength(25);
    });

    it.each([
        ['missing default', ")]}',\n{\"timelineData\":[]}"],
        ['default null', ")]}',\n{\"default\":null}"],
        ['default a number', ")]}',\n{\"default\":5}"],
        ['default a string', ")]}',\n{\"default\":\"x\"}"],
    ])('%s -> SourceChangedError, not retried', async (_label, body) => {
        for (const call of ['interestOverTime', 'relatedSearches'] as const) {
            const h = makeHarness([ok(body), ok(fixture('multiline-weekly-ok.txt'))]);
            const err = await expectRejects(client(h)[call](call === 'interestOverTime' ? ts : rq));
            expect(err, call).toBeInstanceOf(SourceChangedError);
            expect(h.calls, call).toHaveLength(1);
        }
    });

    it('malformed JSON on a widget call -> SourceChangedError, not retried', async () => {
        const h = makeHarness([ok(")]}',\n{\"default\":{\"timelineData\":["), ok(fixture('multiline-weekly-ok.txt'))]);
        const err = await expectRejects(client(h).interestOverTime(ts));
        expect(err).toBeInstanceOf(SourceChangedError);
        expect(h.calls).toHaveLength(1);
    });
});

describe('status classification and retries', () => {
    const ts = widget('TIMESERIES');
    const rate429 = { status: 429, body: fixture('rate-limited-429-widget.html') };

    it.each([0, 1, 3, 5])('429 x N -> RateLimitedError after exactly maxRetries+1 calls (maxRetries=%i)', async (maxRetries) => {
        const h = makeHarness(Array.from({ length: maxRetries + 3 }, () => rate429));
        const err = await expectRejects(client(h, { maxRetries }).interestOverTime(ts));
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err.code).toBe('RATE_LIMITED');
        expect((err as unknown as { status?: number }).status).toBe(429);
        expect(err.attempts).toBe(maxRetries + 1);
        expect(h.calls).toHaveLength(maxRetries + 1);
    });

    it('429 x N on explore without Set-Cookie -> exactly maxRetries+1 calls', async () => {
        const h = makeHarness(Array.from({ length: 6 }, () => ({ status: 429, body: fixture('rate-limited-429.html') })));
        const err = await expectRejects(client(h, { maxRetries: 2 }).explore(QUERY));
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err.attempts).toBe(3);
        expect(h.calls).toHaveLength(3);
    });

    it('the misleading "should not be retried" 429 widget page IS retried', async () => {
        const h = makeHarness([rate429, rate429, ok(fixture('multiline-weekly-ok.txt'))]);
        const result = await client(h).interestOverTime(ts);
        expect(result).toEqual((fixtureJson('multiline-weekly-ok.txt') as { default: unknown }).default);
        expect(h.calls).toHaveLength(3);
    });

    it('400 is not retried -> HttpStatusError', async () => {
        const h = makeHarness([{ status: 400, body: 'bad' }, ok(fixture('multiline-weekly-ok.txt'))]);
        const err = await expectRejects(client(h).interestOverTime(ts));
        expect(err).toBeInstanceOf(HttpStatusError);
        expect(err.code).toBe('HTTP_ERROR');
        expect((err as unknown as { status?: number }).status).toBe(400);
        expect(err.retryable).toBe(false);
        expect(h.calls).toHaveLength(1);
        expect(h.sleeps).toEqual([]);
    });

    it('401 is not retried -> TokenMismatchError', async () => {
        const h = makeHarness([{ status: 401, body: fixture('token-mismatch-401.html') }, ok(fixture('relatedsearches-empty.txt'))]);
        const err = await expectRejects(client(h).relatedSearches(widget('RELATED_QUERIES')));
        expect(err).toBeInstanceOf(TokenMismatchError);
        expect(err.code).toBe('TOKEN_MISMATCH');
        expect((err as unknown as { status?: number }).status).toBe(401);
        expect(h.calls).toHaveLength(1);
    });

    it.each([500, 503])('%i is retried', async (status) => {
        const h = makeHarness([{ status, body: 'oops' }, ok(fixture('multiline-weekly-ok.txt'))]);
        await expect(client(h).interestOverTime(ts)).resolves.toBeTypeOf('object');
        expect(h.calls).toHaveLength(2);
    });

    it('503 x N -> HttpStatusError with attempts = maxRetries+1', async () => {
        const h = makeHarness(Array.from({ length: 5 }, () => ({ status: 503 })));
        const err = await expectRejects(client(h, { maxRetries: 2 }).interestOverTime(ts));
        expect(err).toBeInstanceOf(HttpStatusError);
        expect((err as unknown as { status?: number }).status).toBe(503);
        expect(err.attempts).toBe(3);
        expect(h.calls).toHaveLength(3);
    });

    it('backoff sleeps follow backoffDelay with the injected random (0.5) and grow exponentially', async () => {
        const h = makeHarness([rate429, rate429, rate429, ok(fixture('multiline-weekly-ok.txt'))]);
        await client(h, { minRequestIntervalMs: 0 }).interestOverTime(ts);
        expect(h.sleeps).toEqual([3000, 6000, 12000]);
    });

    it.each([
        [0, [2000, 4000, 8000, 16000, 30000]],
        [1, [4000, 8000, 16000, 32000, 60000]],
    ])('backoff with random=%d caps at maxDelayMs', async (r, expected) => {
        const h = makeHarness(Array.from({ length: 6 }, () => rate429));
        await expectRejects(client(h, { minRequestIntervalMs: 0, random: () => r }).interestOverTime(ts));
        expect(h.sleeps).toEqual(expected);
    });

    it('custom baseDelayMs/maxDelayMs are honoured', async () => {
        const h = makeHarness(Array.from({ length: 5 }, () => rate429));
        await expectRejects(
            client(h, { minRequestIntervalMs: 0, random: () => 1, baseDelayMs: 100, maxDelayMs: 300, maxRetries: 4 }).interestOverTime(ts),
        );
        expect(h.sleeps).toEqual([100, 200, 300, 300]);
    });

    it('onRetry is called before each backoff sleep', async () => {
        const onRetry = vi.fn();
        const h = makeHarness([rate429, { status: 503 }, ok(fixture('multiline-weekly-ok.txt'))]);
        await client(h, { minRequestIntervalMs: 0, onRetry }).interestOverTime(ts);
        expect(onRetry).toHaveBeenCalledTimes(2);
        expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, delayMs: 3000 });
        expect(onRetry.mock.calls[0]![0].error).toBeInstanceOf(RateLimitedError);
        expect(onRetry.mock.calls[1]![0]).toMatchObject({ attempt: 2, delayMs: 6000 });
        expect(onRetry.mock.calls[1]![0].error).toBeInstanceOf(HttpStatusError);
    });
});

describe('network errors and proxy secrecy', () => {
    const ts = widget('TIMESERIES');
    const PROXY = 'http://user:secret@proxy.example:8000';

    it('a throwing fetch becomes NetworkError and is retried', async () => {
        const h = makeHarness([{ status: 0, throws: new TypeError('fetch failed') }, ok(fixture('multiline-weekly-ok.txt'))]);
        await expect(client(h).interestOverTime(ts)).resolves.toBeTypeOf('object');
        expect(h.calls).toHaveLength(2);
    });

    it('fetch throwing every time -> NetworkError (retryable) after maxRetries+1 calls', async () => {
        const h = makeHarness(Array.from({ length: 5 }, () => ({ status: 0, throws: new TypeError('fetch failed') })));
        const err = await expectRejects(client(h, { maxRetries: 2 }).interestOverTime(ts));
        expect(err).toBeInstanceOf(NetworkError);
        expect(err.code).toBe('NETWORK_ERROR');
        expect(err.retryable).toBe(true);
        expect(err.attempts).toBe(3);
        expect(h.calls).toHaveLength(3);
    });

    it('the proxy URL and password never appear in the error message', async () => {
        const leak = () => ({ status: 0, throws: new Error(`connect ECONNREFUSED via ${PROXY}`) });
        const h = makeHarness([leak(), leak(), leak()]);
        const err = await expectRejects(client(h, { maxRetries: 2, proxyUrl: PROXY }).interestOverTime(ts));
        expect(err).toBeInstanceOf(NetworkError);
        expect(err.message).not.toContain('secret');
        expect(err.message).not.toContain(PROXY);
        expect(err.message).not.toContain('proxy.example');
    });
});

describe('pacing', () => {
    const ts = widget('TIMESERIES');
    const rq = widget('RELATED_QUERIES');

    it('consecutive requests start >= minRequestIntervalMs apart', async () => {
        const h = makeHarness([
            ok(fixture('explore-ok.txt')),
            ok(fixture('multiline-weekly-ok.txt')),
            ok(fixture('relatedsearches-queries-ok.txt')),
        ]);
        const c = client(h, { minRequestIntervalMs: 3000 });
        await c.explore(QUERY);
        await c.interestOverTime(ts);
        await c.relatedSearches(rq);
        expect(h.calls).toHaveLength(3);
        expect(h.calls[1]!.startedAt - h.calls[0]!.startedAt).toBeGreaterThanOrEqual(3000);
        expect(h.calls[2]!.startedAt - h.calls[1]!.startedAt).toBeGreaterThanOrEqual(3000);
        expect(h.sleeps).toEqual([3000, 3000]);
    });

    it('the first request needs no pacing sleep', async () => {
        const h = makeHarness([ok(fixture('explore-ok.txt'))]);
        await client(h, { minRequestIntervalMs: 3000 }).explore(QUERY);
        expect(h.sleeps).toEqual([]);
    });

    it('defaults to a 3000 ms interval', async () => {
        const h = makeHarness([ok(fixture('explore-ok.txt')), ok(fixture('multiline-weekly-ok.txt'))]);
        const c = client(h);
        await c.explore(QUERY);
        await c.interestOverTime(ts);
        expect(h.calls[1]!.startedAt - h.calls[0]!.startedAt).toBeGreaterThanOrEqual(3000);
    });

    it('no sleep when enough time has already elapsed', async () => {
        const h = makeHarness([ok(fixture('explore-ok.txt')), ok(fixture('multiline-weekly-ok.txt'))]);
        const c = client(h, { minRequestIntervalMs: 3000 });
        await c.explore(QUERY);
        h.advance(5000);
        await c.interestOverTime(ts);
        expect(h.sleeps).toEqual([]);
    });

    it('only the remaining part of the interval is waited out', async () => {
        const h = makeHarness([ok(fixture('explore-ok.txt')), ok(fixture('multiline-weekly-ok.txt'))]);
        const c = client(h, { minRequestIntervalMs: 3000 });
        await c.explore(QUERY);
        h.advance(1000);
        await c.interestOverTime(ts);
        expect(h.calls[1]!.startedAt - h.calls[0]!.startedAt).toBeGreaterThanOrEqual(3000);
        expect(h.sleeps).toHaveLength(1);
        expect(h.sleeps[0]).toBeGreaterThanOrEqual(2000);
        expect(h.sleeps[0]).toBeLessThan(3000);
    });

    it('retries are paced too: a backoff shorter than the interval still leaves the interval', async () => {
        const h = makeHarness([{ status: 503 }, ok(fixture('multiline-weekly-ok.txt'))]);
        await client(h, { minRequestIntervalMs: 3000, baseDelayMs: 100, random: () => 1 }).interestOverTime(ts);
        expect(h.calls[1]!.startedAt - h.calls[0]!.startedAt).toBeGreaterThanOrEqual(3000);
    });
});

describe('cookies', () => {
    const ts = widget('TIMESERIES');
    const rq = widget('RELATED_QUERIES');

    it('are stored by name, attributes ignored, and sent back as "a=1; b=2"', async () => {
        const h = makeHarness([
            ok(fixture('explore-ok.txt'), ['a=1; Path=/; HttpOnly', 'b=2; expires=Fri, 23-Apr-2027 13:01:00 GMT; domain=.google.com']),
            ok(fixture('multiline-weekly-ok.txt')),
        ]);
        const c = client(h);
        await c.explore(QUERY);
        await c.interestOverTime(ts);
        expect(header(h.calls[0]!.headers, 'Cookie') ?? '').toBe('');
        expect(header(h.calls[1]!.headers, 'Cookie')).toBe('a=1; b=2');
    });

    it('later values overwrite earlier ones and are sent on every later request', async () => {
        const h = makeHarness([
            ok(fixture('explore-ok.txt'), ['a=1; Path=/', 'b=2']),
            ok(fixture('multiline-weekly-ok.txt'), ['a=9; Secure']),
            ok(fixture('relatedsearches-queries-ok.txt')),
            ok(fixture('relatedsearches-empty.txt')),
        ]);
        const c = client(h);
        await c.explore(QUERY);
        await c.interestOverTime(ts);
        await c.relatedSearches(rq);
        await c.relatedSearches(rq);
        for (const i of [2, 3]) {
            const sent = header(h.calls[i]!.headers, 'Cookie')!;
            const pairs = sent.split('; ').sort();
            expect(pairs, sent).toEqual(['a=9', 'b=2']);
        }
    });

    it('cookies set by an error response are kept for the retry', async () => {
        const h = makeHarness([
            { status: 503, setCookie: ['x=1; path=/'] },
            ok(fixture('multiline-weekly-ok.txt')),
        ]);
        await client(h).interestOverTime(ts);
        expect(header(h.calls[1]!.headers, 'Cookie')).toBe('x=1');
    });
});

// §6 Part 3 contract: updated Security bullet and the "Clarifications" bullet.
describe('proxy password secrecy (raw and percent-decoded)', () => {
    const ts = widget('TIMESERIES');
    const PROXY = 'http://user:s3cr%40t@proxy.example:8000';

    it('neither the URL nor the raw or decoded password appears in the final error message', async () => {
        const leak = () => ({
            status: 0,
            throws: new Error(`connect ECONNREFUSED ${PROXY}; auth s3cr%40t failed; decoded s3cr@t rejected`),
        });
        const h = makeHarness([leak(), leak(), leak()]);
        const err = await expectRejects(client(h, { maxRetries: 2, proxyUrl: PROXY }).interestOverTime(ts));
        expect(err).toBeInstanceOf(NetworkError);
        expect(err.message).not.toContain(PROXY);
        expect(err.message).not.toContain('s3cr%40t');
        expect(err.message).not.toContain('s3cr@t');
    });
});

describe('Clarifications', () => {
    const ts = widget('TIMESERIES');
    const warm = { status: 429, body: fixture('rate-limited-429.html'), setCookie: ['NID=abc; path=/'] };
    const rate429 = { status: 429, body: fixture('rate-limited-429.html') };

    it('status lives on HttpStatusError and its subclasses', async () => {
        for (const [status, cls] of [[429, RateLimitedError], [401, TokenMismatchError], [400, HttpStatusError], [503, HttpStatusError]] as const) {
            const h = makeHarness([{ status }]);
            const err = await expectRejects(client(h, { maxRetries: 0 }).interestOverTime(ts));
            expect(err).toBeInstanceOf(cls);
            expect(err).toBeInstanceOf(HttpStatusError);
            const typed: HttpStatusError = err as HttpStatusError;
            expect(typed.status).toBe(status);
        }
    });

    it('onRetry attempt is the number of the call that just failed (1, 2, 3)', async () => {
        const onRetry = vi.fn();
        const h = makeHarness([rate429, rate429, rate429, rate429]);
        const err = await expectRejects(client(h, { maxRetries: 3, minRequestIntervalMs: 0, onRetry }).interestOverTime(ts));
        expect(err.attempts).toBe(4);
        expect(onRetry.mock.calls.map((c) => (c[0] as { attempt: number }).attempt)).toEqual([1, 2, 3]);
    });

    it('fresh session: 429+cookie, then 200 -> succeeds (maxRetries=0)', async () => {
        const h = makeHarness([warm, ok(fixture('explore-ok.txt'))]);
        await expect(client(h, { maxRetries: 0 }).explore(QUERY)).resolves.toMatchObject({ timeseries: widget('TIMESERIES') });
        expect(h.calls).toHaveLength(2);
    });

    it('fresh session: 429+cookie, 429, 200 with maxRetries=1 -> succeeds', async () => {
        const h = makeHarness([warm, rate429, ok(fixture('explore-ok.txt'))]);
        await expect(client(h, { maxRetries: 1 }).explore(QUERY)).resolves.toMatchObject({ timeseries: widget('TIMESERIES') });
        expect(h.calls).toHaveLength(3);
    });

    it('warm-up is not counted: 429+cookie then 429s with maxRetries=1 -> attempts=2 after 3 calls', async () => {
        const onRetry = vi.fn();
        const h = makeHarness([warm, rate429, rate429, ok(fixture('explore-ok.txt'))]);
        const err = await expectRejects(client(h, { maxRetries: 1, onRetry }).explore(QUERY));
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err.attempts).toBe(2);
        expect(h.calls).toHaveLength(3);
        expect(onRetry.mock.calls.map((c) => (c[0] as { attempt: number }).attempt)).toEqual([1]);
    });
});
