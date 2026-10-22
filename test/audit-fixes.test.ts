// Tests for IMPLEMENTATION_PLAN.md §6 "Part 7 contract (audit fixes)", written from the spec, not src/.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InputError, parseInput } from '../src/input.js';
import { normalizeRelated } from '../src/normalize.js';
import { errorMessage, redactUrlCredentials } from '../src/redact.js';
import { TrendsClient } from '../src/trends/client.js';
import { fixtureJson, makeHarness, ok } from './helpers/fake-fetch.js';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const NOW = new Date('2026-10-22T12:00:00Z');

describe('redaction: long input', () => {
    const WORD = 'abcdefghij';
    const long = Array.from({ length: 10_000 }, () => WORD).join(' '); // ~110k chars

    it('100k+ chars finish in under 1 s', () => {
        const t0 = performance.now();
        redactUrlCredentials(long);
        expect(performance.now() - t0).toBeLessThan(1000);
    });

    it('also fast for pathological credential-like input', () => {
        const nasty = 'http://' + 'a:'.repeat(50_000) + 'x';
        const t0 = performance.now();
        redactUrlCredentials(nasty);
        expect(performance.now() - t0).toBeLessThan(1000);
    });

    it('cut text ends with … and has no partial trailing word', () => {
        const out = redactUrlCredentials(long);
        expect(out.endsWith('…')).toBe(true);
        expect(out.length).toBeLessThanOrEqual(4001);
        expect(out.length).toBeGreaterThan(3000);
        const tokens = out.slice(0, -1).trim().split(/\s+/);
        for (const t of tokens) expect(t).toBe(WORD);
    });

    it('text of exactly 4000 chars is not cut', () => {
        const s = 'x'.repeat(4000);
        expect(redactUrlCredentials(s)).toBe(s);
    });

    it.each([
        ['password straddles the cut', 3986],
        ['@ lands after the cut', 3975],
        ['scheme straddles the cut', 3996],
    ])('a URL straddling the 4000 cut leaks no password (%s)', (_n, prefixLen) => {
        const prefix = 'a '.repeat(prefixLen / 2);
        const s = `${prefix}http://bob:Pa55wordSecretValue@proxy.example:8000 ${'tail '.repeat(100)}`;
        const out = redactUrlCredentials(s);
        expect(out).not.toContain('Pa55');
        expect(out).not.toContain('Secret');
        expect(out).not.toContain('bob:P');
    });
});

describe('errorMessage(err, proxyUrls)', () => {
    const PROXY = 'http://bob:S3c/retPW@not a host:1';

    it('replaces the proxy URL verbatim with <proxy>', () => {
        const out = errorMessage(new Error(`connect failed via ${PROXY} (ECONNREFUSED)`), [PROXY]);
        expect(out).toContain('<proxy>');
        expect(out).not.toContain('S3c/retPW');
        expect(out).not.toContain('retPW');
        expect(out).toContain('ECONNREFUSED');
    });

    it('password containing "/" outside the URL -> <redacted>', () => {
        const out = errorMessage(new Error('auth rejected for password S3c/retPW'), [PROXY]);
        expect(out).toContain('<redacted>');
        expect(out).not.toContain('retPW');
        expect(out).not.toContain('S3c');
    });

    it('user:password outside the URL -> <redacted>', () => {
        const out = errorMessage(new Error('bad credentials bob:S3c/retPW given'), [PROXY]);
        expect(out).toContain('<redacted>');
        expect(out).not.toContain('retPW');
    });

    it('non-Error input is redacted too', () => {
        const out = errorMessage(`string thrown: ${PROXY} and S3c/retPW`, [PROXY]);
        expect(typeof out).toBe('string');
        expect(out).not.toContain('retPW');
        expect(out).toContain('string thrown');
    });

    it('then applies redactUrlCredentials to other URLs', () => {
        const out = errorMessage(new Error('via http://eve:other@p2:2'), [PROXY]);
        expect(out).toContain('http://<credentials>@p2:2');
        expect(out).not.toContain('other');
    });

    it('defaults proxyUrls to []', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom');
    });
});

describe('input: control characters in keywords', () => {
    const MSG = (i: number) => `keywords[${i}]: contains control characters (e.g. a line break)`;

    it.each([
        ['line feed', 'coffee\nbeans'],
        ['tab', 'coffee\tbeans'],
        ['NUL', 'coffee\u0000beans'],
        ['DEL', 'coffee\u007fbeans'],
        ['carriage return', 'a\rb'],
        ['U+001F', 'a\u001fb'],
    ])('inner %s is invalid with the exact message', (_n, kw) => {
        let caught: unknown;
        try {
            parseInput({ keywords: ['ok', kw] }, NOW);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(InputError);
        expect((caught as InputError).issues).toEqual([MSG(1)]);
    });

    it('leading/trailing \\n and \\t are still trimmed', () => {
        expect(parseInput({ keywords: ['\n\tcoffee\t\n', ' \r\ntea '] }, NOW).keywords).toEqual(['coffee', 'tea']);
    });
});

describe('related query links', () => {
    const data = (link: string | undefined) => ({
        rankedList: [
            { rankedKeyword: [{ query: 'q', value: 100, formattedValue: '100', ...(link === undefined ? {} : { link }) }] },
            { rankedKeyword: [] },
        ],
    });
    const linkOf = (link: string | undefined) =>
        (normalizeRelated(data(link), 'queries') as unknown as { top: { link: string | null }[] }).top[0]!.link;

    it.each(['@evil.com/x', '//evil.com', 'https://evil.com', 'evil', ''])('%j -> null', (l) => {
        expect(linkOf(l)).toBeNull();
    });

    it('normal /trends/explore link is prefixed unchanged', () => {
        const l = '/trends/explore?q=coffee+shop&date=today+12-m&geo=US';
        expect(linkOf(l)).toBe(`https://trends.google.com${l}`);
    });

    it('missing link -> null', () => {
        expect(linkOf(undefined)).toBeNull();
    });
});

describe('client: inherited property names as widget ids', () => {
    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('widget id %j is ignored', async (badId) => {
        const explore = structuredClone(fixtureJson('explore-ok.txt')) as { widgets: Record<string, unknown>[] };
        const ts = explore.widgets.find((w) => w.id === 'TIMESERIES')!;
        explore.widgets.push({ ...ts, id: badId, token: 'BAD' });
        const body = `)]}'\n${JSON.stringify(explore)}`;
        const h = makeHarness([ok(body, ['NID=1'])]);
        const c = new TrendsClient({ language: 'en-US', maxRetries: 0, fetch: h.fetch, sleep: h.sleep, random: () => 0.5, now: h.now });
        const res = (await c.explore({ keyword: 'coffee', geo: 'US', timeRange: 'today 12-m', category: 0 })) as Record<string, unknown>;
        for (const k of Object.keys(res)) expect(['timeseries', 'relatedQueries', 'relatedTopics']).toContain(k);
        expect(Object.prototype.hasOwnProperty.call(res, badId)).toBe(false);
        expect((res.timeseries as { token: string }).token).toBe(ts.token);
        expect(JSON.stringify(res)).not.toContain('BAD');
    });
});

describe('config', () => {
    it('actor.json defaultRunOptions: 256 MB, 3600 s', () => {
        const opts = readJson('.actor/actor.json').defaultRunOptions;
        expect(opts.memoryMbytes).toBe(256);
        expect(opts.timeoutSecs).toBe(3600);
    });

    it('input schema language pattern equals the §3 pattern', () => {
        expect(readJson('.actor/input_schema.json').properties.language.pattern).toBe('^[a-z]{2,3}(-[A-Za-z]{2,4})?$');
    });

    it('package.json overrides basic-ftp to ^6.2.3', () => {
        expect(readJson('package.json').overrides?.['basic-ftp']).toBe('^6.2.3');
    });
});
