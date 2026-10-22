// Real-data smoke test for the built Actor (IMPLEMENTATION_PLAN.md §6, Part 6).
// Prerequisite: `npm run build`. Usage:
//   npx tsx scripts/smoke.ts [keywords…] [--geo US | --geo=] [--time "today 12-m"] [--topics] [--no-queries] [--max-retries N]
// `--geo=` = worldwide (use this form in Windows PowerShell, which drops empty "" arguments).
// Runs `node dist/main.js` against a fresh temp storage dir with NO proxy, then validates and summarises the output.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';

interface Section { status: string; top?: unknown[] | null; rising?: { isBreakout?: boolean }[] | null; error?: string }
interface Timeline { status: string; resolution: string | null; points: unknown[] | null; error?: string }
interface Rec { keyword: string; status: string; interestOverTime: Timeline; relatedQueries: Section; relatedTopics: Section; scrapedAt: string }

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv: string[]) {
    const keywords: string[] = [];
    let geo = 'US';
    let timeRange = 'today 12-m';
    let topics = false;
    let queries = true;
    let maxRetries: number | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] as string;
        // `--geo=` (empty) means worldwide; Windows PowerShell 5.1 drops a bare "" argument.
        if (a.startsWith('--geo=')) geo = a.slice('--geo='.length);
        else if (a.startsWith('--time=')) timeRange = a.slice('--time='.length);
        else if (a === '--geo') geo = argv[++i] ?? '';
        else if (a === '--time') timeRange = argv[++i] ?? '';
        else if (a === '--topics') topics = true;
        else if (a === '--no-queries') queries = false;
        else if (a === '--max-retries') maxRetries = Number(argv[++i]);
        else keywords.push(a);
    }
    if (keywords.length === 0) keywords.push('coffee', 'solar panels', 'chatgpt');
    return { keywords, geo, timeRange, topics, queries, maxRetries };
}

const opts = parseArgs(process.argv.slice(2));
const dist = join(repoRoot, 'dist', 'main.js');
if (!existsSync(dist)) {
    console.error('dist/main.js not found: run `npm run build` first.');
    process.exit(2);
}

const storage = mkdtempSync(join(tmpdir(), 'gts-smoke-'));
const kvDir = join(storage, 'key_value_stores', 'default');
mkdirSync(kvDir, { recursive: true });
const input: Record<string, unknown> = {
    keywords: opts.keywords,
    geo: opts.geo,
    timeRange: opts.timeRange,
    includeRelatedQueries: opts.queries,
    includeRelatedTopics: opts.topics,
};
if (opts.maxRetries !== undefined) input.maxRetries = opts.maxRetries;
writeFileSync(join(kvDir, 'INPUT.json'), JSON.stringify(input, null, 2));

const rssFile = join(storage, 'maxrss.txt');
const preload = join(storage, 'preload.mjs');
writeFileSync(preload, `import { writeFileSync } from 'node:fs';\nprocess.on('exit', () => { try { writeFileSync(${JSON.stringify(rssFile)}, String(process.resourceUsage().maxRSS)); } catch {} });\n`);

console.log(`[smoke] storage: ${storage}`);
console.log(`[smoke] input: ${JSON.stringify(input)}`);

let retryCount = 0;
let pending = '';
const countRetries = (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const l of lines) if (/WARN.*Retry \d/.test(l)) retryCount++;
};

const started = Date.now();
const exitCode: number = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, dist], {
        cwd: repoRoot,
        env: { ...process.env, CRAWLEE_STORAGE_DIR: storage, APIFY_LOCAL_STORAGE_DIR: storage, APIFY_PURGE_ON_START: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const s of [child.stdout, child.stderr]) {
        s.setEncoding('utf8');
        s.on('data', (c: string) => { (s === child.stdout ? process.stdout : process.stderr).write(c); countRetries(c); });
    }
    child.on('close', (code) => resolve(code ?? 1));
});
countRetries('\n');
const wallMs = Date.now() - started;

// --- read output ---
const dsDir = join(storage, 'datasets', 'default');
const records: Rec[] = existsSync(dsDir)
    ? readdirSync(dsDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dsDir, f), 'utf8')) as Rec)
    : [];
const outputPath = join(kvDir, 'OUTPUT.json');
const summary = existsSync(outputPath) ? (JSON.parse(readFileSync(outputPath, 'utf8')) as { startedAt?: string; durationMs?: number }) : undefined;

// --- schema validation ---
const schema = JSON.parse(readFileSync(join(repoRoot, '.actor', 'dataset_schema.json'), 'utf8')) as { fields: object };
const Ajv = AjvModule.default;
const addFormats = addFormatsModule.default;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema.fields);
let invalid = 0;
for (const r of records) {
    const keyword = r.keyword;
    if (!validate(r)) {
        invalid++;
        console.error(`[smoke] SCHEMA INVALID: ${keyword}: ${ajv.errorsText(validate.errors)}`);
    }
}

// --- table ---
const n = (a: unknown[] | null | undefined) => (a ? String(a.length) : '-');
let prev = summary?.startedAt ? Date.parse(summary.startedAt) : started;
const rows = records.map((r) => {
    const t = Date.parse(r.scrapedAt);
    const secs = ((t - prev) / 1000).toFixed(1);
    prev = t;
    const iot = r.interestOverTime;
    const rq = r.relatedQueries;
    return [
        r.keyword,
        r.status,
        `${iot.status} ${n(iot.points)} ${iot.resolution ?? '-'}`,
        `${rq.status} ${n(rq.top)}/${n(rq.rising)}`,
        String(rq.rising?.filter((x) => x.isBreakout).length ?? 0),
        r.relatedTopics.status,
        secs,
    ];
});
const header = ['keyword', 'status', 'timeline (status pts res)', 'relatedQueries (status top/rising)', 'breakouts', 'relatedTopics', 's'];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] as number)).join(' | ');
console.log('\n' + fmt(header));
console.log(widths.map((w) => '-'.repeat(w)).join('-|-'));
for (const r of rows) console.log(fmt(r));

const rate = (key: 'interestOverTime' | 'relatedQueries' | 'relatedTopics') => {
    const c: Record<string, number> = {};
    for (const r of records) c[r[key].status] = (c[r[key].status] ?? 0) + 1;
    const considered = records.filter((r) => r[key].status !== 'skipped').length;
    const good = (c.ok ?? 0) + (c.empty ?? 0);
    return `${JSON.stringify(c)} success(ok+empty)=${considered ? ((100 * good) / considered).toFixed(0) + '%' : 'n/a'}`;
};
const rssKb = existsSync(rssFile) ? Number(readFileSync(rssFile, 'utf8')) : NaN;
console.log('');
console.log(`[smoke] exit code: ${exitCode}`);
console.log(`[smoke] wall time: ${(wallMs / 1000).toFixed(1)} s (actor durationMs: ${summary?.durationMs ?? 'n/a'}); per keyword: ${records.length ? (wallMs / 1000 / records.length).toFixed(1) : 'n/a'} s`);
console.log(`[smoke] peak RSS: ${Number.isFinite(rssKb) ? (rssKb / 1024).toFixed(1) + ' MB' : 'n/a'}`);
console.log(`[smoke] retries: ${retryCount}`);
console.log(`[smoke] interestOverTime: ${rate('interestOverTime')}`);
console.log(`[smoke] relatedQueries:   ${rate('relatedQueries')}`);
console.log(`[smoke] relatedTopics:    ${rate('relatedTopics')}`);
console.log(`[smoke] records: ${records.length}, schema-invalid: ${invalid}`);

process.exit(exitCode !== 0 || invalid > 0 ? 1 : 0);
