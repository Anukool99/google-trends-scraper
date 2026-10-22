import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

// Placeholder gate for Part 1: Actor config files exist, parse, and agree with the plan's input schema (§3).
describe('Actor configuration', () => {
    it('actor.json points at the input schema', () => {
        const actor = readJson('.actor/actor.json');
        expect(actor.actorSpecification).toBe(1);
        expect(actor.input).toBe('./input_schema.json');
    });

    it('input schema declares the planned fields and defaults', () => {
        const schema = readJson('.actor/input_schema.json');
        expect(schema.required).toEqual(['keywords']);
        expect(schema.properties.keywords.maxItems).toBe(20);
        expect(schema.properties.includeRelatedTopics.default).toBe(false);
        expect(schema.properties.maxRetries.default).toBe(5);
        expect(Object.keys(schema.properties)).toEqual([
            'keywords', 'geo', 'timeRange', 'category', 'language',
            'includeRelatedQueries', 'includeRelatedTopics', 'maxRetries', 'proxyConfiguration',
        ]);
    });

    it('timeRange pattern accepts presets and custom ranges only', () => {
        const pattern = new RegExp(readJson('.actor/input_schema.json').properties.timeRange.pattern);
        for (const ok of ['now 1-H', 'now 7-d', 'today 12-m', 'today 5-y', 'all', '2024-01-01 2024-06-30']) {
            expect(pattern.test(ok), ok).toBe(true);
        }
        for (const bad of ['', 'today 2-m', 'yesterday', '2024-01-01', '2024/01/01 2024/06/30']) {
            expect(pattern.test(bad), bad).toBe(false);
        }
    });
});
