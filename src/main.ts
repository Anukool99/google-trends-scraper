import { Actor, log } from 'apify';

import { InputError, parseInput } from './input.js';

// Scraping and output arrive in Parts 3-5.
await Actor.init();

try {
    const input = parseInput(await Actor.getInput());
    log.info('Input validated', {
        keywords: input.keywords.length,
        geo: input.geo || 'worldwide',
        timeRange: input.timeRange,
        includeRelatedQueries: input.includeRelatedQueries,
        includeRelatedTopics: input.includeRelatedTopics,
    });
} catch (err) {
    if (err instanceof InputError) await Actor.fail(err.message);
    throw err;
}

await Actor.exit();
