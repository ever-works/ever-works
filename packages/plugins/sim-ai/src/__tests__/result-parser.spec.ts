import { describe, it, expect } from 'vitest';
import { parseSimOutput, deduplicateItems } from '../utils/result-parser.js';

describe('parseSimOutput', () => {
	it('should parse valid output with items array', () => {
		const result = parseSimOutput({
			items: [
				{ name: 'Item 1', description: 'Desc 1', url: 'https://example.com/1', category: 'Tools' },
				{ name: 'Item 2', description: 'Desc 2', tags: ['tag1', 'tag2'] }
			],
			categories: [{ name: 'Tools', description: 'Dev tools' }],
			tags: [{ name: 'tag1' }, { name: 'tag2' }]
		});

		expect(result.items).toHaveLength(2);
		expect(result.items[0].name).toBe('Item 1');
		expect(result.items[0].source_url).toBe('https://example.com/1');
		expect(result.items[0].category).toBe('Tools');
		expect(result.items[1].tags).toEqual(['tag1', 'tag2']);
		expect(result.categories).toHaveLength(1);
		expect(result.tags).toHaveLength(2);
	});

	it('should parse a direct array of items', () => {
		const result = parseSimOutput([
			{ name: 'Item 1', description: 'Desc 1' },
			{ name: 'Item 2', description: 'Desc 2' }
		]);

		expect(result.items).toHaveLength(2);
	});

	it('should handle nested output field (async result)', () => {
		const result = parseSimOutput({
			output: {
				items: [{ name: 'Async Item' }]
			}
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Async Item');
	});

	it('should handle nested data field', () => {
		const result = parseSimOutput({
			data: {
				items: [{ name: 'Data Item' }]
			}
		});

		expect(result.items).toHaveLength(1);
	});

	it('should extract categories from item references', () => {
		const result = parseSimOutput({
			items: [
				{ name: 'Item 1', category: 'Cat A' },
				{ name: 'Item 2', category: 'Cat B' },
				{ name: 'Item 3', category: 'Cat A' }
			]
		});

		expect(result.categories).toHaveLength(2);
		expect(result.categories.map((c) => c.name)).toContain('Cat A');
		expect(result.categories.map((c) => c.name)).toContain('Cat B');
	});

	it('should extract tags from items', () => {
		const result = parseSimOutput({
			items: [
				{ name: 'Item 1', tags: ['tag1', 'tag2'] },
				{ name: 'Item 2', tags: ['tag2', 'tag3'] }
			]
		});

		expect(result.tags).toHaveLength(3);
	});

	it('should extract brands from items', () => {
		const result = parseSimOutput({
			items: [
				{ name: 'Item 1', brand: 'Brand A' },
				{ name: 'Item 2', brand: 'Brand B' }
			],
			brands: [{ name: 'Brand A', url: 'https://branda.com' }]
		});

		expect(result.brands).toHaveLength(2);
		expect(result.brands.find((b) => b.name === 'Brand A')?.url).toBe('https://branda.com');
	});

	it('should skip items without a name', () => {
		const result = parseSimOutput({
			items: [
				{ name: 'Valid', description: 'Has name' },
				{ description: 'No name' },
				{ name: '', description: 'Empty name' }
			]
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Valid');
	});

	it('should handle source_url field', () => {
		const result = parseSimOutput({
			items: [{ name: 'Item', source_url: 'https://example.com' }]
		});

		expect(result.items[0].source_url).toBe('https://example.com');
	});

	it('should prefer url over source_url', () => {
		const result = parseSimOutput({
			items: [{ name: 'Item', url: 'https://a.com', source_url: 'https://b.com' }]
		});

		expect(result.items[0].source_url).toBe('https://a.com');
	});

	it('should throw on empty output', () => {
		expect(() => parseSimOutput(null)).toThrow('empty or non-object');
		expect(() => parseSimOutput(undefined)).toThrow('empty or non-object');
	});

	it('should throw on output without items', () => {
		expect(() => parseSimOutput({ foo: 'bar' })).toThrow('does not contain an "items" array');
	});

	it('should handle items with image arrays', () => {
		const result = parseSimOutput({
			items: [{ name: 'Item', images: ['https://img.com/1.png', 'https://img.com/2.png'] }]
		});

		expect(result.items[0].images).toEqual(['https://img.com/1.png', 'https://img.com/2.png']);
	});

	it('should trim whitespace from names', () => {
		const result = parseSimOutput({
			items: [{ name: '  Padded Name  ', category: '  Cat  ' }]
		});

		expect(result.items[0].name).toBe('Padded Name');
		expect(result.items[0].category).toBe('Cat');
	});

	it('should filter non-string tags', () => {
		const result = parseSimOutput({
			items: [{ name: 'Item', tags: ['valid', 123, null, 'also-valid'] }]
		});

		expect(result.items[0].tags).toEqual(['valid', 'also-valid']);
	});
});

describe('deduplicateItems', () => {
	it('should remove items that match existing names', () => {
		const items = [
			{ name: 'Item 1', description: 'New' },
			{ name: 'Item 2', description: 'New' },
			{ name: 'Item 3', description: 'New' }
		] as never[];

		const result = deduplicateItems(items, ['Item 1', 'Item 3']);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('Item 2');
	});

	it('should be case-insensitive', () => {
		const items = [{ name: 'My Item', description: 'New' }] as never[];
		const result = deduplicateItems(items, ['MY ITEM']);
		expect(result).toHaveLength(0);
	});

	it('should trim whitespace for comparison', () => {
		const items = [{ name: ' Item ', description: 'New' }] as never[];
		const result = deduplicateItems(items, ['Item']);
		expect(result).toHaveLength(0);
	});

	it('should return all items when no existing names', () => {
		const items = [
			{ name: 'A', description: 'New' },
			{ name: 'B', description: 'New' }
		] as never[];

		const result = deduplicateItems(items, []);
		expect(result).toHaveLength(2);
	});
});
