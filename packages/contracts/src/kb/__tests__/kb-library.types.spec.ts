import { describe, expect, it } from 'vitest';
import {
	KB_EXPORT_FORMATS,
	KB_EXPORT_LINK_TTL_HOURS,
	KB_EXPORT_MAX_BYTES,
	KB_EXPORT_MAX_DOCS,
	KB_EXPORT_SYNC_MAX_DOCS,
	KB_LIBRARY_ARCHIVED_FILTERS,
	KB_LIBRARY_FILE_BATCH_MAX,
	KB_LIBRARY_FOLDERS_MAX_PER_ORG,
	KB_LIBRARY_FOLDER_MAX_DEPTH,
	KB_LIBRARY_FOLDER_NAME_MAX,
	KB_LIBRARY_PAGE_SIZE_DEFAULT,
	KB_LIBRARY_PAGE_SIZE_MAX,
	KB_LIBRARY_PINS_MAX_PER_USER,
	KB_LIBRARY_QUERY_MAX,
	KB_LIBRARY_READ_DWELL_MS,
	KB_LIBRARY_ROLLUP_CACHE_MS,
	KB_LIBRARY_SORTS,
	KB_LIBRARY_UNFILED,
	KB_READ_STATES,
	KB_REFERENCE_MAX_PER_MESSAGE,
	KB_REFERENCE_PICKER_DEBOUNCE_MS,
	KB_REFERENCE_PICKER_LIMIT,
	KB_REFERENCE_TOKEN_BUDGET
} from '../kb-library.types.js';

/**
 * Knowledge library limits.
 *
 * Every number below is a user-visible promise (a refusal message quotes it,
 * a page size is sized against it). Pinning the exact values means a silent
 * change to a limit breaks a test instead of quietly changing what people
 * are allowed to do.
 */
describe('knowledge library limits', () => {
	it('pages the library 50 at a time and never more than 200', () => {
		expect(KB_LIBRARY_PAGE_SIZE_DEFAULT).toBe(50);
		expect(KB_LIBRARY_PAGE_SIZE_MAX).toBe(200);
		expect(KB_LIBRARY_PAGE_SIZE_DEFAULT).toBeLessThanOrEqual(KB_LIBRARY_PAGE_SIZE_MAX);
	});

	it('bounds shared folders at 5 levels, 120-character names and 500 per organization', () => {
		expect(KB_LIBRARY_FOLDER_MAX_DEPTH).toBe(5);
		expect(KB_LIBRARY_FOLDER_NAME_MAX).toBe(120);
		expect(KB_LIBRARY_FOLDERS_MAX_PER_ORG).toBe(500);
	});

	it('caps pins at 20 and filing at 100 documents per action', () => {
		expect(KB_LIBRARY_PINS_MAX_PER_USER).toBe(20);
		expect(KB_LIBRARY_FILE_BATCH_MAX).toBe(100);
	});

	it('counts a document as read after 2 seconds and caches rollups for 30 seconds', () => {
		expect(KB_LIBRARY_READ_DWELL_MS).toBe(2000);
		expect(KB_LIBRARY_ROLLUP_CACHE_MS).toBe(30_000);
	});

	it('limits the reference picker to 8 results after a 150 ms debounce', () => {
		expect(KB_REFERENCE_PICKER_LIMIT).toBe(8);
		expect(KB_REFERENCE_PICKER_DEBOUNCE_MS).toBe(150);
	});

	it('injects at most 5 references within a 6000-token budget', () => {
		expect(KB_REFERENCE_MAX_PER_MESSAGE).toBe(5);
		expect(KB_REFERENCE_TOKEN_BUDGET).toBe(6000);
	});

	it('exports up to 25 documents synchronously, 2000 in total, 200 MB, links valid 24 hours', () => {
		expect(KB_EXPORT_SYNC_MAX_DOCS).toBe(25);
		expect(KB_EXPORT_MAX_DOCS).toBe(2000);
		expect(KB_EXPORT_MAX_BYTES).toBe(209_715_200);
		expect(KB_EXPORT_LINK_TTL_HOURS).toBe(24);
	});

	it('bounds the free-text library query at 128 characters', () => {
		expect(KB_LIBRARY_QUERY_MAX).toBe(128);
	});
});

describe('knowledge library vocabularies', () => {
	it('has exactly three read states', () => {
		expect([...KB_READ_STATES]).toEqual(['new', 'updated', 'read']);
	});

	it('sorts by recent change first', () => {
		expect(KB_LIBRARY_SORTS[0]).toBe('recent');
		expect([...KB_LIBRARY_SORTS]).toEqual(['recent', 'title', 'unread']);
	});

	it('excludes archived documents by default', () => {
		expect(KB_LIBRARY_ARCHIVED_FILTERS[0]).toBe('exclude');
		expect([...KB_LIBRARY_ARCHIVED_FILTERS]).toEqual(['exclude', 'only', 'include']);
	});

	it('names the no-folder filter "unfiled", which can never collide with a uuid', () => {
		expect(KB_LIBRARY_UNFILED).toBe('unfiled');
		expect(KB_LIBRARY_UNFILED).not.toMatch(/^[0-9a-f-]{36}$/i);
	});

	it('offers Markdown before PDF', () => {
		expect([...KB_EXPORT_FORMATS]).toEqual(['md', 'pdf']);
	});
});
