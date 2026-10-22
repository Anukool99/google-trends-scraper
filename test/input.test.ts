// Tests written from IMPLEMENTATION_PLAN.md §3 ("Input schema" table and "Validation rules"),
// not from the implementation. Assertions check issue field-path prefixes, not exact wording.
import { describe, expect, it } from 'vitest';
import {
    DEFAULTS,
    InputError,
    MAX_KEYWORDS,
    MAX_KEYWORD_LENGTH,
    MAX_RETRIES_LIMIT,
    TIME_RANGE_PRESETS,
    parseInput,
    type ValidatedInput,
} from '../src/input.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const PRESETS = ['now 1-H', 'now 4-H', 'now 1-d', 'now 7-d', 'today 1-m', 'today 3-m', 'today 12-m', 'today 5-y', 'all'];

const parse = (extra: Record<string, unknown> = {}, now: Date = NOW): ValidatedInput =>
    parseInput({ keywords: ['bitcoin'], ...extra }, now);

/** Runs parseInput expecting an InputError and returns it. */
function catchInputError(raw: unknown, now: Date = NOW): InputError {
    try {
        parseInput(raw, now);
    } catch (err) {
        expect(err).toBeInstanceOf(InputError);
        expect(err).toBeInstanceOf(Error);
        expect((err as InputError).name).toBe('InputError');
        expect(Array.isArray((err as InputError).issues)).toBe(true);
        return err as InputError;
    }
    throw new Error(`expected InputError for ${JSON.stringify(raw)}`);
}

/** Asserts parse fails with exactly one issue, and it starts with the given field path. */
function expectSingleIssue(raw: unknown, path: string, now: Date = NOW): InputError {
    const err = catchInputError(raw, now);
    expect(err.issues, JSON.stringify(err.issues)).toHaveLength(1);
    expect(err.issues[0]!.startsWith(path), `issue "${err.issues[0]}" should start with "${path}"`).toBe(true);
    return err;
}

const kw = (n: number, prefix = 'kw') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('exported constants', () => {
    it('match the §3 limits', () => {
        expect(MAX_KEYWORDS).toBe(20);
        expect(MAX_KEYWORD_LENGTH).toBe(100);
        expect(MAX_RETRIES_LIMIT).toBe(8);
        expect([...TIME_RANGE_PRESETS].sort()).toEqual([...PRESETS].sort());
    });

    it('DEFAULTS match the §3 table', () => {
        expect(DEFAULTS).toMatchObject({
            geo: '',
            timeRange: 'today 12-m',
            category: 0,
            language: 'en-US',
            includeRelatedQueries: true,
            includeRelatedTopics: false,
            maxRetries: 5,
        });
    });
});

describe('defaults and missing values', () => {
    it('minimal valid input gets every default', () => {
        expect(parseInput({ keywords: ['bitcoin'] }, NOW)).toEqual({
            keywords: ['bitcoin'],
            geo: '',
            timeRange: 'today 12-m',
            category: 0,
            language: 'en-US',
            includeRelatedQueries: true,
            includeRelatedTopics: false,
            maxRetries: 5,
            proxyConfiguration: undefined,
        });
    });

    it('null and undefined fields get defaults', () => {
        const fields = ['geo', 'timeRange', 'category', 'language', 'includeRelatedQueries', 'includeRelatedTopics', 'maxRetries', 'proxyConfiguration'];
        for (const v of [null, undefined]) {
            const raw = Object.fromEntries(fields.map((f) => [f, v]));
            expect(parse(raw)).toEqual(parse());
        }
    });

    it('unknown fields are ignored', () => {
        const out = parse({ foo: 1, bar: { x: 'y' } });
        expect(out).toEqual(parse());
        expect(out).not.toHaveProperty('foo');
    });

    it('works without an injected now (defaults to current time)', () => {
        expect(parseInput({ keywords: ['a'], timeRange: '2020-01-01 2020-12-31' }).timeRange).toBe('2020-01-01 2020-12-31');
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['array', [{ keywords: ['a'] }]],
        ['string', 'bitcoin'],
        ['number', 42],
    ])('non-object raw input (%s) -> InputError mentioning keywords', (_label, raw) => {
        const err = catchInputError(raw);
        expect(err.issues.length).toBeGreaterThanOrEqual(1);
        expect(err.issues.some((i) => i.startsWith('keywords'))).toBe(true);
        expect(err.message).toContain('keywords');
    });

    it.each([
        ['missing', {}],
        ['null', { keywords: null }],
    ])('keywords %s -> required issue', (_label, raw) => {
        expectSingleIssue(raw, 'keywords');
    });
});

describe('keywords', () => {
    it('trims items', () => {
        expect(parse({ keywords: ['  bitcoin  ', '\tether\n'] }).keywords).toEqual(['bitcoin', 'ether']);
    });

    it.each([
        ['string', 'bitcoin'],
        ['object', { a: 1 }],
        ['number', 5],
    ])('non-array keywords (%s) is an issue', (_label, keywords) => {
        expectSingleIssue({ keywords }, 'keywords');
    });

    it.each([
        ['number', 5],
        ['null', null],
        ['object', {}],
        ['boolean', true],
    ])('non-string item (%s) is an issue at keywords[i]', (_label, item) => {
        expectSingleIssue({ keywords: ['a', 'b', item] }, 'keywords[2]');
    });

    it.each(['', '   ', '\t\n'])('item empty after trim (%j) is an issue', (item) => {
        expectSingleIssue({ keywords: ['a', item] }, 'keywords[1]');
    });

    it('100 chars is OK, 101 chars is an issue', () => {
        const ok = 'x'.repeat(100);
        expect(parse({ keywords: [ok] }).keywords).toEqual([ok]);
        expectSingleIssue({ keywords: ['a', 'y'.repeat(101)] }, 'keywords[1]');
    });

    it('length is measured after trimming', () => {
        const padded = `   ${'x'.repeat(100)}   `;
        expect(parse({ keywords: [padded] }).keywords).toEqual(['x'.repeat(100)]);
    });

    it('dedupes case-insensitively, keeping first occurrence and its casing', () => {
        expect(parse({ keywords: ['Bitcoin', 'ether', 'BITCOIN', ' bitcoin ', 'Ether', 'doge'] }).keywords)
            .toEqual(['Bitcoin', 'ether', 'doge']);
    });

    it('0 keywords is an issue', () => {
        expectSingleIssue({ keywords: [] }, 'keywords');
    });

    it.each([1, 20])('%i unique keywords is OK', (n) => {
        expect(parse({ keywords: kw(n) }).keywords).toEqual(kw(n));
    });

    it('21 unique keywords is an issue', () => {
        expectSingleIssue({ keywords: kw(21) }, 'keywords');
    });

    it('21 items that dedupe to 20 pass', () => {
        const items = [...kw(20), 'KW0'];
        expect(parse({ keywords: items }).keywords).toEqual(kw(20));
    });

    it('30 items that dedupe to 3 pass', () => {
        const items = Array.from({ length: 30 }, (_, i) => ['a', 'B', 'c'][i % 3]!);
        expect(parse({ keywords: items }).keywords).toEqual(['a', 'B', 'c']);
    });
});

describe('geo', () => {
    it.each([
        ['', ''],
        ['US', 'US'],
        ['us', 'US'],
        ['US-CA', 'US-CA'],
        ['us-ca', 'US-CA'],
        ['  gb  ', 'GB'],
        ['GB-ENG', 'GB-ENG'],
        ['IN-1', 'IN-1'],
    ])('accepts %j -> %j', (geo, expected) => {
        expect(parse({ geo }).geo).toBe(expected);
    });

    it.each(['USA', 'U', 'US-', 'US-CALI', 'U1', '12', 'US CA', 'US_CA', 'US-CA-X'])('rejects %j', (geo) => {
        expectSingleIssue({ keywords: ['a'], geo }, 'geo');
    });

    it.each([[1], [['US']], [{}], [true]])('rejects non-string %j', (geo) => {
        expectSingleIssue({ keywords: ['a'], geo }, 'geo');
    });
});

describe('timeRange', () => {
    it.each(PRESETS)('accepts preset %j', (timeRange) => {
        expect(parse({ timeRange }).timeRange).toBe(timeRange);
    });

    it('trims whitespace', () => {
        expect(parse({ timeRange: '  today 3-m  ' }).timeRange).toBe('today 3-m');
        expect(parse({ timeRange: ' 2020-01-01 2020-06-30 ' }).timeRange).toBe('2020-01-01 2020-06-30');
    });

    it.each(['ALL', 'Today 12-m', 'now 1-h', 'NOW 7-D', 'today 2-m', 'yesterday', ''])('rejects %j (case-sensitive / unknown)', (timeRange) => {
        expectSingleIssue({ keywords: ['a'], timeRange }, 'timeRange');
    });

    it.each([[12], [true], [['all']]])('rejects non-string %j', (timeRange) => {
        expectSingleIssue({ keywords: ['a'], timeRange }, 'timeRange');
    });

    it.each([
        '2004-01-01 2004-12-31',
        '2024-02-29 2024-03-01',
        '2020-05-05 2020-05-05',
        '2025-01-01 2026-10-22',
    ])('accepts custom range %j', (timeRange) => {
        expect(parse({ timeRange }).timeRange).toBe(timeRange);
    });

    it('end == today (UTC) is OK even at the start of the UTC day', () => {
        expect(parse({ timeRange: '2026-01-01 2026-10-22' }, new Date('2026-10-22T00:00:01Z')).timeRange)
            .toBe('2026-01-01 2026-10-22');
    });

    it.each([
        ['invalid calendar date start', '2023-02-29 2023-03-01'],
        ['invalid calendar date end', '2024-01-01 2024-02-30'],
        ['month 13', '2020-13-01 2020-12-31'],
        ['day 00', '2020-01-00 2020-12-31'],
        ['start before 2004-01-01', '2003-12-31 2004-06-01'],
        ['start after end', '2020-06-02 2020-06-01'],
        ['end in the future', '2026-01-01 2026-10-23'],
        ['wrong separator', '2020/01/01 2020/06/30'],
        ['single date', '2020-01-01'],
        ['two spaces', '2020-01-01  2020-06-30'],
    ])('rejects %s (%j)', (_label, timeRange) => {
        expectSingleIssue({ keywords: ['a'], timeRange }, 'timeRange');
    });

    it('future check uses the injected now', () => {
        const range = '2026-01-01 2026-10-23';
        expectSingleIssue({ keywords: ['a'], timeRange: range }, 'timeRange', NOW);
        expect(parse({ timeRange: range }, new Date('2026-10-23T00:00:00Z')).timeRange).toBe(range);
    });
});

describe('category', () => {
    it.each([0, 1, 71, 1_000_000])('accepts %i', (category) => {
        expect(parse({ category }).category).toBe(category);
    });

    it.each([[1.5], [-1], ['7'], [true], [Number.NaN], [Number.POSITIVE_INFINITY]])('rejects %j', (category) => {
        expectSingleIssue({ keywords: ['a'], category }, 'category');
    });
});

describe('language', () => {
    it.each(['en', 'en-US', 'pt-BR', 'zh-Hant', 'fil'])('accepts %j', (language) => {
        expect(parse({ language }).language).toBe(language);
    });

    it.each(['EN', 'english', 'e', 'en_US', 'en-', 'en-USAXX', 'en-U', [], 5])('rejects %j', (language) => {
        expectSingleIssue({ keywords: ['a'], language }, 'language');
    });
});

describe('booleans', () => {
    it.each(['includeRelatedQueries', 'includeRelatedTopics'] as const)('%s accepts true and false', (field) => {
        expect(parse({ [field]: true })[field]).toBe(true);
        expect(parse({ [field]: false })[field]).toBe(false);
    });

    it.each([
        ['includeRelatedQueries', 'true'],
        ['includeRelatedQueries', 'false'],
        ['includeRelatedQueries', 1],
        ['includeRelatedTopics', 'true'],
        ['includeRelatedTopics', 0],
        ['includeRelatedTopics', {}],
    ])('%s rejects %j', (field, value) => {
        expectSingleIssue({ keywords: ['a'], [field]: value }, field);
    });
});

describe('maxRetries', () => {
    it.each([0, 1, 5, 8])('accepts %i', (maxRetries) => {
        expect(parse({ maxRetries }).maxRetries).toBe(maxRetries);
    });

    it.each([[9], [-1], [2.5], ['3'], [true], [Number.NaN]])('rejects %j', (maxRetries) => {
        expectSingleIssue({ keywords: ['a'], maxRetries }, 'maxRetries');
    });
});

describe('proxyConfiguration', () => {
    it('passes a plain object through unchanged', () => {
        const proxyConfiguration = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'US' };
        const out = parse({ proxyConfiguration });
        expect(out.proxyConfiguration).toEqual({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'US' });
    });

    it('is undefined when absent', () => {
        expect(parse().proxyConfiguration).toBeUndefined();
    });

    it.each([[['a']], ['residential'], [true], [3]])('rejects non-object %j', (proxyConfiguration) => {
        expectSingleIssue({ keywords: ['a'], proxyConfiguration }, 'proxyConfiguration');
    });
});

describe('multiple problems', () => {
    it('reports every problem in one InputError, one issue per problem, each prefixed by field path', () => {
        const err = catchInputError({
            keywords: ['ok', '   ', 7, 'z'.repeat(101)],
            geo: 'USA',
            timeRange: 'today 2-m',
            category: -1,
            language: 'english',
            includeRelatedQueries: 'true',
            includeRelatedTopics: 'false',
            maxRetries: 9,
            proxyConfiguration: 'nope',
        });
        const prefixes = [
            'keywords[1]', 'keywords[2]', 'keywords[3]',
            'geo', 'timeRange', 'category', 'language',
            'includeRelatedQueries', 'includeRelatedTopics', 'maxRetries', 'proxyConfiguration',
        ];
        expect(err.issues, JSON.stringify(err.issues)).toHaveLength(prefixes.length);
        for (const p of prefixes) {
            expect(err.issues.filter((i) => i.startsWith(`${p}:`) || i.startsWith(`${p} `)), p).toHaveLength(1);
        }
        for (const issue of err.issues) {
            expect(err.message).toContain(issue);
        }
    });

    it('keyword item issues and a count issue can coexist', () => {
        const err = catchInputError({ keywords: [...kw(21), ''] });
        expect(err.issues.some((i) => i.startsWith('keywords[21]'))).toBe(true);
        expect(err.issues.some((i) => /^keywords[^[]/.test(i))).toBe(true);
    });
});

// §3 updated rule: "More than 20 is always reported, even alongside item issues. Fewer than 1 is
// reported only when no item has an issue, because fixing an item could resolve it."
describe('keyword count issue vs item issues (§3 updated rule)', () => {
    const countIssues = (issues: string[]) => issues.filter((i) => /^keywords[^[]/.test(i));

    it("{ keywords: [''] } -> keywords[0] issue but no top-level count issue", () => {
        const err = catchInputError({ keywords: [''] });
        expect(err.issues.some((i) => i.startsWith('keywords[0]')), JSON.stringify(err.issues)).toBe(true);
        expect(countIssues(err.issues), JSON.stringify(err.issues)).toEqual([]);
    });

    it('21 unique valid + one empty -> both the item issue and the count issue', () => {
        const err = catchInputError({ keywords: [...kw(21), ''] });
        expect(err.issues.some((i) => i.startsWith('keywords[21]')), JSON.stringify(err.issues)).toBe(true);
        expect(countIssues(err.issues), JSON.stringify(err.issues)).toHaveLength(1);
    });
});
