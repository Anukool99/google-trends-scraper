// Test doubles for the Trends client, built from the Part 3 contract in IMPLEMENTATION_PLAN.md §6.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike, FetchResponse } from '../../src/trends/client.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** Reads a raw recorded body (XSSI prefix included) from test/fixtures. */
export const fixture = (name: string): string => readFileSync(`${FIXTURES}${name}`, 'utf8');

/** Parses a fixture body after dropping its XSSI first line. */
export const fixtureJson = (name: string): unknown => {
    const text = fixture(name);
    return JSON.parse(text.slice(text.indexOf('\n') + 1));
};

export interface FakeReply {
    status: number;
    body?: string;
    setCookie?: string[];
    /** When set, the fake fetch throws this instead of responding. */
    throws?: Error;
}

export interface RecordedCall {
    url: URL;
    headers: Record<string, string>;
    dispatcher?: unknown;
    /** Fake clock value when the request started. */
    startedAt: number;
}

/** Case-insensitive header lookup. */
export const header = (headers: Record<string, string>, name: string): string | undefined => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : headers[key];
};

export interface Harness {
    fetch: FetchLike;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    calls: RecordedCall[];
    sleeps: number[];
    /** Moves the fake clock forward without sleeping. */
    advance: (ms: number) => void;
    /** Queues more replies. */
    push: (...replies: FakeReply[]) => void;
}

/**
 * A scripted fetch plus a fake clock. `sleep` records the delay, advances the clock by it and
 * resolves immediately, so pacing is observable via `calls[i].startedAt`.
 */
export function makeHarness(replies: FakeReply[] = [], startTime = 1_000_000): Harness {
    const queue = [...replies];
    const calls: RecordedCall[] = [];
    const sleeps: number[] = [];
    let clock = startTime;

    const fetch: FetchLike = async (url, init) => {
        calls.push({ url: new URL(url), headers: { ...init.headers }, dispatcher: init.dispatcher, startedAt: clock });
        const reply = queue.shift();
        if (!reply) throw new Error(`fake fetch: no scripted reply for call #${calls.length} (${url})`);
        if (reply.throws) throw reply.throws;
        const res: FetchResponse = {
            status: reply.status,
            headers: { getSetCookie: () => [...(reply.setCookie ?? [])] },
            text: async () => reply.body ?? '',
        };
        return res;
    };

    return {
        fetch,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            clock += ms;
        },
        now: () => clock,
        calls,
        sleeps,
        advance: (ms: number) => {
            clock += ms;
        },
        push: (...more: FakeReply[]) => {
            queue.push(...more);
        },
    };
}

export const ok = (body: string, setCookie?: string[]): FakeReply => ({ status: 200, body, ...(setCookie ? { setCookie } : {}) });
