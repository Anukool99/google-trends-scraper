// Integration tests for keyword orchestration, written from IMPLEMENTATION_PLAN.md §6
// "Part 5 contract" (+ Part 4 record shapes / rollupStatus, Part 3 error classes). Not from src/.
import { describe, expect, it } from 'vitest';
import { parseInput, type ValidatedInput } from '../src/input.js';
import { MAX_CONSECUTIVE_FAILED_KEYWORDS, runActor, scrapeKeyword, type RunDeps, type RunSummary } from '../src/run.js';
import { RateLimitedError, RunAbortedError, TokenMismatchError, TrendsError, httpError } from '../src/trends/errors.js';
import {
    QUERIES_OK as RQ,
    RELATED_EMPTY,
    TIMESERIES_OK as TS,
    widgetData as widgetDataLocal,
    makeFakeApi,
    makeLog,
    schemaErrors,
    trace,
    widgetsFor,
    type KeywordScript,
    type Query,
    type Widget,
} from './helpers/fake-trends.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const Q: Query = { keyword: 'coffee', geo: 'US', timeRange: 'today 12-m', category: 0 };
const ALL = { includeRelatedQueries: true, includeRelatedTopics: true };
const unauthorized = (endpoint: string) => httpError(401, endpoint);
const serverError = (endpoint: string) => httpError(503, endpoint);

type Rec = Record<string, unknown> & {
    status: string;
    interestOverTime: Record<string, unknown> & { status: string; error?: string };
    relatedQueries: Record<string, unknown> & { status: string; error?: string };
    relatedTopics: Record<string, unknown> & { status: string; error?: string };
};

const scrape = async (scripts: Record<string, KeywordScript>, opts = ALL, query: Query = Q) => {
    const fake = makeFakeApi(scripts);
    const rec = (await scrapeKeyword(fake.api, query, opts)) as unknown as Rec;
    // Every scraped record (plus scrapedAt) must be schema-valid.
    expect(schemaErrors({ ...rec, scrapedAt: NOW.toISOString() })).toBe('');
    return { rec, fake, tr: trace(fake.calls) };
};

describe('scrapeKeyword: order and disabled sections', () => {
    it('calls explore -> timeseries -> related queries -> related topics, sequentially', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const slow = (v: () => unknown) => async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
            return v();
        };
        const fake = makeFakeApi({
            coffee: {
                timeseries: slow(() => JSON.parse(JSON.stringify(TS()))),
                relatedQueries: slow(() => JSON.parse(JSON.stringify(RQ()))),
                relatedTopics: slow(() => RELATED_EMPTY()),
            },
        });
        const r = (await scrapeKeyword(fake.api, Q, ALL)) as unknown as Rec;
        expect(maxInFlight).toBe(1);
        expect(trace(fake.calls)).toEqual([
            'explore:coffee',
            'interestOverTime:coffee|TIMESERIES|1',
            'relatedSearches:coffee|RELATED_QUERIES|1',
            'relatedSearches:coffee|RELATED_TOPICS|1',
        ]);
        expect(fake.calls[0]!.arg).toEqual(Q);
        expect(r.interestOverTime.status).toBe('ok');
        expect(r.interestOverTime.resolution).toBe('week');
        expect(r.relatedQueries.status).toBe('ok');
        expect(r.relatedTopics).toEqual({ status: 'empty', top: [], rising: [] });
        expect(r.status).toBe('ok');
    });

    it('widget calls receive the widget objects returned by explore', async () => {
        const { fake } = await scrape({});
        const w = widgetsFor('coffee', 1);
        expect(fake.calls.map((c) => c.arg)).toEqual([Q, w.timeseries, w.relatedQueries, w.relatedTopics]);
    });

    it('both related sections disabled -> skipped, no relatedSearches call', async () => {
        const { rec, tr } = await scrape({}, { includeRelatedQueries: false, includeRelatedTopics: false });
        expect(tr).toEqual(['explore:coffee', 'interestOverTime:coffee|TIMESERIES|1']);
        expect(rec.relatedQueries).toEqual({ status: 'skipped', top: null, rising: null });
        expect(rec.relatedTopics).toEqual({ status: 'skipped', top: null, rising: null });
        expect(rec.status).toBe('ok');
    });

    it('only topics disabled -> topics skipped, queries still fetched', async () => {
        const { rec, tr } = await scrape({}, { includeRelatedQueries: true, includeRelatedTopics: false });
        expect(tr).toEqual(['explore:coffee', 'interestOverTime:coffee|TIMESERIES|1', 'relatedSearches:coffee|RELATED_QUERIES|1']);
        expect(rec.relatedQueries.status).toBe('ok');
        expect(rec.relatedTopics.status).toBe('skipped');
    });

    it('only queries disabled -> queries skipped, topics fetched', async () => {
        const { rec, tr } = await scrape({}, { includeRelatedQueries: false, includeRelatedTopics: true });
        expect(tr).toEqual(['explore:coffee', 'interestOverTime:coffee|TIMESERIES|1', 'relatedSearches:coffee|RELATED_TOPICS|1']);
        expect(rec.relatedQueries.status).toBe('skipped');
        expect(rec.relatedTopics.status).toBe('empty');
    });
});

describe('scrapeKeyword: failures', () => {
    it('explore throws RateLimitedError -> every requested section failed, no widget calls, disabled still skipped', async () => {
        const err = new RateLimitedError('explore');
        const { rec, tr } = await scrape(
            { coffee: { explore: () => Promise.reject(err) } },
            { includeRelatedQueries: true, includeRelatedTopics: false },
        );
        expect(tr).toEqual(['explore:coffee']);
        expect(rec.interestOverTime).toEqual({ status: 'failed', error: `RATE_LIMITED: ${err.message}`, resolution: null, points: null });
        expect(rec.relatedQueries).toEqual({ status: 'failed', error: `RATE_LIMITED: ${err.message}`, top: null, rising: null });
        expect(rec.relatedTopics).toEqual({ status: 'skipped', top: null, rising: null });
        expect(rec.status).toBe('failed');
    });

    it('missing RELATED_QUERIES widget -> that section SOURCE_CHANGED naming the widget; others unaffected', async () => {
        const { rec, tr } = await scrape({
            coffee: {
                explore: (n) => {
                    const w = widgetsFor('coffee', n);
                    return { timeseries: w.timeseries, relatedTopics: w.relatedTopics };
                },
            },
        });
        expect(rec.relatedQueries.status).toBe('failed');
        expect(rec.relatedQueries.error).toMatch(/^SOURCE_CHANGED: /);
        expect(rec.relatedQueries.error).toContain('RELATED_QUERIES');
        expect(rec.relatedQueries.top).toBeNull();
        expect(rec.relatedQueries.rising).toBeNull();
        expect(rec.interestOverTime.status).toBe('ok');
        expect(rec.relatedTopics.status).toBe('empty');
        expect(tr).toEqual(['explore:coffee', 'interestOverTime:coffee|TIMESERIES|1', 'relatedSearches:coffee|RELATED_TOPICS|1']);
        expect(rec.status).toBe('partial');
    });

    it('missing TIMESERIES widget -> timeseries SOURCE_CHANGED naming TIMESERIES', async () => {
        const { rec, tr } = await scrape({
            coffee: {
                explore: (n) => {
                    const w = widgetsFor('coffee', n);
                    return { relatedQueries: w.relatedQueries, relatedTopics: w.relatedTopics };
                },
            },
        });
        expect(rec.interestOverTime.status).toBe('failed');
        expect(rec.interestOverTime.error).toMatch(/^SOURCE_CHANGED: .*TIMESERIES/);
        expect(rec.interestOverTime.points).toBeNull();
        expect(tr).not.toContain('interestOverTime:coffee|TIMESERIES|1');
        expect(rec.relatedQueries.status).toBe('ok');
        expect(rec.status).toBe('partial');
    });

    it('missing widget for a disabled section is not an error', async () => {
        const { rec } = await scrape(
            { coffee: { explore: (n) => ({ timeseries: widgetsFor('coffee', n).timeseries }) } },
            { includeRelatedQueries: false, includeRelatedTopics: false },
        );
        expect(rec.relatedQueries.status).toBe('skipped');
        expect(rec.relatedTopics.status).toBe('skipped');
        expect(rec.status).toBe('ok');
    });

    it('timeseries call throws -> only that section failed, later sections still attempted', async () => {
        const err = serverError('widgetdata/multiline');
        const { rec, tr } = await scrape({ coffee: { timeseries: () => Promise.reject(err) } });
        expect(rec.interestOverTime).toEqual({ status: 'failed', error: `HTTP_ERROR: ${err.message}`, resolution: null, points: null });
        expect(rec.relatedQueries.status).toBe('ok');
        expect(rec.relatedTopics.status).toBe('empty');
        expect(tr).toHaveLength(4);
        expect(rec.status).toBe('partial');
    });

    it('related queries call throws -> only that section failed, topics still attempted', async () => {
        const err = new RateLimitedError('widgetdata/relatedsearches');
        const { rec, tr } = await scrape({ coffee: { relatedQueries: () => Promise.reject(err) } });
        expect(rec.relatedQueries).toEqual({ status: 'failed', error: `RATE_LIMITED: ${err.message}`, top: null, rising: null });
        expect(rec.interestOverTime.status).toBe('ok');
        expect(rec.relatedTopics.status).toBe('empty');
        expect(tr[3]).toBe('relatedSearches:coffee|RELATED_TOPICS|1');
        expect(rec.status).toBe('partial');
    });

    it('plain Error from a widget call -> INTERNAL, isolated', async () => {
        const { rec } = await scrape({ coffee: { relatedTopics: () => Promise.reject(new Error('boom')) } });
        expect(rec.relatedTopics).toEqual({ status: 'failed', error: 'INTERNAL: boom', top: null, rising: null });
        expect(rec.status).toBe('partial');
    });

    it('malformed widget data -> that section failed with SOURCE_CHANGED (normalizer error isolated)', async () => {
        const { rec } = await scrape({ coffee: { timeseries: () => ({ nope: true }) } });
        expect(rec.interestOverTime.status).toBe('failed');
        expect(rec.interestOverTime.error).toMatch(/^SOURCE_CHANGED: /);
        expect(rec.relatedQueries.status).toBe('ok');
    });

    it('every requested section failing -> status failed', async () => {
        const { rec } = await scrape(
            { coffee: { timeseries: () => Promise.reject(serverError('m')), relatedQueries: () => Promise.reject(serverError('r')) } },
            { includeRelatedQueries: true, includeRelatedTopics: false },
        );
        expect(rec.status).toBe('failed');
    });
});

describe('scrapeKeyword: 401 / TokenMismatchError', () => {
    it('401 on timeseries -> re-explore once, retry with the fresh widget, later sections use fresh widgets', async () => {
        const err = unauthorized('widgetdata/multiline');
        expect(err).toBeInstanceOf(TokenMismatchError);
        const { rec, tr, fake } = await scrape({
            coffee: { timeseries: (w, n) => (n === 1 ? Promise.reject(err) : TS()) },
        });
        expect(tr).toEqual([
            'explore:coffee',
            'interestOverTime:coffee|TIMESERIES|1',
            'explore:coffee',
            'interestOverTime:coffee|TIMESERIES|2',
            'relatedSearches:coffee|RELATED_QUERIES|2',
            'relatedSearches:coffee|RELATED_TOPICS|2',
        ]);
        expect(fake.calls[2]!.arg).toEqual(Q);
        expect((fake.calls[3]!.arg as Widget).token).not.toBe((fake.calls[1]!.arg as Widget).token);
        expect(rec.interestOverTime.status).toBe('ok');
        expect(rec.status).toBe('ok');
    });

    it('401 on related queries -> re-explore, retried with fresh widget, topics use fresh widget', async () => {
        const { rec, tr } = await scrape({
            coffee: { relatedQueries: (w, n) => (n === 1 ? Promise.reject(unauthorized('widgetdata/relatedsearches')) : RQ()) },
        });
        expect(tr).toEqual([
            'explore:coffee',
            'interestOverTime:coffee|TIMESERIES|1',
            'relatedSearches:coffee|RELATED_QUERIES|1',
            'explore:coffee',
            'relatedSearches:coffee|RELATED_QUERIES|2',
            'relatedSearches:coffee|RELATED_TOPICS|2',
        ]);
        expect(rec.relatedQueries.status).toBe('ok');
        expect(rec.status).toBe('ok');
    });

    it('second 401 on a later section in the same keyword -> failed, no third explore', async () => {
        const { rec, fake } = await scrape({
            coffee: {
                timeseries: (w, n) => (n === 1 ? Promise.reject(unauthorized('widgetdata/multiline')) : TS()),
                relatedQueries: () => Promise.reject(unauthorized('widgetdata/relatedsearches')),
            },
        });
        expect(fake.exploreCount('coffee')).toBe(2);
        expect(rec.interestOverTime.status).toBe('ok');
        expect(rec.relatedQueries.status).toBe('failed');
        expect(rec.relatedQueries.error).toMatch(/^TOKEN_MISMATCH: /);
        expect(trace(fake.calls).filter((t) => t.includes('RELATED_QUERIES'))).toHaveLength(1);
        // topics still attempted, with the fresh widget
        expect(trace(fake.calls).at(-1)).toBe('relatedSearches:coffee|RELATED_TOPICS|2');
        expect(rec.relatedTopics.status).toBe('empty');
        expect(rec.status).toBe('partial');
    });

    it('401 twice on the same section -> failed after exactly 2 explores', async () => {
        const { rec, fake, tr } = await scrape({
            coffee: { timeseries: () => Promise.reject(unauthorized('widgetdata/multiline')) },
        });
        expect(fake.exploreCount('coffee')).toBe(2);
        expect(tr.filter((t) => t.startsWith('interestOverTime'))).toEqual([
            'interestOverTime:coffee|TIMESERIES|1',
            'interestOverTime:coffee|TIMESERIES|2',
        ]);
        expect(rec.interestOverTime.status).toBe('failed');
        expect(rec.interestOverTime.error).toMatch(/^TOKEN_MISMATCH: /);
        expect(rec.relatedQueries.status).toBe('ok');
        expect(rec.status).toBe('partial');
    });

    it("re-explore throwing -> section failed with the re-explore's error; later sections keep original widgets", async () => {
        const reErr = new RateLimitedError('explore');
        const { rec, fake, tr } = await scrape({
            coffee: {
                explore: (n) => (n === 1 ? widgetsFor('coffee', 1) : Promise.reject(reErr)),
                timeseries: (w, n) => (n === 1 ? Promise.reject(unauthorized('widgetdata/multiline')) : TS()),
            },
        });
        expect(fake.exploreCount('coffee')).toBe(2);
        expect(tr.filter((t) => t.startsWith('interestOverTime'))).toHaveLength(1);
        expect(rec.interestOverTime).toEqual({ status: 'failed', error: `RATE_LIMITED: ${reErr.message}`, resolution: null, points: null });
        expect(tr.slice(3)).toEqual(['relatedSearches:coffee|RELATED_QUERIES|1', 'relatedSearches:coffee|RELATED_TOPICS|1']);
        expect(rec.relatedQueries.status).toBe('ok');
        expect(rec.status).toBe('partial');
    });

    it('re-explore throwing, then 401 on a later section -> failed, explore called exactly 2 times', async () => {
        const { rec, fake } = await scrape({
            coffee: {
                explore: (n) => (n === 1 ? widgetsFor('coffee', 1) : Promise.reject(new RateLimitedError('explore'))),
                timeseries: () => Promise.reject(unauthorized('widgetdata/multiline')),
                relatedQueries: () => Promise.reject(unauthorized('widgetdata/relatedsearches')),
            },
        });
        expect(fake.exploreCount('coffee')).toBe(2);
        expect(rec.interestOverTime.error).toMatch(/^RATE_LIMITED: /);
        expect(rec.relatedQueries.status).toBe('failed');
        expect(rec.relatedQueries.error).toMatch(/^TOKEN_MISMATCH: /);
        expect(trace(fake.calls).filter((t) => t.includes('RELATED_QUERIES'))).toEqual(['relatedSearches:coffee|RELATED_QUERIES|1']);
        expect(rec.relatedTopics.status).toBe('empty');
        expect(rec.status).toBe('partial');
    });
});

describe('scrapeKeyword: record', () => {
    it('carries keyword/geo/timeRange/category from the query; status = rollup', async () => {
        const query: Query = { keyword: 'Taylor Swift', geo: 'US-CA', timeRange: '2024-01-01 2024-06-30', category: 71 };
        const { rec, fake } = await scrape({}, ALL, query);
        expect(fake.calls[0]!.arg).toEqual(query);
        expect(rec.keyword).toBe('Taylor Swift');
        expect(rec.geo).toBe('US-CA');
        expect(rec.timeRange).toBe('2024-01-01 2024-06-30');
        expect(rec.category).toBe(71);
        expect(rec.status).toBe('ok');
    });

    it('all sections empty -> status ok (no data is a result)', async () => {
        const { rec } = await scrape({
            coffee: { timeseries: () => widgetDataLocal('multiline-nonexistent-empty.txt'), relatedQueries: () => RELATED_EMPTY() },
        });
        expect(rec.interestOverTime.status).toBe('empty');
        expect(rec.relatedQueries.status).toBe('empty');
        expect(rec.status).toBe('ok');
    });
});

// ---------------------------------------------------------------- runActor

interface Harness {
    deps: RunDeps;
    pushed: Rec[];
    outputs: unknown[];
    nowValues: Date[];
    log: ReturnType<typeof makeLog>;
    fake: ReturnType<typeof makeFakeApi>;
}

function harness(scripts: Record<string, KeywordScript>, opts: { pushData?: (r: unknown) => Promise<void>; tickMs?: number } = {}): Harness {
    const fake = makeFakeApi(scripts);
    const pushed: Rec[] = [];
    const outputs: unknown[] = [];
    const nowValues: Date[] = [];
    const log = makeLog();
    let t = NOW.getTime();
    const deps = {
        client: fake.api,
        pushData: async (r: unknown) => {
            if (opts.pushData) await opts.pushData(r);
            pushed.push(r as Rec);
        },
        setOutput: async (s: unknown) => {
            outputs.push(s);
        },
        now: () => {
            const d = new Date(t);
            t += opts.tickMs ?? 1000;
            nowValues.push(d);
            return d;
        },
        log: log.log,
    } as unknown as RunDeps;
    return { deps, pushed, outputs, nowValues, log, fake };
}

const input = (extra: Record<string, unknown> = {}): ValidatedInput =>
    parseInput({ keywords: ['alpha', 'beta', 'gamma'], geo: 'us', includeRelatedTopics: true, ...extra }, NOW);

/** alpha ok, beta partial (queries fail), gamma failed (explore rate-limited). */
const GATE_SCRIPTS: Record<string, KeywordScript> = {
    beta: { relatedQueries: () => Promise.reject(serverError('widgetdata/relatedsearches')) },
    gamma: { explore: () => Promise.reject(new RateLimitedError('explore')) },
};

const iso = (v: unknown): string => new Date(v as string).toISOString();

describe('runActor: gate (ok / partial / failed)', () => {
    it('pushes 3 schema-valid records in input order with the right statuses and summary', async () => {
        const h = harness(GATE_SCRIPTS);
        const summary: RunSummary = await runActor(input(), h.deps);

        expect(h.pushed.map((r) => r.keyword)).toEqual(['alpha', 'beta', 'gamma']);
        expect(h.pushed.map((r) => r.status)).toEqual(['ok', 'partial', 'failed']);
        for (const r of h.pushed) {
            expect(schemaErrors(r), r.keyword as string).toBe('');
            expect(r.geo).toBe('US');
            expect(r.timeRange).toBe('today 12-m');
            expect(r.category).toBe(0);
        }

        // scrapedAt comes from the injected clock, strictly increasing per keyword
        const nowIsos = h.nowValues.map((d) => d.toISOString());
        const scraped = h.pushed.map((r) => r.scrapedAt as string);
        for (const s of scraped) expect(nowIsos).toContain(s);
        expect([...scraped].sort()).toEqual(scraped);
        expect(new Set(scraped).size).toBe(3);

        // explore received queries built from the input
        expect(h.fake.calls.filter((c) => c.method === 'explore').map((c) => c.arg)).toEqual([
            { keyword: 'alpha', geo: 'US', timeRange: 'today 12-m', category: 0 },
            { keyword: 'beta', geo: 'US', timeRange: 'today 12-m', category: 0 },
            { keyword: 'gamma', geo: 'US', timeRange: 'today 12-m', category: 0 },
        ]);

        expect(h.outputs).toHaveLength(1);
        expect(h.outputs[0]).toEqual(summary);

        const s = summary as unknown as Record<string, unknown>;
        expect(s.keywords).toBe(3);
        expect(s.ok).toBe(1);
        expect(s.partial).toBe(1);
        expect(s.failed).toBe(1);
        expect(s.sections).toEqual({
            interestOverTime: { ok: 2, empty: 0, failed: 1, skipped: 0 },
            relatedQueries: { ok: 1, empty: 0, failed: 2, skipped: 0 },
            relatedTopics: { ok: 0, empty: 2, failed: 1, skipped: 0 },
        });

        // startedAt / finishedAt / durationMs from the injected clock
        expect(typeof s.startedAt).toBe('string');
        expect(typeof s.finishedAt).toBe('string');
        expect(s.startedAt).toBe(nowIsos[0]);
        expect(s.finishedAt).toBe(nowIsos.at(-1));
        expect(iso(s.startedAt)).toBe(nowIsos[0]);
        expect(iso(s.finishedAt)).toBe(nowIsos.at(-1));
        expect(iso(s.startedAt) <= scraped[0]!).toBe(true);
        expect(iso(s.finishedAt) >= scraped[2]!).toBe(true);
        expect(s.durationMs).toBe(new Date(iso(s.finishedAt)).getTime() - new Date(iso(s.startedAt)).getTime());
    });

    it('with a constant clock: scrapedAt equals now().toISOString() and durationMs is 0', async () => {
        const h = harness(GATE_SCRIPTS, { tickMs: 0 });
        const summary = (await runActor(input(), h.deps)) as unknown as Record<string, unknown>;
        for (const r of h.pushed) expect(r.scrapedAt).toBe(NOW.toISOString());
        expect(iso(summary.startedAt)).toBe(NOW.toISOString());
        expect(iso(summary.finishedAt)).toBe(NOW.toISOString());
        expect(summary.durationMs).toBe(0);
    });

    it('disabled sections are counted as skipped', async () => {
        const h = harness({});
        const summary = (await runActor(input({ includeRelatedTopics: false, includeRelatedQueries: false }), h.deps)) as unknown as Record<
            string,
            unknown
        >;
        expect(summary.sections).toEqual({
            interestOverTime: { ok: 3, empty: 0, failed: 0, skipped: 0 },
            relatedQueries: { ok: 0, empty: 0, failed: 0, skipped: 3 },
            relatedTopics: { ok: 0, empty: 0, failed: 0, skipped: 3 },
        });
        expect(summary.ok).toBe(3);
        expect(h.fake.calls.filter((c) => c.method === 'relatedSearches')).toHaveLength(0);
    });

    it('pushes each record before the next keyword starts', async () => {
        const order: string[] = [];
        const h = harness({}, {
            pushData: async (r) => {
                order.push(`push:${(r as Rec).keyword as string}`);
            },
        });
        const origExplore = h.fake.api.explore.bind(h.fake.api);
        (h.fake.api as { explore: unknown }).explore = (q: Query) => {
            order.push(`explore:${q.keyword}`);
            return origExplore(q as never);
        };
        await runActor(input(), h.deps);
        expect(order).toEqual(['explore:alpha', 'push:alpha', 'explore:beta', 'push:beta', 'explore:gamma', 'push:gamma']);
    });
});

describe('runActor: isolation and errors', () => {
    it('a keyword failing (even with a plain Error) never stops the run', async () => {
        const h = harness({
            alpha: { explore: () => Promise.reject(new Error('kaboom')) },
            beta: { timeseries: () => Promise.reject(new Error('x')), relatedQueries: () => Promise.reject(new Error('y')), relatedTopics: () => Promise.reject(new Error('z')) },
        });
        const summary = (await runActor(input(), h.deps)) as unknown as Record<string, unknown>;
        expect(h.pushed.map((r) => [r.keyword, r.status])).toEqual([
            ['alpha', 'failed'],
            ['beta', 'failed'],
            ['gamma', 'ok'],
        ]);
        expect(h.pushed[0]!.interestOverTime.error).toBe('INTERNAL: kaboom');
        expect(summary.failed).toBe(2);
        expect(summary.ok).toBe(1);
        for (const r of h.pushed) expect(schemaErrors(r)).toBe('');
    });

    it('pushData throwing propagates; later keywords are not processed', async () => {
        const boom = new Error('dataset write failed');
        let n = 0;
        const h = harness({}, {
            pushData: async () => {
                n++;
                if (n === 2) throw boom;
            },
        });
        await expect(runActor(input(), h.deps)).rejects.toBe(boom);
        expect(h.fake.calls.filter((c) => c.method === 'explore').map((c) => (c.arg as Query).keyword)).toEqual(['alpha', 'beta']);
        expect(h.pushed.map((r) => r.keyword)).toEqual(['alpha']);
        expect(h.outputs).toHaveLength(0);
    });
});

describe('runActor: logs', () => {
    const text = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

    it('one log line per keyword, mentioning the keyword and its status', async () => {
        const h = harness(GATE_SCRIPTS);
        await runActor(input(), h.deps);
        const lines = h.log.entries.filter((e) => e.level !== 'debug');
        for (const [kw, status] of [
            ['alpha', 'ok'],
            ['beta', 'partial'],
            ['gamma', 'failed'],
        ] as const) {
            const mine = lines.filter((e) => text(e.args).includes(kw));
            expect(mine, `${kw}: ${JSON.stringify(mine)}`).toHaveLength(1);
            expect(mine[0]!.level).toBe({ ok: 'info', partial: 'warning', failed: 'error' }[status]);
            expect(text(mine[0]!.args)).toContain(status);
        }
    });

    it('no log line, record or summary contains the proxy URL or its password', async () => {
        const h = harness(GATE_SCRIPTS);
        const inp = input({ proxyConfiguration: { proxyUrls: ['http://u:secret@p:1'] } });
        expect(inp.proxyConfiguration).toEqual({ proxyUrls: ['http://u:secret@p:1'] });
        const summary = await runActor(inp, h.deps);
        const all = JSON.stringify({ logs: h.log.entries, pushed: h.pushed, outputs: h.outputs, summary });
        expect(all).not.toContain('secret');
        expect(all).not.toContain('u:secret@p:1');
    });
});


// ---------------------------------------------------------------- Part 7: circuit breaker + log error key

const ABORTED_MSG = 'ABORTED: not requested: the run stopped after 3 failed keywords in a row';
const FAIL: KeywordScript = { explore: () => Promise.reject(new RateLimitedError('explore')) };
const PARTIAL: KeywordScript = { relatedQueries: () => Promise.reject(serverError('widgetdata/relatedsearches')) };
const kwInput = (keywords: string[], extra: Record<string, unknown> = {}): ValidatedInput =>
    parseInput({ keywords, includeRelatedQueries: true, includeRelatedTopics: false, ...extra }, NOW);
const explored = (h: Harness): string[] => h.fake.calls.filter((c) => c.method === 'explore').map((c) => (c.arg as Query).keyword);
const logText = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

describe('runActor: circuit breaker (Part 7)', () => {
    it('MAX_CONSECUTIVE_FAILED_KEYWORDS is 3', () => {
        expect(MAX_CONSECUTIVE_FAILED_KEYWORDS).toBe(3);
    });

    it('RunAbortedError has code ABORTED and is not retryable', () => {
        const Ctor = RunAbortedError as unknown as new (...a: unknown[]) => TrendsError;
        const e = new Ctor('stopped');
        expect(e).toBeInstanceOf(TrendsError);
        expect(e.code).toBe('ABORTED');
        expect(e.retryable).toBe(false);
    });

    it('3 failed in a row -> remaining keywords not requested, ABORTED records pushed in order', async () => {
        const kws = ['kw-a', 'kw-b', 'kw-c', 'kw-d', 'kw-e', 'kw-f', 'kw-g'];
        const h = harness({ 'kw-a': FAIL, 'kw-b': FAIL, 'kw-c': FAIL });
        const summary = (await runActor(kwInput(kws), h.deps)) as unknown as Record<string, unknown>;

        expect(explored(h)).toEqual(['kw-a', 'kw-b', 'kw-c']);
        expect(h.fake.calls.every((c) => c.method === 'explore')).toBe(true);
        expect(h.pushed.map((r) => r.keyword)).toEqual(kws);
        for (const r of h.pushed.slice(3)) {
            expect(r.status).toBe('failed');
            expect(r.interestOverTime).toEqual({ status: 'failed', error: ABORTED_MSG, resolution: null, points: null });
            expect(r.relatedQueries).toEqual({ status: 'failed', error: ABORTED_MSG, top: null, rising: null });
            expect(r.relatedTopics).toEqual({ status: 'skipped', top: null, rising: null });
            expect(schemaErrors(r)).toBe('');
        }
        expect(summary.aborted).toBe(true);
        expect(summary.keywords).toBe(7);
        expect(summary.failed).toBe(7);
        expect(summary.ok).toBe(0);
        expect(summary.partial).toBe(0);
        expect(summary.sections).toEqual({
            interestOverTime: { ok: 0, empty: 0, failed: 7, skipped: 0 },
            relatedQueries: { ok: 0, empty: 0, failed: 7, skipped: 0 },
            relatedTopics: { ok: 0, empty: 0, failed: 0, skipped: 7 },
        });
        expect(h.outputs).toEqual([summary]);

        const breaker = h.log.entries.filter((e) => e.level === 'error' && typeof e.args[0] === 'string' && !e.args[0].includes('kw-') && /skip/i.test(e.args[0]));
        expect(breaker, JSON.stringify(h.log.entries)).toHaveLength(1);
        expect(logText(breaker[0]!.args)).toMatch(/\b4\b/);
    });

    it('breaker trips after an ok keyword too (only consecutive failures count)', async () => {
        const h = harness({ 'kw-b': FAIL, 'kw-c': FAIL, 'kw-d': FAIL });
        const summary = (await runActor(kwInput(['kw-a', 'kw-b', 'kw-c', 'kw-d', 'kw-e']), h.deps)) as unknown as Record<string, unknown>;
        expect(explored(h)).toEqual(['kw-a', 'kw-b', 'kw-c', 'kw-d']);
        expect(h.pushed.map((r) => r.status)).toEqual(['ok', 'failed', 'failed', 'failed', 'failed']);
        expect(h.pushed[4]!.interestOverTime.error).toBe(ABORTED_MSG);
        expect(summary.aborted).toBe(true);
        expect(summary.ok).toBe(1);
        expect(summary.failed).toBe(4);
    });

    it('an ok keyword resets the count', async () => {
        const h = harness({ 'kw-a': FAIL, 'kw-b': FAIL, 'kw-d': FAIL, 'kw-e': FAIL });
        const kws = ['kw-a', 'kw-b', 'kw-c', 'kw-d', 'kw-e', 'kw-f'];
        const summary = (await runActor(kwInput(kws), h.deps)) as unknown as Record<string, unknown>;
        expect(explored(h)).toEqual(kws);
        expect(summary.aborted).toBe(false);
        expect(JSON.stringify(h.pushed)).not.toContain('ABORTED');
    });

    it('a partial keyword resets the count', async () => {
        const h = harness({ 'kw-a': FAIL, 'kw-b': FAIL, 'kw-c': PARTIAL, 'kw-d': FAIL, 'kw-e': FAIL });
        const kws = ['kw-a', 'kw-b', 'kw-c', 'kw-d', 'kw-e', 'kw-f'];
        const summary = (await runActor(kwInput(kws), h.deps)) as unknown as Record<string, unknown>;
        expect(explored(h)).toEqual(kws);
        expect(h.pushed.map((r) => r.status)).toEqual(['failed', 'failed', 'partial', 'failed', 'failed', 'ok']);
        expect(summary.aborted).toBe(false);
    });

    it('third failure on the last keyword -> nothing aborted, aborted false', async () => {
        const h = harness({ 'kw-b': FAIL, 'kw-c': FAIL, 'kw-d': FAIL });
        const summary = (await runActor(kwInput(['kw-a', 'kw-b', 'kw-c', 'kw-d']), h.deps)) as unknown as Record<string, unknown>;
        expect(explored(h)).toEqual(['kw-a', 'kw-b', 'kw-c', 'kw-d']);
        expect(summary.aborted).toBe(false);
        expect(JSON.stringify(h.pushed)).not.toContain('ABORTED');
        expect(h.log.entries.filter((e) => e.level === 'error' && typeof e.args[0] === 'string' && !e.args[0].includes('kw-') && /skip/i.test(e.args[0]))).toHaveLength(0);
    });

    it('failures from widget errors (not explore) also count', async () => {
        const allFail: KeywordScript = {
            timeseries: () => Promise.reject(serverError('m')),
            relatedQueries: () => Promise.reject(serverError('r')),
        };
        const h = harness({ 'kw-a': allFail, 'kw-b': allFail, 'kw-c': allFail });
        const summary = (await runActor(kwInput(['kw-a', 'kw-b', 'kw-c', 'kw-d']), h.deps)) as unknown as Record<string, unknown>;
        expect(explored(h)).toEqual(['kw-a', 'kw-b', 'kw-c']);
        expect(summary.aborted).toBe(true);
    });

    it('summary.aborted is false on a normal run', async () => {
        const h = harness(GATE_SCRIPTS);
        const summary = (await runActor(input(), h.deps)) as unknown as Record<string, unknown>;
        expect(summary.aborted).toBe(false);
    });
});

describe('runActor: keyword log line error key (Part 7)', () => {
    const dataOf = (args: unknown[]): Record<string, unknown> | undefined =>
        args.find((a): a is Record<string, unknown> => typeof a === 'object' && a !== null);

    it('partial/failed lines carry the first section error; ok lines have no error key', async () => {
        const h = harness({
            ...GATE_SCRIPTS,
            // gamma: explore ok, every section fails -> first error is interestOverTime's
            gamma: {
                timeseries: () => Promise.reject(serverError('widgetdata/multiline')),
                relatedQueries: () => Promise.reject(new RateLimitedError('r')),
                relatedTopics: () => Promise.reject(new Error('z')),
            },
        });
        await runActor(input(), h.deps);
        const byKw = (kw: string) => {
            const lines = h.log.entries.filter((e) => e.level !== 'debug' && logText(e.args).includes(kw));
            expect(lines, kw).toHaveLength(1);
            return lines[0]!;
        };
        const [alpha, beta, gamma] = h.pushed;
        expect([alpha!.status, beta!.status, gamma!.status]).toEqual(['ok', 'partial', 'failed']);

        const a = dataOf(byKw('alpha').args);
        expect(a === undefined || !('error' in a)).toBe(true);

        const b = dataOf(byKw('beta').args);
        expect(b?.error).toBe(beta!.relatedQueries.error);

        const g = dataOf(byKw('gamma').args);
        expect(g?.error).toBe(gamma!.interestOverTime.error);
        expect(String(g?.error)).toMatch(/^HTTP_ERROR: /);
    });

    it('partial keyword whose only failure is a later section uses that section error', async () => {
        const h = harness({ 'kw-a': { relatedTopics: () => Promise.reject(new Error('t-fail')) } });
        await runActor(kwInput(['kw-a'], { includeRelatedTopics: true }), h.deps);
        const line = h.log.entries.find((e) => logText(e.args).includes('kw-a'))!;
        expect(line.level).toBe('warning');
        expect(dataOf(line.args)?.error).toBe('INTERNAL: t-fail');
    });
});
