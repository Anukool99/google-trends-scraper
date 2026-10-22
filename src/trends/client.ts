import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { httpError, NetworkError, RateLimitedError, SourceChangedError, TrendsError } from './errors.js';
import { sleep as realSleep, withRetry, type RetryOptions } from './retry.js';

const BASE_URL = 'https://trends.google.com/trends/api';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export interface FetchResponse {
    status: number;
    headers: { getSetCookie(): string[] };
    text(): Promise<string>;
}
export type FetchLike = (url: string, init: { headers: Record<string, string>; dispatcher?: unknown; signal?: AbortSignal }) => Promise<FetchResponse>;

export interface TrendsQuery {
    keyword: string;
    geo: string;
    timeRange: string;
    category: number;
}

export interface Widget {
    id: string;
    request: unknown;
    token: string;
}

export interface ExploreResult {
    timeseries?: Widget;
    relatedQueries?: Widget;
    relatedTopics?: Widget;
}

export interface TrendsClientOptions {
    language: string;
    maxRetries: number;
    proxyUrl?: string;
    /** Minimum gap between the start of any two requests. Part 0 measured 3 s as clean. */
    minRequestIntervalMs?: number;
    /** Per-attempt limit for headers + body; undici's own defaults are 5 minutes each. */
    requestTimeoutMs?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: RetryOptions['onRetry'];
    // Injectable for tests.
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    now?: () => number;
}

const WIDGET_KEYS: Record<string, keyof ExploreResult> = {
    TIMESERIES: 'timeseries',
    RELATED_QUERIES: 'relatedQueries',
    RELATED_TOPICS: 'relatedTopics',
};

const safeDecode = (s: string): string => {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
};

/** Strips Google's `)]}'` anti-XSSI first line and parses the JSON that follows. */
export function parseXssi(text: string, endpoint: string): unknown {
    const body = text.startsWith(")]}'") ? text.slice(text.indexOf('\n') + 1) : text;
    try {
        return JSON.parse(body);
    } catch (err) {
        throw new SourceChangedError(`${endpoint} returned a body that is not JSON`, { cause: err });
    }
}

/**
 * Low-level client for the unofficial Google Trends endpoints: one session (cookie jar),
 * paced requests, bounded retries. Keyword-level orchestration lives in main.ts.
 */
export class TrendsClient {
    private readonly cookies = new Map<string, string>();
    private lastRequestAt = -Infinity;
    private readonly fetch: FetchLike;
    private readonly dispatcher: ProxyAgent | undefined;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;
    private readonly minRequestIntervalMs: number;
    private readonly requestTimeoutMs: number;
    private readonly retry: RetryOptions;

    constructor(private readonly options: TrendsClientOptions) {
        this.fetch = options.fetch ?? (undiciFetch as unknown as FetchLike);
        try {
            this.dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
        } catch {
            // The original error quotes the URL, which contains credentials.
            throw new Error('Invalid proxy URL');
        }
        this.sleep = options.sleep ?? realSleep;
        this.now = options.now ?? Date.now;
        this.minRequestIntervalMs = options.minRequestIntervalMs ?? 3000;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.retry = {
            maxRetries: options.maxRetries,
            baseDelayMs: options.baseDelayMs ?? 4000,
            maxDelayMs: options.maxDelayMs ?? 60_000,
            sleep: this.sleep,
            random: options.random ?? Math.random,
            onRetry: options.onRetry,
        };
    }

    /** Step 1: returns the widgets (with their tokens) for one keyword. A widget Google did not return is undefined. */
    async explore(query: TrendsQuery): Promise<ExploreResult> {
        const req = {
            comparisonItem: [{ keyword: query.keyword, geo: query.geo, time: query.timeRange }],
            category: query.category,
            property: '',
        };
        const params = { req: JSON.stringify(req) };

        // A fresh session's first request gets 429 plus an NID cookie; repeating it with the cookie succeeds.
        // That warm-up repeat does not count against the retry budget.
        const attempt = async () => {
            const hadCookies = this.cookies.size > 0;
            try {
                return await this.get('explore', params);
            } catch (err) {
                if (err instanceof RateLimitedError && !hadCookies && this.cookies.size > 0) return this.get('explore', params);
                throw err;
            }
        };
        const json = parseXssi(await withRetry(attempt, this.retry), 'explore');

        const widgets = (json as { widgets?: unknown })?.widgets;
        if (!Array.isArray(widgets)) throw new SourceChangedError('explore response has no widgets array');

        const result: ExploreResult = {};
        for (const w of widgets as Partial<Widget>[]) {
            const key = w.id && Object.hasOwn(WIDGET_KEYS, w.id) ? WIDGET_KEYS[w.id] : undefined;
            if (!key) continue;
            if (typeof w.token !== 'string' || w.request === undefined) throw new SourceChangedError(`explore widget ${w.id} has no token or request`);
            result[key] = { id: w.id!, request: w.request, token: w.token };
        }
        return result;
    }

    /** Step 2a: raw `default` object of the TIMESERIES widget (`{ timelineData, averages }`). */
    interestOverTime(widget: Widget): Promise<unknown> {
        return this.widgetData('widgetdata/multiline', widget);
    }

    /** Step 2b: raw `default` object of a RELATED_QUERIES or RELATED_TOPICS widget (`{ rankedList }`). */
    relatedSearches(widget: Widget): Promise<unknown> {
        return this.widgetData('widgetdata/relatedsearches', widget);
    }

    private async widgetData(endpoint: string, widget: Widget): Promise<unknown> {
        const params = { req: JSON.stringify(widget.request), token: widget.token };
        const json = parseXssi(await withRetry(() => this.get(endpoint, params), this.retry), endpoint);
        const data = (json as { default?: unknown })?.default;
        if (typeof data !== 'object' || data === null) throw new SourceChangedError(`${endpoint} response has no "default" object`);
        return data;
    }

    /** One paced HTTP attempt. Returns the body on 200; throws a classified TrendsError otherwise. */
    private async get(endpoint: string, params: Record<string, string>): Promise<string> {
        const wait = this.lastRequestAt + this.minRequestIntervalMs - this.now();
        if (wait > 0) await this.sleep(wait);
        this.lastRequestAt = this.now();

        const query = new URLSearchParams({ hl: this.options.language, tz: '0', ...params });
        const headers: Record<string, string> = {
            'User-Agent': USER_AGENT,
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': this.options.language,
        };
        if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

        let response: FetchResponse;
        let text: string;
        try {
            response = await this.fetch(`${BASE_URL}/${endpoint}?${query}`, {
                headers,
                dispatcher: this.dispatcher,
                signal: AbortSignal.timeout(this.requestTimeoutMs),
            });
            this.storeCookies(response.headers.getSetCookie());
            text = await response.text();
        } catch (err) {
            if (err instanceof TrendsError) throw err;
            throw new NetworkError(endpoint, this.redact(err));
        }
        if (response.status !== 200) throw httpError(response.status, endpoint);
        return text;
    }

    /** Releases the proxy connection pool. */
    async close(): Promise<void> {
        await this.dispatcher?.close();
    }

    /** Proxy URLs carry credentials, so keep them out of anything that may be logged. */
    private redact(err: unknown): string {
        let message = err instanceof Error ? err.message : String(err);
        const proxyUrl = this.options.proxyUrl;
        if (!proxyUrl) return message;

        message = message.split(proxyUrl).join('<proxy>');
        // Errors can also mention the credentials on their own, raw or percent-decoded.
        let password = '';
        try {
            password = new URL(proxyUrl).password;
        } catch {
            // Unparseable proxy URL: nothing more to strip.
        }
        for (const secret of new Set([password, safeDecode(password)])) {
            if (secret) message = message.split(secret).join('<redacted>');
        }
        return message;
    }

    private storeCookies(setCookies: string[]): void {
        for (const header of setCookies) {
            const pair = header.split(';', 1)[0] ?? '';
            const eq = pair.indexOf('=');
            if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
    }
}
