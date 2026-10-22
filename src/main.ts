import { Actor, log } from 'apify';

// Part 1 scaffold: Actor lifecycle only. Validation, scraping and output arrive in Parts 2-5.
await Actor.init();

const input = await Actor.getInput<Record<string, unknown>>();
log.info('Google Trends Scraper started', { inputKeys: Object.keys(input ?? {}) });

await Actor.exit();
