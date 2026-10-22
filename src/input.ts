export const TIME_RANGE_PRESETS = [
    'now 1-H', 'now 4-H', 'now 1-d', 'now 7-d',
    'today 1-m', 'today 3-m', 'today 12-m', 'today 5-y', 'all',
] as const;

export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 100;
export const MAX_RETRIES_LIMIT = 8;
const EARLIEST_DATE = '2004-01-01';

const GEO_PATTERN = /^([A-Z]{2}(-[A-Z0-9]{1,3})?)?$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const CUSTOM_RANGE_PATTERN = /^(\d{4}-\d{2}-\d{2}) (\d{4}-\d{2}-\d{2})$/;

export interface ValidatedInput {
    keywords: string[];
    geo: string;
    timeRange: string;
    category: number;
    language: string;
    includeRelatedQueries: boolean;
    includeRelatedTopics: boolean;
    maxRetries: number;
    proxyConfiguration: Record<string, unknown> | undefined;
}

export const DEFAULTS: Omit<ValidatedInput, 'keywords'> = {
    geo: '',
    timeRange: 'today 12-m',
    category: 0,
    language: 'en-US',
    includeRelatedQueries: true,
    includeRelatedTopics: false,
    maxRetries: 5,
    proxyConfiguration: undefined,
};

/** Permanent input problem: the run should fail immediately and never retry. */
export class InputError extends Error {
    constructor(readonly issues: string[]) {
        super(`Invalid input:\n- ${issues.join('\n- ')}`);
        this.name = 'InputError';
    }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** Returns true for a real calendar date in YYYY-MM-DD form. */
const isCalendarDate = (s: string): boolean => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export function parseInput(raw: unknown, now: Date = new Date()): ValidatedInput {
    if (!isPlainObject(raw)) throw new InputError(['keywords: is required']);

    const issues: string[] = [];
    // undefined and null both mean "use the default"
    const field = (name: string): unknown => raw[name] ?? undefined;

    const keywords = parseKeywords(field('keywords'), issues);

    let geo = DEFAULTS.geo;
    const rawGeo = field('geo');
    if (rawGeo !== undefined) {
        if (typeof rawGeo !== 'string') issues.push('geo: must be a string');
        else {
            geo = rawGeo.trim().toUpperCase();
            if (!GEO_PATTERN.test(geo)) issues.push(`geo: "${rawGeo}" is not a country code like "US" or a sub-region like "US-CA"`);
        }
    }

    let timeRange = DEFAULTS.timeRange;
    const rawTime = field('timeRange');
    if (rawTime !== undefined) {
        if (typeof rawTime !== 'string') issues.push('timeRange: must be a string');
        else {
            timeRange = rawTime.trim();
            const problem = checkTimeRange(timeRange, now);
            if (problem) issues.push(`timeRange: ${problem}`);
        }
    }

    const category = parseInteger(field('category'), 'category', DEFAULTS.category, 0, Infinity, issues);

    let language = DEFAULTS.language;
    const rawLang = field('language');
    if (rawLang !== undefined) {
        if (typeof rawLang !== 'string' || !LANGUAGE_PATTERN.test(rawLang)) {
            issues.push(`language: ${JSON.stringify(rawLang)} is not a language code like "en-US"`);
        } else language = rawLang;
    }

    const includeRelatedQueries = parseBoolean(field('includeRelatedQueries'), 'includeRelatedQueries', DEFAULTS.includeRelatedQueries, issues);
    const includeRelatedTopics = parseBoolean(field('includeRelatedTopics'), 'includeRelatedTopics', DEFAULTS.includeRelatedTopics, issues);
    const maxRetries = parseInteger(field('maxRetries'), 'maxRetries', DEFAULTS.maxRetries, 0, MAX_RETRIES_LIMIT, issues);

    let proxyConfiguration: Record<string, unknown> | undefined;
    const rawProxy = field('proxyConfiguration');
    if (rawProxy !== undefined) {
        if (!isPlainObject(rawProxy)) issues.push('proxyConfiguration: must be an object');
        else proxyConfiguration = rawProxy;
    }

    if (issues.length) throw new InputError(issues);
    return { keywords, geo, timeRange, category, language, includeRelatedQueries, includeRelatedTopics, maxRetries, proxyConfiguration };
}

function parseKeywords(value: unknown, issues: string[]): string[] {
    if (value === undefined) {
        issues.push('keywords: is required');
        return [];
    }
    if (!Array.isArray(value)) {
        issues.push('keywords: must be an array of strings');
        return [];
    }

    const seen = new Set<string>();
    const keywords: string[] = [];
    let itemsValid = true;
    value.forEach((item, i) => {
        const problem = typeof item !== 'string' ? 'must be a string'
            : !item.trim() ? 'is empty'
                : item.trim().length > MAX_KEYWORD_LENGTH ? `is longer than ${MAX_KEYWORD_LENGTH} characters`
                    : undefined;
        if (problem) {
            issues.push(`keywords[${i}]: ${problem}`);
            itemsValid = false;
            return;
        }
        const keyword = (item as string).trim();
        if (!seen.has(keyword.toLowerCase())) {
            seen.add(keyword.toLowerCase());
            keywords.push(keyword);
        }
    });

    // Too many is reported regardless: fixing invalid items can only add keywords.
    // Too few is reported only when every item is valid, since fixing one could resolve it.
    if (keywords.length > MAX_KEYWORDS || (itemsValid && keywords.length < 1)) {
        issues.push(`keywords: must contain 1-${MAX_KEYWORDS} unique keywords, got ${keywords.length}`);
    }
    return keywords;
}

function checkTimeRange(timeRange: string, now: Date): string | undefined {
    if ((TIME_RANGE_PRESETS as readonly string[]).includes(timeRange)) return undefined;

    const match = CUSTOM_RANGE_PATTERN.exec(timeRange);
    if (!match) return `"${timeRange}" must be one of ${TIME_RANGE_PRESETS.join(', ')} or "YYYY-MM-DD YYYY-MM-DD"`;

    const [, start, end] = match as unknown as [string, string, string];
    if (!isCalendarDate(start)) return `start date ${start} is not a valid date`;
    if (!isCalendarDate(end)) return `end date ${end} is not a valid date`;
    if (start < EARLIEST_DATE) return `start date ${start} is before ${EARLIEST_DATE}, the earliest Google Trends data`;
    if (start > end) return `start date ${start} is after end date ${end}`;
    const today = now.toISOString().slice(0, 10);
    if (end > today) return `end date ${end} is in the future`;
    return undefined;
}

function parseInteger(value: unknown, name: string, fallback: number, min: number, max: number, issues: string[]): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        const range = max === Infinity ? `>= ${min}` : `from ${min} to ${max}`;
        issues.push(`${name}: must be an integer ${range}, got ${JSON.stringify(value)}`);
        return fallback;
    }
    return value;
}

function parseBoolean(value: unknown, name: string, fallback: boolean, issues: string[]): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
        issues.push(`${name}: must be true or false, got ${JSON.stringify(value)}`);
        return fallback;
    }
    return value;
}
