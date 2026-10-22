export type TrendsErrorCode = 'RATE_LIMITED' | 'TOKEN_MISMATCH' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'SOURCE_CHANGED';

/** Base class for every failure talking to Google Trends. `retryable` drives the retry loop. */
export class TrendsError extends Error {
    /** Total attempts made before this error was thrown; set by withRetry. */
    attempts = 1;

    constructor(readonly code: TrendsErrorCode, message: string, readonly retryable: boolean, options?: ErrorOptions) {
        super(message, options);
        this.name = new.target.name;
    }
}

/** Non-200 response. Classified by status code only: Google's 429 pages claim "should not be retried", but retrying works. */
export class HttpStatusError extends TrendsError {
    constructor(readonly status: number, endpoint: string, code: TrendsErrorCode = 'HTTP_ERROR') {
        super(code, `${endpoint} returned HTTP ${status}`, status === 429 || status >= 500);
    }
}

export class RateLimitedError extends HttpStatusError {
    constructor(endpoint: string) {
        super(429, endpoint, 'RATE_LIMITED');
    }
}

/** 401: the widget token does not match its request JSON. Retrying the same request cannot succeed. */
export class TokenMismatchError extends HttpStatusError {
    constructor(endpoint: string) {
        super(401, endpoint, 'TOKEN_MISMATCH');
    }
}

export class NetworkError extends TrendsError {
    /** `reason` must already be safe to log (the client strips proxy credentials). */
    constructor(endpoint: string, reason: string) {
        super('NETWORK_ERROR', `${endpoint} request failed: ${reason}`, true);
    }
}

/** The response did not have the shape we rely on, so the unofficial endpoint has probably changed. */
export class SourceChangedError extends TrendsError {
    constructor(message: string, options?: ErrorOptions) {
        super('SOURCE_CHANGED', message, false, options);
    }
}

export function httpError(status: number, endpoint: string): HttpStatusError {
    if (status === 429) return new RateLimitedError(endpoint);
    if (status === 401) return new TokenMismatchError(endpoint);
    return new HttpStatusError(status, endpoint);
}
