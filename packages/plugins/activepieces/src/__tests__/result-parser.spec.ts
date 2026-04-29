import { describe, it, expect } from 'vitest';
import { parseActivepiecesOutput, deduplicateItems } from '../utils/result-parser.js';
import type { ItemData } from '@ever-works/plugin';

describe('parseActivepiecesOutput', () => {
	it('should parse a normal items object', () => {
		const result = parseActivepiecesOutput({
			items: [
				{ name: 'A', description: 'a', url: 'https://a.com', category: 'Cat', tags: ['t1'] },
				{ name: 'B', description: 'b', url: 'https://b.com', category: 'Cat', tags: [] }
			]
		});

		expect(result.items).toHaveLength(2);
		expect(result.items[0].name).toBe('A');
		expect(result.items[0].source_url).toBe('https://a.com');
		expect(result.categories.map((c) => c.name)).toContain('Cat');
		expect(result.tags.map((t) => t.name)).toContain('t1');
	});

	it('should parse a direct array of items', () => {
		const result = parseActivepiecesOutput([
			{ name: 'A', description: 'a', url: 'https://a.com', category: 'Cat', tags: [] }
		]);

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('A');
	});

	it('should unwrap a body wrapper (Return Response action)', () => {
		const result = parseActivepiecesOutput({
			body: {
				items: [{ name: 'A', url: 'https://a.com' }]
			}
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('A');
	});

	it('should unwrap nested output keys', () => {
		const result = parseActivepiecesOutput({
			output: { result: { items: [{ name: 'A' }] } }
		});

		expect(result.items).toHaveLength(1);
	});

	it('should parse a JSON string', () => {
		const result = parseActivepiecesOutput(
			JSON.stringify({ items: [{ name: 'A', url: 'https://a.com' }] })
		);

		expect(result.items).toHaveLength(1);
	});

	it('should throw on empty output', () => {
		expect(() => parseActivepiecesOutput(null)).toThrow();
		expect(() => parseActivepiecesOutput(undefined)).toThrow();
	});

	it('should throw when items array is missing usable items', () => {
		expect(() => parseActivepiecesOutput({ items: [{ description: 'no name' }] })).toThrow(/no usable items/);
	});

	it('should throw when output cannot be normalized', () => {
		expect(() => parseActivepiecesOutput({ foo: 'bar' })).toThrow(/items/);
	});

	it('should preserve images and brand', () => {
		const result = parseActivepiecesOutput({
			items: [
				{
					name: 'A',
					description: 'a',
					url: 'https://a.com',
					brand: 'BrandX',
					images: ['https://a.com/img.png']
				}
			]
		});

		expect(result.items[0].brand).toBe('BrandX');
		expect(result.items[0].images).toEqual(['https://a.com/img.png']);
		expect(result.brands.map((b) => b.name)).toContain('BrandX');
	});
});

describe('deduplicateItems', () => {
	it('should remove items matching existing names case-insensitively', () => {
		const items: ItemData[] = [
			{ name: 'Test One' } as ItemData,
			{ name: 'TEST TWO' } as ItemData,
			{ name: 'Three' } as ItemData
		];
		const filtered = deduplicateItems(items, ['test one', 'Test Two']);
		expect(filtered.map((i) => i.name)).toEqual(['Three']);
	});

	it('should return all items when no existing names match', () => {
		const items: ItemData[] = [{ name: 'A' } as ItemData];
		expect(deduplicateItems(items, ['B'])).toEqual(items);
	});
});
