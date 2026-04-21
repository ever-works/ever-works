import { describe, it, expect } from 'vitest';
import { parseMakeOutput, deduplicateItems } from '../utils/result-parser.js';

describe('parseMakeOutput', () => {
	const fullItem = (overrides: Record<string, unknown> = {}) => ({
		name: 'Item',
		description: 'A description',
		url: 'https://example.com',
		category: 'Tools',
		...overrides
	});

	it('should parse valid output with items array', () => {
		const result = parseMakeOutput({
			items: [
				fullItem({ name: 'Item 1', description: 'Desc 1', url: 'https://example.com/1', category: 'Tools' }),
				fullItem({
					name: 'Item 2',
					description: 'Desc 2',
					url: 'https://example.com/2',
					category: 'Tools',
					tags: ['tag1', 'tag2']
				})
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
		const result = parseMakeOutput([
			fullItem({ name: 'Item 1', description: 'Desc 1' }),
			fullItem({ name: 'Item 2', description: 'Desc 2' })
		]);

		expect(result.items).toHaveLength(2);
	});

	it('should parse a JSON string containing items', () => {
		const result = parseMakeOutput(JSON.stringify({ items: [fullItem({ name: 'Stringified Item' })] }));
		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Stringified Item');
	});

	it('should handle nested output field (async result)', () => {
		const result = parseMakeOutput({
			output: {
				items: [fullItem({ name: 'Async Item' })]
			}
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Async Item');
	});

	it('should handle nested data field', () => {
		const result = parseMakeOutput({
			data: {
				items: [fullItem({ name: 'Data Item' })]
			}
		});

		expect(result.items).toHaveLength(1);
	});

	it('should handle nested body field (webhook response)', () => {
		const result = parseMakeOutput({
			body: {
				items: [fullItem({ name: 'Webhook Item' })]
			}
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Webhook Item');
	});

	it('should extract categories from item references', () => {
		const result = parseMakeOutput({
			items: [
				fullItem({ name: 'Item 1', category: 'Cat A' }),
				fullItem({ name: 'Item 2', category: 'Cat B' }),
				fullItem({ name: 'Item 3', category: 'Cat A' })
			]
		});

		expect(result.categories).toHaveLength(2);
		expect(result.categories.map((c) => c.name)).toContain('Cat A');
		expect(result.categories.map((c) => c.name)).toContain('Cat B');
	});

	it('should extract tags from items', () => {
		const result = parseMakeOutput({
			items: [
				fullItem({ name: 'Item 1', tags: ['tag1', 'tag2'] }),
				fullItem({ name: 'Item 2', tags: ['tag2', 'tag3'] })
			]
		});

		expect(result.tags).toHaveLength(3);
	});

	it('should extract brands from items', () => {
		const result = parseMakeOutput({
			items: [fullItem({ name: 'Item 1', brand: 'Brand A' }), fullItem({ name: 'Item 2', brand: 'Brand B' })],
			brands: [{ name: 'Brand A', url: 'https://branda.com' }]
		});

		expect(result.brands).toHaveLength(2);
		expect(result.brands.find((b) => b.name === 'Brand A')?.website).toBe('https://branda.com');
	});

	it('should skip items without a name', () => {
		const result = parseMakeOutput({
			items: [
				fullItem({ name: 'Valid' }),
				fullItem({ name: undefined, description: 'No name' }),
				fullItem({ name: '', description: 'Empty name' })
			]
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Valid');
	});

	it('should skip items missing description, source_url, or category', () => {
		expect(() =>
			parseMakeOutput({
				items: [
					{ name: 'No description', url: 'https://example.com', category: 'Tools' },
					{ name: 'No url', description: 'Has desc', category: 'Tools' },
					{ name: 'No category', description: 'Has desc', url: 'https://example.com' }
				]
			})
		).toThrow('no usable items');
	});

	it('should keep items that have all required fields and skip invalid siblings', () => {
		const result = parseMakeOutput({
			items: [
				{ name: 'Valid', description: 'Ok', url: 'https://example.com', category: 'Tools' },
				{ name: 'Missing category', description: 'Ok', url: 'https://example.com' }
			]
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Valid');
	});

	it('should handle source_url field', () => {
		const result = parseMakeOutput({
			items: [fullItem({ name: 'Item', url: undefined, source_url: 'https://example.com' })]
		});

		expect(result.items[0].source_url).toBe('https://example.com');
	});

	it('should prefer url over source_url', () => {
		const result = parseMakeOutput({
			items: [fullItem({ name: 'Item', url: 'https://a.com', source_url: 'https://b.com' })]
		});

		expect(result.items[0].source_url).toBe('https://a.com');
	});

	it('should throw on empty output', () => {
		expect(() => parseMakeOutput(null)).toThrow('empty or non-object');
		expect(() => parseMakeOutput(undefined)).toThrow('empty or non-object');
	});

	it('should throw on output without items', () => {
		expect(() => parseMakeOutput({ foo: 'bar' })).toThrow('does not contain an "items" array');
	});

	it('should throw when the string output is not valid JSON', () => {
		expect(() => parseMakeOutput('not json at all')).toThrow('is not valid JSON');
	});

	it('should handle items with image arrays', () => {
		const result = parseMakeOutput({
			items: [fullItem({ name: 'Item', images: ['https://img.com/1.png', 'https://img.com/2.png'] })]
		});

		expect(result.items[0].images).toEqual(['https://img.com/1.png', 'https://img.com/2.png']);
	});

	it('should trim whitespace from names', () => {
		const result = parseMakeOutput({
			items: [fullItem({ name: '  Padded Name  ', category: '  Cat  ' })]
		});

		expect(result.items[0].name).toBe('Padded Name');
		expect(result.items[0].category).toBe('Cat');
	});

	it('should filter non-string tags', () => {
		const result = parseMakeOutput({
			items: [fullItem({ name: 'Item', tags: ['valid', 123, null, 'also-valid'] })]
		});

		expect(result.items[0].tags).toEqual(['valid', 'also-valid']);
	});

	it('should throw when items array is empty', () => {
		expect(() => parseMakeOutput({ items: [] })).toThrow('no usable items');
	});

	it('should throw an actionable error when Make returns the default "Accepted" response', () => {
		expect(() => parseMakeOutput('Accepted')).toThrow(/Webhook Response/i);
		expect(() => parseMakeOutput('accepted.')).toThrow(/Webhook Response/i);
	});

	it('should parse markdown-fenced JSON', () => {
		const fenced = '```json\n' + JSON.stringify({ items: [fullItem({ name: 'Fenced' })] }) + '\n```';
		const result = parseMakeOutput(fenced);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Fenced');
	});

	it('should throw a clear error when webhook returns HTML', () => {
		expect(() => parseMakeOutput('<!doctype html><html><body>Login</body></html>')).toThrow(
			/HTML instead of JSON/i
		);
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
