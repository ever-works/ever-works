import { describe, it, expect } from 'vitest';
import { parseZapierOutput, deduplicateItems } from '../utils/result-parser.js';
import type { ZapierFieldMapping } from '../types.js';

const EMPTY_MAPPING: ZapierFieldMapping = { nameField: 'name' };

describe('parseZapierOutput — structured shape', () => {
	it('should parse a valid { items: [...] } payload', () => {
		const result = parseZapierOutput(
			{
				items: [
					{ name: 'Item 1', description: 'Desc 1', url: 'https://example.com/1', category: 'Tools' },
					{ name: 'Item 2', description: 'Desc 2', tags: ['tag1', 'tag2'] }
				],
				categories: [{ name: 'Tools', description: 'Dev tools' }],
				tags: [{ name: 'tag1' }, { name: 'tag2' }]
			},
			'structured',
			EMPTY_MAPPING
		);

		expect(result.items).toHaveLength(2);
		expect(result.items[0].name).toBe('Item 1');
		expect(result.items[0].source_url).toBe('https://example.com/1');
		expect(result.items[0].category).toBe('Tools');
		expect(result.items[1].tags).toEqual(['tag1', 'tag2']);
		expect(result.categories).toHaveLength(1);
		expect(result.tags).toHaveLength(2);
	});

	it('should parse a direct array of items', () => {
		const result = parseZapierOutput(
			[
				{ name: 'Item 1', description: 'Desc 1' },
				{ name: 'Item 2', description: 'Desc 2' }
			],
			'structured',
			EMPTY_MAPPING
		);

		expect(result.items).toHaveLength(2);
	});

	it('should unwrap nested `output` field', () => {
		const result = parseZapierOutput({ output: { items: [{ name: 'Async Item' }] } }, 'structured', EMPTY_MAPPING);

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Async Item');
	});

	it('should unwrap nested `data` field', () => {
		const result = parseZapierOutput({ data: { items: [{ name: 'Data Item' }] } }, 'structured', EMPTY_MAPPING);
		expect(result.items).toHaveLength(1);
	});

	it('should parse JSON strings returned by Code by Zapier steps', () => {
		const result = parseZapierOutput(
			JSON.stringify({ items: [{ name: 'String Item' }] }),
			'structured',
			EMPTY_MAPPING
		);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('String Item');
	});

	it('should extract categories from item references', () => {
		const result = parseZapierOutput(
			{
				items: [
					{ name: 'Item 1', category: 'Cat A' },
					{ name: 'Item 2', category: 'Cat B' },
					{ name: 'Item 3', category: 'Cat A' }
				]
			},
			'structured',
			EMPTY_MAPPING
		);

		expect(result.categories).toHaveLength(2);
		expect(result.categories.map((c) => c.name)).toContain('Cat A');
		expect(result.categories.map((c) => c.name)).toContain('Cat B');
	});

	it('should skip items without a name', () => {
		const result = parseZapierOutput(
			{
				items: [
					{ name: 'Valid', description: 'Has name' },
					{ description: 'No name' },
					{ name: '', description: 'Empty name' }
				]
			},
			'structured',
			EMPTY_MAPPING
		);

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Valid');
	});

	it('should prefer url over source_url', () => {
		const result = parseZapierOutput(
			{ items: [{ name: 'Item', url: 'https://a.com', source_url: 'https://b.com' }] },
			'structured',
			EMPTY_MAPPING
		);

		expect(result.items[0].source_url).toBe('https://a.com');
	});

	it('should throw on null or undefined output', () => {
		expect(() => parseZapierOutput(null, 'structured', EMPTY_MAPPING)).toThrow('no data');
		expect(() => parseZapierOutput(undefined, 'structured', EMPTY_MAPPING)).toThrow('no data');
	});

	it('should throw when structured output lacks items', () => {
		expect(() => parseZapierOutput({ foo: 'bar' }, 'structured', EMPTY_MAPPING)).toThrow(
			'does not contain an "items" array'
		);
	});

	it('should throw when structured output has an empty items array', () => {
		expect(() => parseZapierOutput({ items: [] }, 'structured', EMPTY_MAPPING)).toThrow('no usable items');
	});

	it('should trim whitespace from names', () => {
		const result = parseZapierOutput(
			{ items: [{ name: '  Padded Name  ', category: '  Cat  ' }] },
			'structured',
			EMPTY_MAPPING
		);

		expect(result.items[0].name).toBe('Padded Name');
		expect(result.items[0].category).toBe('Cat');
	});
});

describe('parseZapierOutput — native shape', () => {
	it('should map flat records using a simple field mapping', () => {
		const mapping: ZapierFieldMapping = {
			nameField: 'title',
			urlField: 'link',
			descriptionField: 'summary',
			categoryField: 'category',
			tagsField: 'tags'
		};

		const result = parseZapierOutput(
			[
				{
					title: 'Native Item',
					link: 'https://example.com',
					summary: 'A summary',
					category: 'Tools',
					tags: ['a', 'b']
				}
			],
			'native',
			mapping
		);

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Native Item');
		expect(result.items[0].source_url).toBe('https://example.com');
		expect(result.items[0].description).toBe('A summary');
		expect(result.items[0].category).toBe('Tools');
		expect(result.items[0].tags).toEqual(['a', 'b']);
	});

	it('should parse comma-separated tag strings', () => {
		const mapping: ZapierFieldMapping = { nameField: 'title', tagsField: 'tags' };
		const result = parseZapierOutput([{ title: 'Item', tags: 'foo, bar , baz' }], 'native', mapping);
		expect(result.items[0].tags).toEqual(['foo', 'bar', 'baz']);
	});

	it('should read nested paths via dot notation', () => {
		const mapping: ZapierFieldMapping = {
			nameField: 'fields.title',
			urlField: 'fields.link'
		};

		const result = parseZapierOutput(
			[{ fields: { title: 'Nested', link: 'https://nested.example' } }],
			'native',
			mapping
		);

		expect(result.items[0].name).toBe('Nested');
		expect(result.items[0].source_url).toBe('https://nested.example');
	});

	it('should read array paths with numeric indices', () => {
		const mapping: ZapierFieldMapping = { nameField: 'fields.0.value' };

		const result = parseZapierOutput([{ fields: [{ value: 'First' }, { value: 'Second' }] }], 'native', mapping);

		expect(result.items[0].name).toBe('First');
	});

	it('should unwrap `results` wrapper objects', () => {
		const mapping: ZapierFieldMapping = { nameField: 'title' };
		const result = parseZapierOutput({ results: [{ title: 'A' }, { title: 'B' }] }, 'native', mapping);
		expect(result.items).toHaveLength(2);
	});

	it('should treat a single object as a one-record list', () => {
		const mapping: ZapierFieldMapping = { nameField: 'title' };
		const result = parseZapierOutput({ title: 'Solo' }, 'native', mapping);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Solo');
	});

	it('should throw when no records can be mapped (empty names)', () => {
		const mapping: ZapierFieldMapping = { nameField: 'title' };
		expect(() => parseZapierOutput([{ title: '' }, { other: 'x' }], 'native', mapping)).toThrow(
			'none could be mapped'
		);
	});

	it('should accept a single image URL string', () => {
		const mapping: ZapierFieldMapping = { nameField: 'title', imageField: 'img' };
		const result = parseZapierOutput([{ title: 'Item', img: 'https://example.com/a.png' }], 'native', mapping);
		expect(result.items[0].images).toEqual(['https://example.com/a.png']);
	});

	it('should accept an array of image URLs', () => {
		const mapping: ZapierFieldMapping = { nameField: 'title', imageField: 'imgs' };
		const result = parseZapierOutput(
			[{ title: 'Item', imgs: ['https://a.com/1.png', 'https://a.com/2.png'] }],
			'native',
			mapping
		);
		expect(result.items[0].images).toEqual(['https://a.com/1.png', 'https://a.com/2.png']);
	});
});

describe('deduplicateItems', () => {
	it('should remove items whose names match existing items', () => {
		const items = [
			{ name: 'Item 1', description: 'New' },
			{ name: 'Item 2', description: 'New' },
			{ name: 'Item 3', description: 'New' }
		] as never[];

		const result = deduplicateItems(items, ['Item 1', 'Item 3']);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('Item 2');
	});

	it('should match case-insensitively', () => {
		const items = [{ name: 'My Item', description: 'New' }] as never[];
		const result = deduplicateItems(items, ['MY ITEM']);
		expect(result).toHaveLength(0);
	});

	it('should trim whitespace before comparing', () => {
		const items = [{ name: ' Item ', description: 'New' }] as never[];
		const result = deduplicateItems(items, ['Item']);
		expect(result).toHaveLength(0);
	});

	it('should return all items when there are no existing names', () => {
		const items = [
			{ name: 'A', description: 'New' },
			{ name: 'B', description: 'New' }
		] as never[];
		expect(deduplicateItems(items, [])).toHaveLength(2);
	});
});
