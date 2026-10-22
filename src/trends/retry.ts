import { TrendsError } from './errors.js';

export interface RetryOptions {
    /** Retries after the first attempt, so at most maxRetries + 1 attempts in total. */
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    sleep: (ms: number) => Promise<void>;
    random: () => number;
    onRetry?: (info: { attempt: number; delayMs: number; error: TrendsError }) => void;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delay before retry number `retry` (1-based): exponential, capped, with jitter in [50%, 100%]
 * so parallel clients don't retry in lockstep.
 */
export function backoffDelay(retry: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (retry - 1));
    return Math.round(exponential * (0.5 + random() * 0.5));
}

/** Only TrendsErrors marked retryable are retried; anything else (including programming errors) is thrown at once. */
export const isRetryable = (err: unknown): err is TrendsError => err instanceof TrendsError && err.retryable;

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (err instanceof TrendsError) err.attempts = attempt;
            if (!isRetryable(err) || attempt > options.maxRetries) throw err;
            const delayMs = backoffDelay(attempt, options.baseDelayMs, options.maxDelayMs, options.random);
            options.onRetry?.({ attempt, delayMs, error: err });
            await options.sleep(delayMs);
        }
    }
}
