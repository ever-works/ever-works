import { describe, it, expect } from 'vitest';
import type { MutableItemData } from '../../common/index.js';
import {
	deduplicateByField,
	normalizeUrl,
	normalizeItemName,
	createItemLookupIndex,
	isItemDuplicate,
	filterNewItemsManually
} from '../dedup-utils.js';

const item = (overrides: Partial<MutableItemData> = {}): MutableItemData =>
	({
		name: 'Test Item',
		slug: 'test-item',
		description: 'A test item',
		source_url: 'https://example.com',
		category: 'tools',
		tags: [],
		...overrides
	}) as MutableItemData;

describe('deduplicateByField', () => {
	it('removes duplicates by slug', () => {
		const items = [item({ slug: 'a' }), item({ slug: 'b' }), item({ slug: 'a', name: 'Dupe' })];
		const result = deduplicateByField(items, 'slug');
		expect(result).toHaveLength(2);
	});

	it('returns empty for empty input', () => {
		expect(deduplicateByField([], 'slug')).toEqual([]);
	});

	it('keeps items with null/undefined field values', () => {
		const items = [item({ slug: undefined }), item({ slug: undefined })];
		const result = deduplicateByField(items, 'slug');
		expect(result).toHaveLength(2);
	});

	it('skips dedup if no items have the field', () => {
		const items = [{ name: 'A' }, { name: 'B' }] as any[];
		const result = deduplicateByField(items, 'slug');
		expect(result).toHaveLength(2);
	});

	it('last-write wins for same field value', () => {
		const items = [item({ slug: 'a', name: 'First' }), item({ slug: 'a', name: 'Second' })];
		const result = deduplicateByField(items, 'slug');
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('Second');
	});
});

describe('normalizeUrl', () => {
	it('strips protocol', () => {
		expect(normalizeUrl('https://example.com')).toBe('example.com');
		expect(normalizeUrl('http://example.com')).toBe('example.com');
	});

	it('strips www prefix', () => {
		expect(normalizeUrl('https://www.example.com')).toBe('example.com');
	});

	it('strips trailing slashes', () => {
		expect(normalizeUrl('https://example.com/')).toBe('example.com');
		expect(normalizeUrl('https://example.com///')).toBe('example.com');
	});

	it('strips git tree/blob paths', () => {
		expect(normalizeUrl('https://github.com/user/repo/tree/main/src')).toBe('github.com/user/repo');
		expect(normalizeUrl('https://github.com/user/repo/blob/main/README.md')).toBe('github.com/user/repo');
	});

	it('strips hash fragments', () => {
		expect(normalizeUrl('https://example.com/page#section')).toBe('example.com/page');
	});

	it('strips trailing index files', () => {
		expect(normalizeUrl('https://example.com/index.html')).toBe('example.com');
	});

	it('returns empty for empty input', () => {
		expect(normalizeUrl('')).toBe('');
	});

	it('normalizes www + protocol combo', () => {
		expect(normalizeUrl('https://www.example.com/')).toBe('example.com');
	});
});

describe('normalizeItemName', () => {
	it('strips version numbers', () => {
		expect(normalizeItemName('React 18.2.0')).toBe('react');
	});

	it('strips common tech suffixes', () => {
		expect(normalizeItemName('Express.js Framework')).toBe('express');
	});

	it('lowercases', () => {
		expect(normalizeItemName('MyTool')).toBe('mytool');
	});

	it('returns empty for empty input', () => {
		expect(normalizeItemName('')).toBe('');
	});
});

describe('createItemLookupIndex', () => {
	it('indexes by slug, url, name, and normalized url', () => {
		const items = [item({ slug: 'cursor', name: 'Cursor', source_url: 'https://cursor.sh' })];
		const index = createItemLookupIndex(items);

		expect(index.has('slug:cursor')).toBe(true);
		expect(index.has('url:https://cursor.sh')).toBe(true);
		expect(index.has('name:cursor')).toBe(true);
		expect(index.has('nurl:cursor.sh')).toBe(true);
	});

	it('handles items without slug', () => {
		const items = [item({ slug: undefined, name: 'NoSlug' })];
		const index = createItemLookupIndex(items);
		expect(index.has('name:noslug')).toBe(true);
	});
});

describe('isItemDuplicate', () => {
	it('detects duplicate by slug', () => {
		const index = createItemLookupIndex([item({ slug: 'cursor' })]);
		expect(isItemDuplicate(item({ slug: 'cursor' }), index)).toBe(true);
	});

	it('detects duplicate by source_url', () => {
		const index = createItemLookupIndex([item({ source_url: 'https://cursor.sh' })]);
		expect(isItemDuplicate(item({ source_url: 'https://cursor.sh' }), index)).toBe(true);
	});

	it('detects duplicate by normalized name', () => {
		const index = createItemLookupIndex([item({ name: 'Cursor' })]);
		expect(
			isItemDuplicate(item({ name: 'Cursor', slug: 'different-slug', source_url: 'https://other.com' }), index)
		).toBe(true);
	});

	it('detects duplicate by normalized URL (www vs non-www)', () => {
		const index = createItemLookupIndex([item({ source_url: 'https://www.cursor.sh/' })]);
		expect(isItemDuplicate(item({ slug: 'x', name: 'X', source_url: 'https://cursor.sh' }), index)).toBe(true);
	});

	it('returns false for non-duplicate', () => {
		const index = createItemLookupIndex([
			item({ slug: 'cursor', name: 'Cursor', source_url: 'https://cursor.sh' })
		]);
		expect(
			isItemDuplicate(
				item({ slug: 'vscode', name: 'VS Code', source_url: 'https://code.visualstudio.com' }),
				index
			)
		).toBe(false);
	});
});

describe('filterNewItemsManually', () => {
	it('filters out duplicates', () => {
		const existing = [
			item({ slug: 'a', name: 'A', source_url: 'https://a.com' }),
			item({ slug: 'b', name: 'B', source_url: 'https://b.com' })
		];
		const newItems = [
			item({ slug: 'a', name: 'A', source_url: 'https://a.com' }),
			item({ slug: 'c', name: 'C', source_url: 'https://c.com' })
		];
		const result = filterNewItemsManually(existing, newItems);
		expect(result).toHaveLength(1);
		expect(result[0].slug).toBe('c');
	});

	it('returns all items when no existing', () => {
		const newItems = [item({ slug: 'a' }), item({ slug: 'b' })];
		expect(filterNewItemsManually([], newItems)).toHaveLength(2);
	});

	it('returns empty for empty new items', () => {
		expect(filterNewItemsManually([item()], [])).toEqual([]);
	});

	it('handles URL-based duplicates', () => {
		const existing = [item({ source_url: 'https://example.com' })];
		const newItems = [item({ slug: 'different', name: 'Different', source_url: 'https://example.com' })];
		expect(filterNewItemsManually(existing, newItems)).toHaveLength(0);
	});
});
