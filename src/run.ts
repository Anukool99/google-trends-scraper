import type { ValidatedInput } from './input.js';
import {
    failedSection, failedTimeline, normalizeRelated, normalizeTimeline, rollupStatus, skippedSection,
    type InterestOverTime, type KeywordRecord, type RelatedQuery, type RelatedSection, type RelatedTopic, type SectionStatus,
} from './normalize.js';
import type { ExploreResult, TrendsClient, TrendsQuery, Widget } from './trends/client.js';
import { RunAbortedError, SourceChangedError, TokenMismatchError } from './trends/errors.js';

/**
 * After this many failed keywords in a row the run stops requesting: Google is almost certainly blocking,
 * and each further keyword would spend its whole retry budget (minutes) for nothing.
 */
export const MAX_CONSECUTIVE_FAILED_KEYWORDS = 3;

export type TrendsApi = Pick<TrendsClient, 'explore' | 'interestOverTime' | 'relatedSearches'>;

export interface SectionOptions {
    includeRelatedQueries: boolean;
    includeRelatedTopics: boolean;
}

export type SectionCounts = Record<SectionStatus, number>;

export interface RunSummary {
    keywords: number;
    ok: number;
    partial: number;
    failed: number;
    sections: { interestOverTime: SectionCounts; relatedQueries: SectionCounts; relatedTopics: SectionCounts };
    /** True when the circuit breaker stopped the run; the keywords after that point were not requested. */
    aborted: boolean;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
}

export interface RunDeps {
    client: TrendsApi;
    pushData: (record: KeywordRecord) => Promise<void>;
    setOutput: (summary: RunSummary) => Promise<void>;
    now: () => Date;
    log: {
        info: (msg: string, data?: Record<string, unknown>) => void;
        warning: (msg: string, data?: Record<string, unknown>) => void;
        error: (msg: string, data?: Record<string, unknown>) => void;
    };
}

type WidgetKey = keyof ExploreResult;

const WIDGET_NAMES: Record<WidgetKey, string> = {
    timeseries: 'TIMESERIES',
    relatedQueries: 'RELATED_QUERIES',
    relatedTopics: 'RELATED_TOPICS',
};

export async function scrapeKeyword(client: TrendsApi, query: TrendsQuery, options: SectionOptions): Promise<Omit<KeywordRecord, 'scrapedAt'>> {
    const base = { keyword: query.keyword, geo: query.geo, timeRange: query.timeRange, category: query.category };
    const wantQueries = options.includeRelatedQueries;
    const wantTopics = options.includeRelatedTopics;

    let widgets: ExploreResult;
    try {
        widgets = await client.explore(query);
    } catch (err) {
        const interestOverTime = failedTimeline(err);
        const relatedQueries = wantQueries ? failedSection<RelatedQuery>(err) : skippedSection<RelatedQuery>();
        const relatedTopics = wantTopics ? failedSection<RelatedTopic>(err) : skippedSection<RelatedTopic>();
        return { ...base, status: rollupStatus([interestOverTime, relatedQueries, relatedTopics]), interestOverTime, relatedQueries, relatedTopics };
    }

    // A 401 means the token no longer matches its request; fresh widgets from one re-explore usually fix it.
    let reExplored = false;
    const fetchSection = async <T>(key: WidgetKey, call: (widget: Widget) => Promise<T>): Promise<T> => {
        const widget = widgets[key];
        if (!widget) throw new SourceChangedError(`explore returned no ${WIDGET_NAMES[key]} widget`);
        try {
            return await call(widget);
        } catch (err) {
            if (!(err instanceof TokenMismatchError) || reExplored) throw err;
            reExplored = true;
            widgets = await client.explore(query);
            const fresh = widgets[key];
            if (!fresh) throw new SourceChangedError(`explore returned no ${WIDGET_NAMES[key]} widget`);
            return call(fresh);
        }
    };

    let interestOverTime: InterestOverTime;
    try {
        interestOverTime = await fetchSection('timeseries', async (w) => normalizeTimeline(await client.interestOverTime(w), w.request));
    } catch (err) {
        interestOverTime = failedTimeline(err);
    }

    const related = async <T>(enabled: boolean, key: 'relatedQueries' | 'relatedTopics', normalize: (data: unknown) => RelatedSection<T>) => {
        if (!enabled) return skippedSection<T>();
        try {
            return await fetchSection(key, async (w) => normalize(await client.relatedSearches(w)));
        } catch (err) {
            return failedSection<T>(err);
        }
    };
    const relatedQueries = await related<RelatedQuery>(wantQueries, 'relatedQueries', (d) => normalizeRelated(d, 'queries'));
    const relatedTopics = await related<RelatedTopic>(wantTopics, 'relatedTopics', (d) => normalizeRelated(d, 'topics'));

    return { ...base, status: rollupStatus([interestOverTime, relatedQueries, relatedTopics]), interestOverTime, relatedQueries, relatedTopics };
}

/** Record for a keyword that was never requested: every requested section fails with `err`. */
function notAttempted(query: TrendsQuery, options: SectionOptions, err: RunAbortedError): Omit<KeywordRecord, 'scrapedAt'> {
    return {
        keyword: query.keyword,
        geo: query.geo,
        timeRange: query.timeRange,
        category: query.category,
        status: 'failed',
        interestOverTime: failedTimeline(err),
        relatedQueries: options.includeRelatedQueries ? failedSection<RelatedQuery>(err) : skippedSection<RelatedQuery>(),
        relatedTopics: options.includeRelatedTopics ? failedSection<RelatedTopic>(err) : skippedSection<RelatedTopic>(),
    };
}

const firstError = (record: KeywordRecord): string | undefined =>
    record.interestOverTime.error ?? record.relatedQueries.error ?? record.relatedTopics.error;

const emptyCounts = (): SectionCounts => ({ ok: 0, empty: 0, failed: 0, skipped: 0 });

export async function runActor(input: ValidatedInput, deps: RunDeps): Promise<RunSummary> {
    const started = deps.now();
    const summary: RunSummary = {
        keywords: input.keywords.length,
        ok: 0,
        partial: 0,
        failed: 0,
        sections: { interestOverTime: emptyCounts(), relatedQueries: emptyCounts(), relatedTopics: emptyCounts() },
        aborted: false,
        startedAt: started.toISOString(),
        finishedAt: '',
        durationMs: 0,
    };
    const options = { includeRelatedQueries: input.includeRelatedQueries, includeRelatedTopics: input.includeRelatedTopics };

    let consecutiveFailed = 0;
    let abortError: RunAbortedError | undefined;
    for (const [i, keyword] of input.keywords.entries()) {
        const query = { keyword, geo: input.geo, timeRange: input.timeRange, category: input.category };
        const scraped = abortError ? notAttempted(query, options, abortError) : await scrapeKeyword(deps.client, query, options);
        const record: KeywordRecord = { ...scraped, scrapedAt: deps.now().toISOString() };
        await deps.pushData(record);

        summary[record.status]++;
        summary.sections.interestOverTime[record.interestOverTime.status]++;
        summary.sections.relatedQueries[record.relatedQueries.status]++;
        summary.sections.relatedTopics[record.relatedTopics.status]++;

        // Called as a method: Apify's logger relies on `this`.
        const level = record.status === 'failed' ? 'error' : record.status === 'partial' ? 'warning' : 'info';
        deps.log[level](`[${i + 1}/${input.keywords.length}] "${keyword}": ${record.status}`, {
            interestOverTime: record.interestOverTime.status,
            relatedQueries: record.relatedQueries.status,
            relatedTopics: record.relatedTopics.status,
            ...(record.status === 'ok' ? {} : { error: firstError(record) }),
        });

        consecutiveFailed = record.status === 'failed' ? consecutiveFailed + 1 : 0;
        if (!abortError && consecutiveFailed >= MAX_CONSECUTIVE_FAILED_KEYWORDS && i < input.keywords.length - 1) {
            abortError = new RunAbortedError(`not requested: the run stopped after ${MAX_CONSECUTIVE_FAILED_KEYWORDS} failed keywords in a row`);
            summary.aborted = true;
            deps.log.error(`${MAX_CONSECUTIVE_FAILED_KEYWORDS} keywords in a row failed; Google is probably blocking. Skipping the remaining ${input.keywords.length - i - 1} keywords.`);
        }
    }

    const finished = deps.now();
    summary.finishedAt = finished.toISOString();
    summary.durationMs = finished.getTime() - started.getTime();
    await deps.setOutput(summary);
    return summary;
}
