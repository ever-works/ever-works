import { describe, expect, it } from 'vitest';
import {
	FEED_ACTOR_KINDS,
	FEED_ACTORS_WINDOW_HOURS_DEFAULT,
	FEED_ACTORS_WINDOW_HOURS_MAX,
	FEED_KINDS,
	FEED_MAX_AGENT_FILTER,
	FEED_PAGE_SIZE_DEFAULT,
	FEED_PAGE_SIZE_MAX,
	FEED_TARGET_TYPES
} from '../feed.types.js';

/**
 * The Live Feed limits are shared by the API (which enforces them) and the web
 * (which labels and pre-validates with them). Pinning them here means a change
 * to any one is a deliberate edit both sides pick up together.
 */
describe('feed contract', () => {
	it('lists the five kinds in chip order — keyboard 1-5 follows it', () => {
		expect(FEED_KINDS).toEqual(['work', 'decision', 'delivery', 'problem', 'system']);
	});

	it('lists the four actor kinds and the destination types', () => {
		expect(FEED_ACTOR_KINDS).toEqual(['agent', 'user', 'external', 'system']);
		expect(new Set(FEED_TARGET_TYPES).size).toBe(FEED_TARGET_TYPES.length);
	});

	it('keeps the page and filter limits coherent', () => {
		expect(FEED_PAGE_SIZE_DEFAULT).toBe(30);
		expect(FEED_PAGE_SIZE_MAX).toBe(50);
		expect(FEED_PAGE_SIZE_DEFAULT).toBeLessThanOrEqual(FEED_PAGE_SIZE_MAX);
		expect(FEED_MAX_AGENT_FILTER).toBe(20);
		expect(FEED_ACTORS_WINDOW_HOURS_DEFAULT).toBeLessThanOrEqual(FEED_ACTORS_WINDOW_HOURS_MAX);
	});
});
