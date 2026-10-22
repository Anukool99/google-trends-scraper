// Subprocess tests for dist/main.js, per IMPLEMENTATION_PLAN.md §6 "Part 5 contract" -> main.ts.
// Invalid input only: valid input would reach the network. Requires `npm run build` first.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runMain(inputJson: string): { status: number | null; output: string; storage: string } {
    const storage = mkdtempSync(join(tmpdir(), 'gts-main-'));
    dirs.push(storage);
    const kvs = join(storage, 'key_value_stores', 'default');
    mkdirSync(kvs, { recursive: true });
    writeFileSync(join(kvs, 'INPUT.json'), inputJson);

    const env: NodeJS.ProcessEnv = { ...process.env, CRAWLEE_STORAGE_DIR: storage, APIFY_LOCAL_STORAGE_DIR: storage };
    for (const k of Object.keys(env)) {
        if (k.startsWith('APIFY_') && k !== 'APIFY_LOCAL_STORAGE_DIR') delete env[k];
    }
    // Make any accidental network attempt fail fast instead of reaching Google.
    env.HTTPS_PROXY = 'http://127.0.0.1:9';
    env.HTTP_PROXY = 'http://127.0.0.1:9';

    const res = spawnSync(process.execPath, [MAIN], { env, encoding: 'utf8', timeout: 60_000 });
    return { status: res.status, output: `${res.stdout ?? ''}\n${res.stderr ?? ''}`, storage };
}

const datasetRecords = (storage: string): string[] => {
    const ds = join(storage, 'datasets', 'default');
    return existsSync(ds) ? readdirSync(ds).filter((f) => f.endsWith('.json')) : [];
};

describe('main.ts with invalid input', () => {
    it('dist/main.js exists (run `npm run build`)', () => {
        expect(existsSync(MAIN)).toBe(true);
    });

    it('{"keywords":[]} -> non-zero exit, mentions keywords, no records', () => {
        const r = runMain('{"keywords":[]}');
        expect(r.status, r.output).not.toBe(0);
        expect(r.status, r.output).not.toBeNull();
        expect(r.output).toContain('keywords');
        expect(datasetRecords(r.storage)).toEqual([]);
    });

    it('invalid maxRetries -> non-zero exit, mentions maxRetries, no records', () => {
        const r = runMain('{"keywords":["coffee"],"maxRetries":99}');
        expect(r.status, r.output).not.toBe(0);
        expect(r.status, r.output).not.toBeNull();
        expect(r.output).toContain('maxRetries');
        expect(datasetRecords(r.storage)).toEqual([]);
    });
});

describe('main.ts with an unusable proxy', () => {
    it('invalid custom proxy URL -> "Proxy configuration failed", non-zero exit, password never printed, no records', () => {
        const r = runMain(
            JSON.stringify({
                keywords: ['coffee'],
                proxyConfiguration: { useApifyProxy: false, proxyUrls: ['http://bob:S3cretPW@not a host:99999'] },
            }),
        );
        expect(r.status, r.output).not.toBe(0);
        expect(r.status, r.output).not.toBeNull();
        expect(r.output).toContain('Proxy configuration failed');
        expect(r.output).not.toContain('S3cretPW');
        expect(datasetRecords(r.storage)).toEqual([]);
    });
});
