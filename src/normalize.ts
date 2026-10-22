import { SourceChangedError, TrendsError } from './trends/errors.js';

const TRENDS_ORIGIN = 'https://trends.google.com';

export type SectionStatus = 'ok' | 'empty' | 'failed' | 'skipped';
export type RecordStatus = 'ok' | 'partial' | 'failed';

export interface TimelinePoint {
    date: string;
    label: string;
    interest: number | null;
    isPartial: boolean;
}

export interface InterestOverTime {
    status: SectionStatus;
    resolution: string | null;
    points: TimelinePoint[] | null;
    error?: string;
}

export interface RelatedQuery {
    query: string;
    value: number;
    formattedValue: string;
    link: string | null;
    isBreakout: boolean;
}

export interface RelatedTopic {
    mid: string;
    title: string;
    type: string;
    value: number;
    formattedValue: string;
    link: string | null;
    isBreakout: boolean;
}

export interface RelatedSection<T> {
    status: SectionStatus;
    top: T[] | null;
    rising: T[] | null;
    error?: string;
}

export interface KeywordRecord {
    keyword: string;
    geo: string;
    timeRange: string;
    category: number;
    status: RecordStatus;
    interestOverTime: InterestOverTime;
    relatedQueries: RelatedSection<RelatedQuery>;
    relatedTopics: RelatedSection<RelatedTopic>;
    scrapedAt: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Google labels contain U+202F, U+2009 and similar spaces; plain spaces survive CSV and spreadsheets. */
const cleanLabel = (s: unknown): string => (typeof s === 'string' ? s.replace(/\p{Zs}/gu, ' ') : '');

export function normalizeTimeline(data: unknown, widgetRequest: unknown): InterestOverTime {
    const timeline = isObj(data) ? data.timelineData : undefined;
    if (!Array.isArray(timeline)) throw new SourceChangedError('multiline response has no timelineData array');

    const resolution = isObj(widgetRequest) && typeof widgetRequest.resolution === 'string'
        ? widgetRequest.resolution.toLowerCase()
        : null;

    const points = timeline.map((p, i): TimelinePoint => {
        if (!isObj(p)) throw new SourceChangedError(`timelineData[${i}] is not an object`);
        const seconds = typeof p.time === 'number' ? p.time : typeof p.time === 'string' && /^\d+$/.test(p.time) ? Number(p.time) : NaN;
        const value = Array.isArray(p.value) ? p.value[0] : undefined;
        if (!Number.isFinite(seconds) || typeof value !== 'number') {
            throw new SourceChangedError(`timelineData[${i}] has no usable time/value`);
        }
        const hasData = Array.isArray(p.hasData) ? p.hasData[0] !== false : true;
        return {
            date: new Date(seconds * 1000).toISOString(),
            label: cleanLabel(p.formattedTime),
            interest: hasData ? value : null,
            isPartial: p.isPartial === true,
        };
    });

    const status = points.some((p) => p.interest !== null) ? 'ok' : 'empty';
    return { status, resolution, points };
}

export function normalizeRelated(data: unknown, kind: 'queries'): RelatedSection<RelatedQuery>;
export function normalizeRelated(data: unknown, kind: 'topics'): RelatedSection<RelatedTopic>;
export function normalizeRelated(data: unknown, kind: 'queries' | 'topics'): RelatedSection<RelatedQuery | RelatedTopic> {
    const ranked = isObj(data) ? data.rankedList : undefined;
    if (!Array.isArray(ranked) || (ranked.length !== 0 && ranked.length !== 2)) {
        throw new SourceChangedError('relatedsearches response rankedList is not a list of 0 or 2 entries');
    }
    if (ranked.length === 0) return { status: 'empty', top: [], rising: [] };

    const [top, rising] = ranked.map((list, li) => {
        const items = isObj(list) ? list.rankedKeyword : undefined;
        if (!Array.isArray(items)) throw new SourceChangedError(`rankedList[${li}] has no rankedKeyword array`);
        const isRising = li === 1;
        return items.map((item, i) => (kind === 'queries' ? toQuery(item, isRising, i) : toTopic(item, isRising, i)));
    }) as [RelatedQuery[] | RelatedTopic[], RelatedQuery[] | RelatedTopic[]];

    return { status: top.length || rising.length ? 'ok' : 'empty', top, rising };
}

function rankedFields(item: Obj, isRising: boolean, where: string) {
    if (typeof item.value !== 'number') throw new SourceChangedError(`${where} has no numeric value`);
    const formattedValue = typeof item.formattedValue === 'string' ? item.formattedValue : String(item.value);
    return {
        value: item.value,
        formattedValue,
        link: typeof item.link === 'string' ? TRENDS_ORIGIN + item.link : null,
        isBreakout: isRising && formattedValue === 'Breakout',
    };
}

function toQuery(item: unknown, isRising: boolean, i: number): RelatedQuery {
    const where = `${isRising ? 'rising' : 'top'} query ${i}`;
    if (!isObj(item) || typeof item.query !== 'string') throw new SourceChangedError(`${where} has no query string`);
    return { query: item.query, ...rankedFields(item, isRising, where) };
}

// Topic shape follows public descriptions of the endpoint; Part 0 never received a topic, so this is unverified.
function toTopic(item: unknown, isRising: boolean, i: number): RelatedTopic {
    const where = `${isRising ? 'rising' : 'top'} topic ${i}`;
    const topic = isObj(item) ? item.topic : undefined;
    if (!isObj(item) || !isObj(topic) || typeof topic.mid !== 'string' || typeof topic.title !== 'string') {
        throw new SourceChangedError(`${where} has no topic mid/title`);
    }
    return {
        mid: topic.mid,
        title: topic.title,
        type: typeof topic.type === 'string' ? topic.type : '',
        ...rankedFields(item, isRising, where),
    };
}

const errorText = (err: unknown): string =>
    err instanceof TrendsError ? `${err.code}: ${err.message}` : `INTERNAL: ${err instanceof Error ? err.message : String(err)}`;

export const failedSection = <T>(err: unknown): RelatedSection<T> => ({ status: 'failed', error: errorText(err), top: null, rising: null });
export const skippedSection = <T>(): RelatedSection<T> => ({ status: 'skipped', top: null, rising: null });
export const failedTimeline = (err: unknown): InterestOverTime => ({ status: 'failed', error: errorText(err), resolution: null, points: null });
export const skippedTimeline = (): InterestOverTime => ({ status: 'skipped', resolution: null, points: null });

export function rollupStatus(sections: { status: SectionStatus }[]): RecordStatus {
    const requested = sections.filter((s) => s.status !== 'skipped');
    const failed = requested.filter((s) => s.status === 'failed').length;
    if (failed === 0) return 'ok';
    return failed === requested.length ? 'failed' : 'partial';
}
