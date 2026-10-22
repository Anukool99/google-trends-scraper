// Tests written from IMPLEMENTATION_PLAN.md §4 "Output schema" and §6 "Part 4 contract", not from the implementation.
import { describe, expect, it } from 'vitest';
import {
    failedSection,
    failedTimeline,
    normalizeRelated,
    normalizeTimeline,
    rollupStatus,
    skippedSection,
    skippedTimeline,
} from '../src/normalize.js';
import { RateLimitedError, SourceChangedError } from '../src/trends/errors.js';
import { fixtureJson } from './helpers/fake-fetch.js';

/** The client returns the parsed `default` object, so that is what the normalizer receives. */
const widgetData = (name: string): unknown => (fixtureJson(name) as { default: unknown }).default;

const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

const point = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    time: '1760832000',
    formattedTime: 'Oct 19 – 25, 2025',
    formattedAxisTime: 'Oct 19, 2025',
    value: [65],
    hasData: [true],
    formattedValue: ['65'],
    ...over,
});

describe('normalizeTimeline: fixtures', () => {
    it('weekly: 53 points, resolution week, first/last points, isPartial only on last', () => {
        const t = normalizeTimeline(widgetData('multiline-weekly-ok.txt'), { resolution: 'WEEK' });
        expect(t.status).toBe('ok');
        expect(t.resolution).toBe('week');
        expect(t.points).toHaveLength(53);
        const pts = t.points!;
        // The fixture uses U+2009 (thin space) around the en dash; every Zs space becomes a plain space.
        expect(pts[0]).toEqual({ date: iso(1760832000), label: 'Oct 19 – 25, 2025', interest: 65, isPartial: false });
        expect(pts[0]!.date).toBe('2025-10-19T00:00:00.000Z');
        expect(pts[52]).toEqual({ date: iso(1792281600), label: 'Oct 18 – 24, 2026', interest: 64, isPartial: true });
        expect(pts.filter((p) => p.isPartial).length).toBe(1);
        for (const p of pts) expect(p.label).not.toMatch(/(?! )\p{Zs}/u);
        expect(pts.every((p) => typeof p.interest === 'number')).toBe(true);
    });

    it('hourly: 169 points, resolution hour, U+202F in labels replaced with a normal space', () => {
        const t = normalizeTimeline(widgetData('multiline-hourly-ok.txt'), { resolution: 'HOUR' });
        expect(t.status).toBe('ok');
        expect(t.resolution).toBe('hour');
        const pts = t.points!;
        expect(pts).toHaveLength(169);
        expect(pts[0]).toEqual({ date: iso(1792069200), label: 'Oct 15, 2026 at 1:00 PM', interest: 59, isPartial: false });
        expect(pts[168]).toEqual({ date: iso(1792674000), label: 'Oct 22, 2026 at 1:00 PM', interest: 60, isPartial: true });
        expect(pts.filter((p) => p.isPartial).map((_, i) => i)).toHaveLength(1);
        expect(pts[168]!.isPartial).toBe(true);
        for (const p of pts) expect(p.label).not.toMatch(/[\u202F\u00A0]/);
        // hourly points are 3600 s apart
        expect(Date.parse(pts[1]!.date) - Date.parse(pts[0]!.date)).toBe(3_600_000);
    });

    it('daily custom range: 182 points, resolution day, no partial points', () => {
        const t = normalizeTimeline(widgetData('multiline-daily-custom-range-ok.txt'), { resolution: 'DAY' });
        expect(t.status).toBe('ok');
        expect(t.resolution).toBe('day');
        const pts = t.points!;
        expect(pts).toHaveLength(182);
        expect(pts[0]).toEqual({ date: '2024-01-01T00:00:00.000Z', label: 'Jan 1, 2024', interest: 90, isPartial: false });
        expect(pts[181]).toEqual({ date: '2024-06-30T00:00:00.000Z', label: 'Jun 30, 2024', interest: 93, isPartial: false });
        expect(pts.some((p) => p.isPartial)).toBe(false);
    });

    it('nonexistent term: empty timelineData -> status empty, points []', () => {
        const t = normalizeTimeline(widgetData('multiline-nonexistent-empty.txt'), { resolution: 'WEEK' });
        expect(t.status).toBe('empty');
        expect(t.points).toEqual([]);
        expect(t.resolution).toBe('week');
        expect(t).not.toHaveProperty('error');
    });

    it('nonexistent hourly: hasData:false -> interest null; 2 noise points keep values; status ok', () => {
        const t = normalizeTimeline(widgetData('multiline-nonexistent-hourly-nodata.txt'), { resolution: 'HOUR' });
        const pts = t.points!;
        expect(pts).toHaveLength(169);
        expect(pts.filter((p) => p.interest === null)).toHaveLength(167);
        expect(pts[52]!.interest).toBe(100);
        expect(pts[122]!.interest).toBe(79);
        expect(pts[0]).toEqual({ date: iso(1792069200), label: 'Oct 15, 2026 at 1:00 PM', interest: null, isPartial: false });
        expect(pts[168]).toEqual({ date: iso(1792674000), label: 'Oct 22, 2026 at 1:00 PM', interest: null, isPartial: true });
        // Some point has data, so this is not "empty".
        expect(t.status).toBe('ok');
    });
});

describe('normalizeTimeline: rules', () => {
    it('missing resolution -> null; other values lower-cased (MINUTE, MONTH)', () => {
        const data = { timelineData: [point()] };
        expect(normalizeTimeline(data, {}).resolution).toBeNull();
        expect(normalizeTimeline(data, { resolution: 'MINUTE' }).resolution).toBe('minute');
        expect(normalizeTimeline(data, { resolution: 'MONTH' }).resolution).toBe('month');
    });

    it('no point has data -> status empty, but all-null points are kept', () => {
        const data = {
            timelineData: [
                point({ time: '1000', value: [0], hasData: [false] }),
                point({ time: '2000', value: [0], hasData: [false], isPartial: true }),
            ],
        };
        const t = normalizeTimeline(data, { resolution: 'DAY' });
        expect(t.status).toBe('empty');
        expect(t.points).toEqual([
            { date: iso(1000), label: 'Oct 19 – 25, 2025', interest: null, isPartial: false },
            { date: iso(2000), label: 'Oct 19 – 25, 2025', interest: null, isPartial: true },
        ]);
    });

    it('numeric time accepted as well as numeric string; date derived from time not formattedTime', () => {
        const t = normalizeTimeline({ timelineData: [point({ time: 1704067200, formattedTime: 'Totally Wrong' })] }, {});
        expect(t.points![0]!.date).toBe('2024-01-01T00:00:00.000Z');
        expect(t.points![0]!.label).toBe('Totally Wrong');
    });

    it('U+202F and U+00A0 in formattedTime become normal spaces', () => {
        const t = normalizeTimeline({ timelineData: [point({ formattedTime: 'Oct 15,\u00A02026 at 1:00\u202FPM' })] }, {});
        expect(t.points![0]!.label).toBe('Oct 15, 2026 at 1:00 PM');
    });

    it('every Unicode space separator (U+2009, U+2007, U+3000, U+2002) becomes a normal space', () => {
        const t = normalizeTimeline({ timelineData: [point({ formattedTime: 'a\u2009b\u2007c\u3000d\u2002e f' })] }, {});
        expect(t.points![0]!.label).toBe('a b c d e f');
    });

    it('isPartial is strictly === true (truthy non-true values -> false)', () => {
        const t = normalizeTimeline(
            { timelineData: [point({ isPartial: 'true' }), point({ isPartial: 1 }), point({ isPartial: true })] },
            {},
        );
        expect(t.points!.map((p) => p.isPartial)).toEqual([false, false, true]);
    });

    it('interest = value[0] when hasData is absent or true', () => {
        const pt = point({ value: [42] });
        delete pt.hasData;
        const t = normalizeTimeline({ timelineData: [pt, point({ value: [7], hasData: [true] })] }, {});
        expect(t.points!.map((p) => p.interest)).toEqual([42, 7]);
        expect(t.status).toBe('ok');
    });
});

describe('normalizeTimeline: malformed -> SourceChangedError', () => {
    const cases: [string, unknown][] = [
        ['null data', null],
        ['non-object data (string)', 'nope'],
        ['non-object data (number)', 5],
        ['no timelineData', { averages: [] }],
        ['timelineData not an array', { timelineData: {} }],
        ['non-numeric string time', { timelineData: [point({ time: 'abc' })] }],
        ['missing time', { timelineData: [point({ time: undefined })] }],
        ['time is an object', { timelineData: [point({ time: {} })] }],
        ['value not an array', { timelineData: [point({ value: 5 })] }],
        ['value[0] not a number', { timelineData: [point({ value: ['65'] })] }],
        ['value empty array', { timelineData: [point({ value: [] })] }],
        ['point is null', { timelineData: [null] }],
    ];
    for (const [name, data] of cases) {
        it(name, () => {
            expect(() => normalizeTimeline(data as never, { resolution: 'WEEK' })).toThrow(SourceChangedError);
        });
    }
});

describe('normalizeRelated: queries fixtures', () => {
    it('queries-ok: 25 top / 25 rising, mapping, links absolutized', () => {
        const r = normalizeRelated(widgetData('relatedsearches-queries-ok.txt'), 'queries');
        expect(r.status).toBe('ok');
        expect(r.top).toHaveLength(25);
        expect(r.rising).toHaveLength(25);
        expect(r.top![0]).toEqual({
            query: 'taylor swift wedding',
            value: 100,
            formattedValue: '100',
            link: 'https://trends.google.com/trends/explore?q=taylor+swift+wedding&date=today+12-m&geo=US',
            isBreakout: false,
        });
        expect(r.top![24]).toEqual({
            query: 'taylor swift albums',
            value: 9,
            formattedValue: '9',
            link: 'https://trends.google.com/trends/explore?q=taylor+swift+albums&date=today+12-m&geo=US',
            isBreakout: false,
        });
        expect(r.rising![0]).toEqual({
            query: 'patient zero',
            value: 91000,
            formattedValue: 'Breakout',
            link: 'https://trends.google.com/trends/explore?q=patient+zero&date=today+12-m&geo=US',
            isBreakout: true,
        });
        expect(r.rising![24]).toEqual({
            query: 'taylor swift opalite music video',
            value: 2450,
            formattedValue: '+2,450%',
            link: 'https://trends.google.com/trends/explore?q=taylor+swift+opalite+music+video&date=today+12-m&geo=US',
            isBreakout: false,
        });
        for (const item of [...r.top!, ...r.rising!]) {
            expect(item.link).toMatch(/^https:\/\/trends\.google\.com\/trends\//);
        }
    });

    it('queries-ok: isBreakout true for exactly the 14 "Breakout" rising items, never on top', () => {
        const r = normalizeRelated(widgetData('relatedsearches-queries-ok.txt'), 'queries');
        const breakouts = r.rising!.filter((q) => q.isBreakout);
        expect(breakouts).toHaveLength(14);
        expect(breakouts.every((q) => q.formattedValue === 'Breakout')).toBe(true);
        expect(r.rising!.filter((q) => q.formattedValue === 'Breakout')).toHaveLength(14);
        expect(r.top!.some((q) => q.isBreakout)).toBe(false);
    });

    it('queries-empty-lists: two empty rankedKeyword -> status empty, [] lists', () => {
        const r = normalizeRelated(widgetData('relatedsearches-queries-empty-lists.txt'), 'queries');
        expect(r).toEqual({ status: 'empty', top: [], rising: [] });
    });

    it('relatedsearches-empty (rankedList []) -> status empty for queries and topics', () => {
        const data = widgetData('relatedsearches-empty.txt');
        expect(normalizeRelated(data, 'queries')).toEqual({ status: 'empty', top: [], rising: [] });
        expect(normalizeRelated(data, 'topics')).toEqual({ status: 'empty', top: [], rising: [] });
    });
});

describe('normalizeRelated: rules', () => {
    const q = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        query: 'x',
        value: 50,
        formattedValue: '50',
        link: '/trends/explore?q=x',
        ...over,
    });

    it('missing link -> null', () => {
        const item = q();
        delete item.link;
        const r = normalizeRelated({ rankedList: [{ rankedKeyword: [item] }, { rankedKeyword: [] }] }, 'queries');
        expect(r.top![0]!.link).toBeNull();
    });

    it('"Breakout" on a top item still yields isBreakout false', () => {
        const r = normalizeRelated(
            { rankedList: [{ rankedKeyword: [q({ formattedValue: 'Breakout' })] }, { rankedKeyword: [] }] },
            'queries',
        );
        expect(r.top![0]!.isBreakout).toBe(false);
    });

    it('only one list non-empty -> status ok', () => {
        const r = normalizeRelated({ rankedList: [{ rankedKeyword: [] }, { rankedKeyword: [q()] }] }, 'queries');
        expect(r.status).toBe('ok');
        expect(r.top).toEqual([]);
        expect(r.rising).toHaveLength(1);
    });

    it('topic items (synthetic, unverified shape) map from item.topic', () => {
        const topTopic = {
            topic: { mid: '/m/02vqfm', title: 'Coffee', type: 'Drink' },
            value: 100,
            formattedValue: '100',
            link: '/trends/explore?q=/m/02vqfm',
        };
        const risingTopic = {
            topic: { mid: '/m/0abc', title: 'Cold brew', type: 'Topic' },
            value: 5000,
            formattedValue: 'Breakout',
        };
        const r = normalizeRelated({ rankedList: [{ rankedKeyword: [topTopic] }, { rankedKeyword: [risingTopic] }] }, 'topics');
        expect(r.status).toBe('ok');
        expect(r.top).toEqual([
            {
                mid: '/m/02vqfm',
                title: 'Coffee',
                type: 'Drink',
                value: 100,
                formattedValue: '100',
                link: 'https://trends.google.com/trends/explore?q=/m/02vqfm',
                isBreakout: false,
            },
        ]);
        expect(r.rising).toEqual([
            {
                mid: '/m/0abc',
                title: 'Cold brew',
                type: 'Topic',
                value: 5000,
                formattedValue: 'Breakout',
                link: null,
                isBreakout: true,
            },
        ]);
    });

    it('topic item without type -> type ""', () => {
        const r = normalizeRelated(
            { rankedList: [{ rankedKeyword: [{ topic: { mid: '/m/1', title: 'T' }, value: 3, formattedValue: '3' }] }, { rankedKeyword: [] }] },
            'topics',
        );
        expect(r.top![0]).toEqual({ mid: '/m/1', title: 'T', type: '', value: 3, formattedValue: '3', link: null, isBreakout: false });
    });

    it('topic item missing mid or title -> SourceChangedError', () => {
        const noMid = { topic: { title: 'Coffee', type: 'Drink' }, value: 1, formattedValue: '1' };
        const noTitle = { topic: { mid: '/m/1', type: 'Drink' }, value: 1, formattedValue: '1' };
        const noTopic = { value: 1, formattedValue: '1' };
        for (const bad of [noMid, noTitle, noTopic]) {
            expect(() => normalizeRelated({ rankedList: [{ rankedKeyword: [bad] }, { rankedKeyword: [] }] }, 'topics')).toThrow(
                SourceChangedError,
            );
        }
    });
});

describe('normalizeRelated: malformed -> SourceChangedError', () => {
    const one = { rankedKeyword: [] };
    const cases: [string, unknown][] = [
        ['null data', null],
        ['non-object data', 'nope'],
        ['no rankedList', {}],
        ['rankedList not an array', { rankedList: {} }],
        ['rankedList of length 1', { rankedList: [one] }],
        ['rankedList of length 3', { rankedList: [one, one, one] }],
        ['entry without rankedKeyword', { rankedList: [one, {}] }],
        ['rankedKeyword not an array', { rankedList: [one, { rankedKeyword: 'x' }] }],
        ['query not a string', { rankedList: [{ rankedKeyword: [{ query: 5, value: 1, formattedValue: '1' }] }, one] }],
        ['value not a number', { rankedList: [{ rankedKeyword: [{ query: 'x', value: '1', formattedValue: '1' }] }, one] }],
        ['rising item value missing', { rankedList: [one, { rankedKeyword: [{ query: 'x', formattedValue: '1' }] }] }],
    ];
    for (const [name, data] of cases) {
        it(name, () => {
            expect(() => normalizeRelated(data as never, 'queries')).toThrow(SourceChangedError);
        });
    }
});

describe('failed / skipped sections', () => {
    it('failedSection(TrendsError) -> "<CODE>: <message>", null lists', () => {
        const err = new RateLimitedError('explore');
        expect(failedSection(err)).toEqual({
            status: 'failed',
            error: `RATE_LIMITED: ${err.message}`,
            top: null,
            rising: null,
        });
    });

    it('failedSection(plain Error) -> INTERNAL code', () => {
        expect(failedSection(new Error('boom'))).toEqual({ status: 'failed', error: 'INTERNAL: boom', top: null, rising: null });
    });

    it('failedSection(SourceChangedError) uses SOURCE_CHANGED', () => {
        let caught: unknown;
        try {
            normalizeTimeline(null as never, {});
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SourceChangedError);
        const s = failedSection(caught as Error);
        expect(s.error).toBe(`SOURCE_CHANGED: ${(caught as Error).message}`);
    });

    it('failedTimeline -> points null, resolution null, error text', () => {
        const err = new RateLimitedError('widgetdata/multiline');
        expect(failedTimeline(err)).toEqual({
            status: 'failed',
            error: `RATE_LIMITED: ${err.message}`,
            resolution: null,
            points: null,
        });
        expect(failedTimeline(new Error('x'))).toEqual({ status: 'failed', error: 'INTERNAL: x', resolution: null, points: null });
    });

    it('skippedSection / skippedTimeline have no error key', () => {
        const s = skippedSection();
        expect(s).toEqual({ status: 'skipped', top: null, rising: null });
        expect(s).not.toHaveProperty('error');
        const t = skippedTimeline();
        expect(t).toEqual({ status: 'skipped', resolution: null, points: null });
        expect(t).not.toHaveProperty('error');
    });
});

describe('rollupStatus', () => {
    const ok = { status: 'ok' as const };
    const empty = { status: 'empty' as const };
    const failed = { status: 'failed' as const };
    const skipped = { status: 'skipped' as const };
    const roll = (...s: { status: string }[]): string => rollupStatus(s as never);

    it('all ok -> ok', () => expect(roll(ok, ok, ok)).toBe('ok'));
    it('ok + empty -> ok', () => expect(roll(ok, empty, skipped)).toBe('ok'));
    it('all empty -> ok (empty is not failure)', () => expect(roll(empty, empty)).toBe('ok'));
    it('ok + skipped -> ok', () => expect(roll(ok, skipped, skipped)).toBe('ok'));
    it('one failed + ok -> partial', () => expect(roll(failed, ok, skipped)).toBe('partial'));
    it('one failed + empty -> partial', () => expect(roll(failed, empty)).toBe('partial'));
    it('all requested failed -> failed', () => expect(roll(failed, failed, failed)).toBe('failed'));
    it('failed + skipped -> failed', () => expect(roll(failed, skipped, skipped)).toBe('failed'));
    it('all skipped -> ok (none of the rest failed)', () => expect(roll(skipped, skipped, skipped)).toBe('ok'));
    it('works with real section objects', () => {
        expect(
            rollupStatus([
                normalizeTimeline(widgetData('multiline-weekly-ok.txt'), { resolution: 'WEEK' }),
                failedSection(new Error('x')),
                skippedSection(),
            ]),
        ).toBe('partial');
    });
});
