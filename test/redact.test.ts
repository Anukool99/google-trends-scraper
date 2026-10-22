// Tests for src/redact.ts, from IMPLEMENTATION_PLAN.md §6 Part 5 main.ts: every URL's `user:password@`
// is replaced by `<credentials>@`.
import { describe, expect, it } from 'vitest';
import { errorMessage, redactUrlCredentials } from '../src/redact.js';

describe('redactUrlCredentials', () => {
    it.each([
        ['http://bob:S3cret@proxy.example:8000', 'http://<credentials>@proxy.example:8000'],
        ['https://bob:S3cret@proxy.example/path', 'https://<credentials>@proxy.example/path'],
        ['socks5://bob:S3cret@10.0.0.1:1080', 'socks5://<credentials>@10.0.0.1:1080'],
        ['http://groups-RESIDENTIAL,session-x:apify_proxy_abc@proxy.apify.com:8000', 'http://<credentials>@proxy.apify.com:8000'],
    ])('%s', (input, expected) => {
        const out = redactUrlCredentials(input);
        expect(out).toBe(expected);
    });

    it('redacts every URL inside a longer message', () => {
        const msg = 'failed via http://a:pw1@p1:1 then https://b:pw2@p2:2, giving up';
        const out = redactUrlCredentials(msg);
        expect(out).toBe('failed via http://<credentials>@p1:1 then https://<credentials>@p2:2, giving up');
        expect(out).not.toContain('pw1');
        expect(out).not.toContain('pw2');
    });

    it.each([
        'http://proxy.example:8000',
        'https://trends.google.com/trends/api/explore?hl=en-US',
        'https://example.com/users/a@b/profile',
        'mail a@b about it',
        'no urls here',
        '',
    ])('leaves %j untouched', (s) => {
        expect(redactUrlCredentials(s)).toBe(s);
    });
});

describe('errorMessage', () => {
    it('returns the message of an Error', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom');
        expect(errorMessage(new TypeError('bad type'))).toContain('bad type');
    });

    it.each([['plain string', 'plain string'], [42, '42'], [null, ''], [undefined, ''], [{ a: 1 }, '']])('non-Error %j -> string', (v, contains) => {
        const out = errorMessage(v);
        expect(typeof out).toBe('string');
        expect(out).toContain(contains);
    });
});
