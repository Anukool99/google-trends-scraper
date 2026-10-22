// Tests written from IMPLEMENTATION_PLAN.md §6 "Part 3 contract" (retry.ts), not from the implementation.
import { describe, expect, it, vi } from 'vitest';
import { RateLimitedError, TrendsError, httpError } from '../src/trends/errors.js';
import { backoffDelay, isRetryable, withRetry } from '../src/trends/retry.js';

const constant = (v: number) => () => v;

describe('backoffDelay(retry, base, max, random)', () => {
    it.each([
        // retry, random, expected = round(min(max, base*2^(retry-1)) * (0.5 + r*0.5))
        [1, 0, 2000],
        [1, 1, 4000],
        [1, 0.5, 3000],
        [2, 0, 4000],
        [2, 1, 8000],
        [2, 0.5, 6000],
        [3, 0.5, 12000],
        [4, 1, 32000],
        [5, 1, 60000], // 64000 capped at 60000
        [5, 0, 30000],
        [10, 0.5, 45000],
    ])('retry=%i random=%d -> %i (base 4000, max 60000)', (retry, r, expected) => {
        expect(backoffDelay(retry, 4000, 60000, constant(r))).toBe(expected);
    });

    it('grows exponentially until the cap', () => {
        const delays = [1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, 1000, 20000, constant(1)));
        expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 20000, 20000]);
    });

    it('rounds to an integer', () => {
        // 1000 * (0.5 + 0.3333*0.5) = 666.65 -> 667
        expect(backoffDelay(1, 1000, 60000, constant(0.3333))).toBe(667);
        expect(Number.isInteger(backoffDelay(3, 333, 60000, constant(0.123)))).toBe(true);
    });
});

describe('isRetryable', () => {
    it('follows the TrendsError retryable flag; plain errors are not retryable', () => {
        expect(isRetryable(httpError(429, 'explore'))).toBe(true);
        expect(isRetryable(httpError(503, 'explore'))).toBe(true);
        expect(isRetryable(httpError(400, 'explore'))).toBe(false);
        expect(isRetryable(httpError(401, 'explore'))).toBe(false);
        expect(isRetryable(new Error('boom'))).toBe(false);
        expect(isRetryable('string')).toBe(false);
        expect(isRetryable(undefined)).toBe(false);
    });
});

function opts(maxRetries: number, extra: Partial<Parameters<typeof withRetry>[1]> = {}) {
    const sleeps: number[] = [];
    const onRetry = vi.fn();
    return {
        sleeps,
        onRetry,
        options: {
            maxRetries,
            baseDelayMs: 4000,
            maxDelayMs: 60000,
            sleep: async (ms: number) => {
                sleeps.push(ms);
            },
            random: constant(0.5),
            onRetry,
            ...extra,
        },
    };
}

describe('withRetry', () => {
    it('returns the value without sleeping when fn succeeds', async () => {
        const { options, sleeps, onRetry } = opts(3);
        const fn = vi.fn(async () => 42);
        await expect(withRetry(fn, options)).resolves.toBe(42);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(sleeps).toEqual([]);
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('retries retryable TrendsErrors and returns the eventual success', async () => {
        const { options, sleeps } = opts(3);
        let n = 0;
        const fn = vi.fn(async () => {
            n += 1;
            if (n < 3) throw httpError(503, 'explore');
            return 'ok';
        });
        await expect(withRetry(fn, options)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
        expect(sleeps).toEqual([3000, 6000]);
    });

    it('calls fn exactly maxRetries + 1 times, then throws with attempts = calls', async () => {
        const { options, sleeps } = opts(4);
        const fn = vi.fn(async () => {
            throw httpError(429, 'widgetdata/multiline');
        });
        const err = await withRetry(fn, options).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect((err as TrendsError).code).toBe('RATE_LIMITED');
        expect((err as TrendsError).attempts).toBe(5);
        expect(fn).toHaveBeenCalledTimes(5);
        expect(sleeps).toEqual([3000, 6000, 12000, 24000]);
    });

    it('backoff delays use random and cap at maxDelayMs', async () => {
        const { options, sleeps } = opts(6, { random: constant(1), baseDelayMs: 1000, maxDelayMs: 10000 });
        const fn = async () => {
            throw httpError(500, 'explore');
        };
        await expect(withRetry(fn, options)).rejects.toBeInstanceOf(TrendsError);
        expect(sleeps).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
    });

    it('random=0 gives half the nominal delay', async () => {
        const { options, sleeps } = opts(3, { random: constant(0) });
        await withRetry(async () => {
            throw httpError(500, 'explore');
        }, options).catch(() => undefined);
        expect(sleeps).toEqual([2000, 4000, 8000]);
    });

    it('maxRetries=0 -> a single call, no sleep, attempts=1', async () => {
        const { options, sleeps, onRetry } = opts(0);
        const fn = vi.fn(async () => {
            throw httpError(429, 'explore');
        });
        const err = await withRetry(fn, options).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect((err as TrendsError).attempts).toBe(1);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(sleeps).toEqual([]);
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('a plain Error is thrown at once, unchanged', async () => {
        const { options, sleeps } = opts(5);
        const boom = new Error('boom');
        const fn = vi.fn(async () => {
            throw boom;
        });
        await expect(withRetry(fn, options)).rejects.toBe(boom);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(sleeps).toEqual([]);
    });

    it.each([400, 401, 404])('non-retryable TrendsError (%i) is thrown at once with attempts=1', async (status) => {
        const { options, sleeps } = opts(5);
        const fn = vi.fn(async () => {
            throw httpError(status, 'explore');
        });
        const err = await withRetry(fn, options).catch((e: unknown) => e);
        expect((err as { status?: number }).status).toBe(status);
        expect((err as TrendsError).attempts).toBe(1);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(sleeps).toEqual([]);
    });

    it('a non-retryable error after some retries reports attempts = calls made', async () => {
        const { options } = opts(5);
        let n = 0;
        const fn = vi.fn(async () => {
            n += 1;
            throw httpError(n < 3 ? 503 : 400, 'explore');
        });
        const err = await withRetry(fn, options).catch((e: unknown) => e);
        expect((err as { status?: number }).status).toBe(400);
        expect((err as TrendsError).attempts).toBe(3);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('onRetry is called before each sleep with attempt, delayMs and error', async () => {
        const events: string[] = [];
        const errors = [httpError(429, 'explore'), httpError(503, 'explore')];
        let n = 0;
        const onRetry = vi.fn((info: { attempt: number; delayMs: number; error: unknown }) => {
            events.push(`retry:${info.attempt}:${info.delayMs}`);
        });
        const result = await withRetry(
            async () => {
                const e = errors[n];
                n += 1;
                if (e) throw e;
                return 'done';
            },
            {
                maxRetries: 5,
                baseDelayMs: 4000,
                maxDelayMs: 60000,
                random: constant(0.5),
                sleep: async (ms: number) => {
                    events.push(`sleep:${ms}`);
                },
                onRetry,
            },
        );
        expect(result).toBe('done');
        expect(events).toEqual(['retry:1:3000', 'sleep:3000', 'retry:2:6000', 'sleep:6000']);
        expect(onRetry.mock.calls[0]![0].error).toBe(errors[0]);
        expect(onRetry.mock.calls[1]![0].error).toBe(errors[1]);
    });
});
