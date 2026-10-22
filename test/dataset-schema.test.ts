// Validates normalizer output against .actor/dataset_schema.json, per IMPLEMENTATION_PLAN.md §6 "Part 4 contract".
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
    failedSection,
    failedTimeline,
    normalizeRelated,
    normalizeTimeline,
    rollupStatus,
    skippedSection,
    skippedTimeline,
    type InterestOverTime,
    type KeywordRecord,
    type RelatedQuery,
    type RelatedSection,
    type RelatedTopic,
} from '../src/normalize.js';
import { RateLimitedError } from '../src/trends/errors.js';
import { fixtureJson } from './helpers/fake-fetch.js';

const schemaPath = fileURLToPath(new URL('../.actor/dataset_schema.json', import.meta.url));
const datasetSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { fields: object };

// ajv / ajv-formats are CJS; under NodeNext their default import is the module object.
const Ajv = AjvModule.default;
const addFormats = addFormatsModule.default;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(datasetSchema.fields);

const widgetData = (name: string): unknown => (fixtureJson(name) as { default: unknown }).default;

const record = (iot: InterestOverTime, rq: RelatedSection<RelatedQuery>, rt: RelatedSection<RelatedTopic>): KeywordRecord =>
    ({
        keyword: 'coffee',
        geo: 'US',
        timeRange: 'today 12-m',
        category: 0,
        status: rollupStatus([iot, rq, rt]),
        interestOverTime: iot,
        relatedQueries: rq,
        relatedTopics: rt,
        scrapedAt: '2026-10-22T10:00:00.000Z',
    }) as KeywordRecord;

const expectValid = (rec: unknown): void => {
    const okay = validate(rec);
    expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
    expect(okay).toBe(true);
};

const timelines: [string, string][] = [
    ['multiline-weekly-ok.txt', 'WEEK'],
    ['multiline-hourly-ok.txt', 'HOUR'],
    ['multiline-daily-custom-range-ok.txt', 'DAY'],
    ['multiline-nonexistent-empty.txt', 'WEEK'],
    ['multiline-nonexistent-hourly-nodata.txt', 'HOUR'],
];
const queries = ['relatedsearches-queries-ok.txt', 'relatedsearches-queries-empty-lists.txt', 'relatedsearches-empty.txt'];

describe('dataset_schema.json: records built from fixtures validate', () => {
    for (const [tl, res] of timelines) {
        for (const rqFile of queries) {
            it(`${tl} + ${rqFile} + empty topics`, () => {
                const rec = record(
                    normalizeTimeline(widgetData(tl), { resolution: res }),
                    normalizeRelated(widgetData(rqFile), 'queries'),
                    normalizeRelated(widgetData('relatedsearches-empty.txt'), 'topics'),
                );
                expectValid(rec);
            });
        }
    }

    it('missing resolution (null) validates', () => {
        expectValid(record(normalizeTimeline(widgetData('multiline-weekly-ok.txt'), {}), skippedSection(), skippedSection()));
    });

    it('synthetic topic items validate', () => {
        const topics = normalizeRelated(
            {
                rankedList: [
                    { rankedKeyword: [{ topic: { mid: '/m/02vqfm', title: 'Coffee', type: 'Drink' }, value: 100, formattedValue: '100', link: '/x' }] },
                    { rankedKeyword: [{ topic: { mid: '/m/1', title: 'Cold brew', type: 'Topic' }, value: 5000, formattedValue: 'Breakout' }] },
                ],
            },
            'topics',
        );
        expectValid(record(skippedTimeline(), skippedSection(), topics));
    });
});

describe('dataset_schema.json: failed and skipped sections validate', () => {
    it('failed timeline + failed queries + skipped topics', () => {
        const rec = record(failedTimeline(new RateLimitedError('widgetdata/multiline')), failedSection(new Error('boom')), skippedSection());
        expect(rec.status).toBe('failed');
        expectValid(rec);
    });

    it('ok timeline + failed queries + skipped topics (partial)', () => {
        const rec = record(
            normalizeTimeline(widgetData('multiline-weekly-ok.txt'), { resolution: 'WEEK' }),
            failedSection(new RateLimitedError('widgetdata/relatedsearches')),
            skippedSection(),
        );
        expect(rec.status).toBe('partial');
        expectValid(rec);
    });

    it('all skipped', () => {
        expectValid(record(skippedTimeline(), skippedSection(), skippedSection()));
    });
});

describe('dataset_schema.json: strictness (negative checks)', () => {
    const base = (): Record<string, unknown> =>
        JSON.parse(
            JSON.stringify(
                record(
                    normalizeTimeline(widgetData('multiline-weekly-ok.txt'), { resolution: 'WEEK' }),
                    normalizeRelated(widgetData('relatedsearches-queries-ok.txt'), 'queries'),
                    skippedSection(),
                ),
            ),
        ) as Record<string, unknown>;

    it('baseline is valid', () => expectValid(base()));

    it('unknown top-level field fails', () => {
        expect(validate({ ...base(), surprise: 1 })).toBe(false);
    });

    it('bad top-level status enum fails', () => {
        expect(validate({ ...base(), status: 'empty' })).toBe(false);
        expect(validate({ ...base(), status: 'weird' })).toBe(false);
    });

    it('point missing isPartial fails', () => {
        const rec = base();
        const iot = rec.interestOverTime as { points: Record<string, unknown>[] };
        delete iot.points[0]!.isPartial;
        expect(validate(rec)).toBe(false);
    });

    it('extra key on relatedQueries fails', () => {
        const rec = base();
        (rec.relatedQueries as Record<string, unknown>).extra = 1;
        expect(validate(rec)).toBe(false);
    });

    it('extra key on a query item fails', () => {
        const rec = base();
        (rec.relatedQueries as { top: Record<string, unknown>[] }).top[0]!.extra = 1;
        expect(validate(rec)).toBe(false);
    });

    it('extra key on relatedTopics or a topic item fails', () => {
        const topics = normalizeRelated(
            { rankedList: [{ rankedKeyword: [{ topic: { mid: '/m/1', title: 'T', type: 'X' }, value: 1, formattedValue: '1' }] }, { rankedKeyword: [] }] },
            'topics',
        );
        const good = JSON.parse(JSON.stringify(record(skippedTimeline(), skippedSection(), topics))) as Record<string, unknown>;
        expectValid(good);
        const onItem = structuredClone(good);
        (onItem.relatedTopics as { top: Record<string, unknown>[] }).top[0]!.extra = 1;
        expect(validate(onItem)).toBe(false);
        const onSection = structuredClone(good);
        (onSection.relatedTopics as Record<string, unknown>).extra = 1;
        expect(validate(onSection)).toBe(false);
    });

    it('extra key on interestOverTime fails', () => {
        const rec = base();
        (rec.interestOverTime as Record<string, unknown>).extra = 1;
        expect(validate(rec)).toBe(false);
    });

    it('missing required top-level field fails', () => {
        const rec = base();
        delete rec.scrapedAt;
        expect(validate(rec)).toBe(false);
    });
});
