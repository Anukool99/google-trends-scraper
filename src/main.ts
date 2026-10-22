import { Actor, log } from 'apify';

import { InputError, parseInput } from './input.js';
import { errorMessage } from './redact.js';
import { runActor } from './run.js';
import { TrendsClient } from './trends/client.js';

/** Thrown for problems the user can fix; the message is already safe to show. */
class SetupError extends Error {}

await Actor.init();

let client: TrendsClient | undefined;
try {
    const input = parseInput(await Actor.getInput());
    log.info('Input validated', {
        keywords: input.keywords.length,
        geo: input.geo || 'worldwide',
        timeRange: input.timeRange,
        includeRelatedQueries: input.includeRelatedQueries,
        includeRelatedTopics: input.includeRelatedTopics,
    });

    // One sticky session for the whole run: Google's NID cookie is tied to the session that received it.
    // Proxy errors can quote the proxy URL, so only a redacted message ever leaves this block.
    let proxyUrl: string | undefined;
    try {
        const proxyConfiguration = input.proxyConfiguration ? await Actor.createProxyConfiguration(input.proxyConfiguration) : undefined;
        proxyUrl = await proxyConfiguration?.newUrl(`trends_${Date.now()}`);
        // The SDK only warns when Apify Proxy is unavailable (no token, group not on the plan) and hands back no URL;
        // silently scraping without the requested proxy would hide the cause of the 429s that follow.
        const proxyRequested = input.proxyConfiguration?.useApifyProxy === true
            || (Array.isArray(input.proxyConfiguration?.proxyUrls) && input.proxyConfiguration.proxyUrls.length > 0);
        if (proxyRequested && !proxyUrl) throw new Error('a proxy was requested but none could be obtained (check Apify Proxy access and groups)');
        client = new TrendsClient({
            language: input.language,
            maxRetries: input.maxRetries,
            proxyUrl,
            onRetry: ({ attempt, delayMs, error }) => log.warning(
                `Retry ${attempt}/${input.maxRetries} in ${Math.round(delayMs / 1000)} s: ${error.message}`,
                { error: error.code },
            ),
        });
    } catch (err) {
        throw new SetupError(`Proxy configuration failed: ${errorMessage(err)}`);
    }
    log.info(proxyUrl ? 'Using proxy' : 'No proxy configured; Google may rate-limit heavily');

    const summary = await runActor(input, {
        client,
        pushData: (record) => Actor.pushData(record),
        setOutput: (s) => Actor.setValue('OUTPUT', s),
        now: () => new Date(),
        log,
    });
    log.info('Run finished', { ok: summary.ok, partial: summary.partial, failed: summary.failed, durationMs: summary.durationMs });

    if (summary.failed === summary.keywords) {
        await Actor.fail(`All ${summary.keywords} keywords failed. See the dataset records' error fields for details.`);
    }
} catch (err) {
    // Every failure ends the run through Actor.fail so it gets a status message; Actor.fail exits the process.
    const message = err instanceof InputError || err instanceof SetupError ? err.message : `Run failed unexpectedly: ${errorMessage(err)}`;
    log.error(message);
    await Actor.fail(message);
} finally {
    await client?.close();
}

await Actor.exit();
