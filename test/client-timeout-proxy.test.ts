// Tests for the Part 3 "Timeout" and "Proxy" bullets (IMPLEMENTATION_PLAN.md §6), written from the spec.
import { describe, expect, it } from 'vitest';
import { TrendsClient, type FetchLike } from '../src/trends/client.js';
import { NetworkError, TrendsError } from '../src/trends/errors.js';
import { fixture, fixtureJson, makeHarness, ok, type FakeReply, type Harness } from './helpers/fake-fetch.js';

const QUERY = { keyword: 'coffee', geo: 'US', timeRange: 'today 12-m', category: 0 };
const EXPLORE = fixtureJson('explore-ok.txt') as { widgets: { id: string; request: unknown; token: string }[] };
const TS = (() => {
    const w = EXPLORE.widgets.find((x) => x.id === 'TIMESERIES')!;
    return { id: w.id, request: w.request, token: w.token };
})();

type Opts = ConstructorParameters<typeof TrendsClient>[0];

/** Wraps the harness fetch to capture the `signal` passed on every call. */
function withSignals(h: Harness, override?: FetchLike): { fetch: FetchLike; signals: unknown[] } {
    const signals: unknown[] = [];
    const fetch: FetchLike = async (url, init) => {
        signals.push((init as { signal?: unknown }).signal);
        return (override ?? h.fetch)(url, init);
    };
    return { fetch, signals };
}

const make = (h: Harness, fetch: FetchLike, extra: Partial<Opts> = {}) =>
    new TrendsClient({ language: 'en-US', maxRetries: 3, fetch, sleep: h.sleep, random: () => 0.5, now: h.now, ...extra } as Opts);

describe('client timeout', () => {
    it('every fetch call (explore and widget calls, retries included) gets an AbortSignal', async () => {
        const h = makeHarness([
            ok(fixture('explore-ok.txt'), ['NID=1']),
            { status: 503, body: 'x' },
            ok(fixture('multiline-weekly-ok.txt')),
            ok(fixture('relatedsearches-queries-ok.txt')),
        ]);
        const { fetch, signals } = withSignals(h);
        const c = make(h, fetch);
        const widgets = (await c.explore(QUERY)) as { timeseries: typeof TS; relatedQueries: typeof TS };
        await c.interestOverTime(widgets.timeseries);
        await c.relatedSearches(widgets.relatedQueries);
        expect(signals).toHaveLength(4);
        for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
        // each attempt gets its own signal
        expect(new Set(signals).size).toBe(4);
    });

    it.each([
        ['TimeoutError', new DOMException('t', 'TimeoutError')],
        ['AbortError', new DOMException('a', 'AbortError')],
    ])('fetch rejecting with %s -> NetworkError, retried', async (_n, thrown) => {
        const h = makeHarness([{ status: 0, throws: thrown }, ok(fixture('multiline-weekly-ok.txt'))]);
        const { fetch } = withSignals(h);
        await expect(make(h, fetch).interestOverTime(TS)).resolves.toBeTypeOf('object');
        expect(h.calls).toHaveLength(2);
    });

    it('timeouts every time -> NetworkError (retryable) after maxRetries+1 calls', async () => {
        const h = makeHarness(Array.from({ length: 3 }, () => ({ status: 0, throws: new DOMException('t', 'TimeoutError') }) as FakeReply));
        const { fetch } = withSignals(h);
        const err = await make(h, fetch, { maxRetries: 2 }).interestOverTime(TS).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(NetworkError);
        expect((err as TrendsError).retryable).toBe(true);
        expect((err as TrendsError).attempts).toBe(3);
    });

    it('requestTimeoutMs actually aborts a hanging fetch, which is then retried', async () => {
        const h = makeHarness([ok(fixture('multiline-weekly-ok.txt'))]);
        let n = 0;
        const hanging: FetchLike = (url, init) => {
            n++;
            if (n > 1) return h.fetch(url, init);
            const signal = (init as { signal?: AbortSignal }).signal;
            return new Promise((_res, rej) => {
                if (!signal) return rej(new Error('no signal passed'));
                signal.addEventListener('abort', () => rej(signal.reason));
            });
        };
        const { fetch } = withSignals(h, hanging);
        const started = Date.now();
        await expect(make(h, fetch, { requestTimeoutMs: 30 } as Partial<Opts>).interestOverTime(TS)).resolves.toBeTypeOf('object');
        expect(n).toBe(2);
        expect(Date.now() - started).toBeLessThan(5000);
    });
});

describe('client proxy', () => {
    it("invalid proxyUrl -> constructor throws Error('Invalid proxy URL') without the password", () => {
        const h = makeHarness();
        let caught: unknown;
        try {
            make(h, h.fetch, { proxyUrl: 'http://u:pw@ not valid' });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain('Invalid proxy URL');
        expect((caught as Error).message).not.toContain('pw');
        expect((caught as Error).message).not.toContain('not valid');
    });

    it('close() resolves without a proxy', async () => {
        const h = makeHarness();
        await expect(make(h, h.fetch).close()).resolves.toBeUndefined();
    });

    it('close() resolves with a proxy (no request made)', async () => {
        const h = makeHarness();
        await expect(make(h, h.fetch, { proxyUrl: 'http://u:pw@127.0.0.1:9' }).close()).resolves.toBeUndefined();
        expect(h.calls).toHaveLength(0);
    });
});
