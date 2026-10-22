// Fake TrendsApi + RunDeps for the Part 5 contract (IMPLEMENTATION_PLAN.md §6). Built from the spec only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { TrendsApi } from '../../src/run.js';
import { fixtureJson } from './fake-fetch.js';

export interface Widget {
    id: string;
    request: unknown;
    token: string;
}

export interface Query {
    keyword: string;
    geo: string;
    timeRange: string;
    category: number;
}

export type Method = 'explore' | 'interestOverTime' | 'relatedSearches';
export interface ApiCall {
    method: Method;
    arg: unknown;
}

export const widgetData = (name: string): unknown => (fixtureJson(name) as { default: unknown }).default;

export const TIMESERIES_OK = (): unknown => widgetData('multiline-weekly-ok.txt');
export const QUERIES_OK = (): unknown => widgetData('relatedsearches-queries-ok.txt');
export const RELATED_EMPTY = (): unknown => widgetData('relatedsearches-empty.txt');

/** Widgets as explore would return them; the token encodes keyword, widget and explore number. */
export const widgetsFor = (keyword: string, exploreNo: number): { timeseries: Widget; relatedQueries: Widget; relatedTopics: Widget } => ({
    timeseries: { id: 'TIMESERIES', request: { resolution: 'WEEK' }, token: `${keyword}|TIMESERIES|${exploreNo}` },
    relatedQueries: { id: 'RELATED_QUERIES', request: { restriction: {} }, token: `${keyword}|RELATED_QUERIES|${exploreNo}` },
    relatedTopics: { id: 'RELATED_TOPICS', request: { restriction: {} }, token: `${keyword}|RELATED_TOPICS|${exploreNo}` },
});

export type Section = 'timeseries' | 'relatedQueries' | 'relatedTopics';

/**
 * Per-keyword script. `explore(n)` gets the 1-based explore number for this keyword and returns
 * the widget map or throws. Section handlers get the widget and the 1-based call number for that
 * section of that keyword and return the raw `default` object or throw.
 */
export interface KeywordScript {
    explore?: (n: number, q: Query) => Promise<unknown> | unknown;
    timeseries?: (w: Widget, n: number) => Promise<unknown> | unknown;
    relatedQueries?: (w: Widget, n: number) => Promise<unknown> | unknown;
    relatedTopics?: (w: Widget, n: number) => Promise<unknown> | unknown;
}

export interface FakeApi {
    api: TrendsApi;
    calls: ApiCall[];
    exploreCount: (keyword: string) => number;
}

const SECTION_BY_ID: Record<string, Section> = {
    TIMESERIES: 'timeseries',
    RELATED_QUERIES: 'relatedQueries',
    RELATED_TOPICS: 'relatedTopics',
};

export function makeFakeApi(scripts: Record<string, KeywordScript> = {}): FakeApi {
    const calls: ApiCall[] = [];
    const exploreN = new Map<string, number>();
    const sectionN = new Map<string, number>();
    const defaults: Required<KeywordScript> = {
        explore: () => undefined, // replaced below with widgetsFor
        timeseries: () => TIMESERIES_OK(),
        relatedQueries: () => QUERIES_OK(),
        relatedTopics: () => RELATED_EMPTY(),
    };

    const widgetCall = async (method: Method, widget: Widget): Promise<unknown> => {
        calls.push({ method, arg: widget });
        const keyword = widget.token.split('|')[0]!;
        const section = SECTION_BY_ID[widget.id];
        if (!section) throw new Error(`fake api: unknown widget id ${widget.id}`);
        const key = `${keyword}|${section}`;
        const n = (sectionN.get(key) ?? 0) + 1;
        sectionN.set(key, n);
        const handler = scripts[keyword]?.[section] ?? defaults[section];
        return handler(widget, n);
    };

    const api = {
        explore: async (q: Query) => {
            calls.push({ method: 'explore', arg: q });
            const n = (exploreN.get(q.keyword) ?? 0) + 1;
            exploreN.set(q.keyword, n);
            const handler = scripts[q.keyword]?.explore;
            if (handler) return handler(n, q);
            return widgetsFor(q.keyword, n);
        },
        interestOverTime: (w: Widget) => widgetCall('interestOverTime', w),
        relatedSearches: (w: Widget) => widgetCall('relatedSearches', w),
    } as unknown as TrendsApi;

    return { api, calls, exploreCount: (k) => exploreN.get(k) ?? 0 };
}

/** Compact call trace: "explore:coffee", "interestOverTime:coffee|TIMESERIES|1", ... */
export const trace = (calls: ApiCall[]): string[] =>
    calls.map((c) => (c.method === 'explore' ? `explore:${(c.arg as Query).keyword}` : `${c.method}:${(c.arg as Widget).token}`));

export interface LogEntry {
    level: 'info' | 'warning' | 'error' | 'debug';
    args: unknown[];
}

export function makeLog(): { log: { info: (...a: unknown[]) => void; warning: (...a: unknown[]) => void; error: (...a: unknown[]) => void; debug: (...a: unknown[]) => void }; entries: LogEntry[] } {
    const entries: LogEntry[] = [];
    const at = (level: LogEntry['level']) => (...args: unknown[]) => {
        entries.push({ level, args });
    };
    return { log: { info: at('info'), warning: at('warning'), error: at('error'), debug: at('debug') }, entries };
}

const schemaPath = fileURLToPath(new URL('../../.actor/dataset_schema.json', import.meta.url));
const datasetSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { fields: object };
// ajv / ajv-formats are CJS; under NodeNext their default import is the module object.
const Ajv = AjvModule.default;
const addFormats = addFormatsModule.default;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateFn = ajv.compile(datasetSchema.fields);

/** Returns Ajv errors as JSON ('' when valid). */
export const schemaErrors = (rec: unknown): string => (validateFn(rec) ? '' : JSON.stringify(validateFn.errors));
