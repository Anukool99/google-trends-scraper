// Tests written from IMPLEMENTATION_PLAN.md §6 "Part 3 contract" (errors.ts), not from the implementation.
import { describe, expect, it } from 'vitest';
import { HttpStatusError, RateLimitedError, TokenMismatchError, TrendsError, httpError } from '../src/trends/errors.js';
import { fixture } from './helpers/fake-fetch.js';

describe('httpError(status, endpoint)', () => {
    it('429 -> RateLimitedError, retryable, code RATE_LIMITED', () => {
        const err = httpError(429, 'explore');
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err).toBeInstanceOf(TrendsError);
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe('RATE_LIMITED');
        expect(err.retryable).toBe(true);
        expect(err.status).toBe(429);
        expect(err.attempts).toBe(1);
    });

    it('401 -> TokenMismatchError, not retryable, code TOKEN_MISMATCH', () => {
        const err = httpError(401, 'widgetdata/relatedsearches');
        expect(err).toBeInstanceOf(TokenMismatchError);
        expect(err).toBeInstanceOf(TrendsError);
        expect(err.code).toBe('TOKEN_MISMATCH');
        expect(err.retryable).toBe(false);
        expect(err.status).toBe(401);
        expect(err.attempts).toBe(1);
    });

    it.each([500, 502, 503, 504, 599])('%i -> HttpStatusError, retryable', (status) => {
        const err = httpError(status, 'widgetdata/multiline');
        expect(err).toBeInstanceOf(HttpStatusError);
        expect(err).toBeInstanceOf(TrendsError);
        expect(err.code).toBe('HTTP_ERROR');
        expect(err.retryable).toBe(true);
        expect(err.status).toBe(status);
    });

    it.each([400, 403, 404, 302, 204, 418, 499])('%i -> HttpStatusError, not retryable', (status) => {
        const err = httpError(status, 'explore');
        expect(err).toBeInstanceOf(HttpStatusError);
        expect(err).not.toBeInstanceOf(RateLimitedError);
        expect(err).not.toBeInstanceOf(TokenMismatchError);
        expect(err.code).toBe('HTTP_ERROR');
        expect(err.retryable).toBe(false);
        expect(err.status).toBe(status);
    });

    it('classification takes no body: the misleading 429 widget page is irrelevant', () => {
        // The fixture body says "It should not be retried"; httpError only sees the status.
        expect(fixture('rate-limited-429-widget.html')).toContain('should not be retried');
        expect(httpError(429, 'widgetdata/multiline').retryable).toBe(true);
    });
});
