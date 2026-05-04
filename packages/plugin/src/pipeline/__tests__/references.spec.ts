import { describe, expect, it } from 'vitest';
import {
	createReferenceEntry,
	filterReferenceUrls,
	mergeReferences,
	normalizeReferenceUrl,
	shouldSkipReferenceUrl
} from '../references.js';

describe('reference utilities', () => {
	it('normalizes URLs by removing common tracking parameters', () => {
		expect(
			normalizeReferenceUrl(
				'https://www.freshbooks.com/en-ca/hub/payroll/best-time-tracking-software?utm_source=x&srsltid=abc&b=2&a=1'
			)
		).toBe('https://www.freshbooks.com/en-ca/hub/payroll/best-time-tracking-software?a=1&b=2');
	});

	it('skips recently processed references within TTL', () => {
		const reference = createReferenceEntry({
			url: 'https://hive.com/blog/time-tracking-tools/?utm_source=test',
			status: 'success',
			now: new Date('2026-05-02T13:36:33.000Z')
		});

		const decision = shouldSkipReferenceUrl('https://hive.com/blog/time-tracking-tools', [reference], {
			ttlDays: 90,
			now: new Date('2026-05-04T00:00:00.000Z')
		});

		expect(decision.shouldSkip).toBe(true);
		expect(decision.reference?.normalized_url).toBe('https://hive.com/blog/time-tracking-tools');
	});

	it('does not skip references older than TTL', () => {
		const reference = createReferenceEntry({
			url: 'https://example.com/list',
			status: 'empty',
			now: new Date('2026-01-01T00:00:00.000Z')
		});

		const decision = shouldSkipReferenceUrl('https://example.com/list', [reference], {
			ttlDays: 30,
			now: new Date('2026-05-04T00:00:00.000Z')
		});

		expect(decision.shouldSkip).toBe(false);
	});

	it('merges references by normalized URL and preserves first seen timestamp', () => {
		const existing = createReferenceEntry({
			url: 'https://example.com/list',
			status: 'empty',
			now: new Date('2026-05-01T00:00:00.000Z')
		});
		const incoming = createReferenceEntry({
			url: 'https://example.com/list?utm_source=again',
			status: 'success',
			itemsCreated: 2,
			now: new Date('2026-05-02T00:00:00.000Z'),
			previous: existing
		});

		expect(mergeReferences([existing], [incoming])).toEqual([
			expect.objectContaining({
				normalized_url: 'https://example.com/list',
				first_seen_at: '2026-05-01T00:00:00.000Z',
				status: 'success',
				items_created: 2
			})
		]);
	});

	it('filters fresh URLs while keeping stale or unknown URLs', () => {
		const references = [
			createReferenceEntry({
				url: 'https://fresh.example.com/list',
				status: 'success',
				now: new Date('2026-05-01T00:00:00.000Z')
			}),
			createReferenceEntry({
				url: 'https://old.example.com/list',
				status: 'success',
				now: new Date('2025-01-01T00:00:00.000Z')
			})
		];

		const result = filterReferenceUrls(
			['https://fresh.example.com/list', 'https://old.example.com/list', 'https://new.example.com/list'],
			references,
			{ ttlDays: 90, now: new Date('2026-05-04T00:00:00.000Z') }
		);

		expect(result.urls).toEqual(['https://old.example.com/list', 'https://new.example.com/list']);
		expect(result.skipped).toHaveLength(1);
	});
});
