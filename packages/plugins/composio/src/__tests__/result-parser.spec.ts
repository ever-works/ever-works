import { describe, it, expect } from 'vitest';
import { parseComposioOutput, deduplicateItems } from '../utils/result-parser.js';
import type { ComposioFieldMapping } from '../types.js';
import type { ItemData } from '@ever-works/plugin';

const EMPTY_MAPPING: ComposioFieldMapping = { nameField: 'name' };

describe('parseComposioOutput — structured shape', () => {
	it('parses { items: [...] }', () => {
		const result = parseComposioOutput(
			{
				items: [
					{ name: 'A', description: 'desc-a', url: 'https://a.example', category: 'Cat1', tags: ['t1'] },
					{ name: 'B', url: 'https://b.example' }
				]
			},
			'structured',
			EMPTY_MAPPING
		);

		expect(result.items).toHaveLength(2);
		expect(result.items[0].name).toBe('A');
		expect(result.items[0].source_url).toBe('https://a.example');
		expect(result.items[0].tags).toEqual(['t1']);
		expect(result.items[1].name).toBe('B');
	});

	it('parses a bare array as items', () => {
		const result = parseComposioOutput([{ name: 'A' }, { name: 'B' }], 'structured', EMPTY_MAPPING);
		expect(result.items).toHaveLength(2);
	});

	it('unwraps a single-element array that wraps { items: [...] }', () => {
		const result = parseComposioOutput([{ items: [{ name: 'A' }] }], 'structured', EMPTY_MAPPING);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('A');
	});

	it('descends through common envelope keys (output, result, data, response, payload)', () => {
		for (const key of ['output', 'result', 'data', 'response', 'payload']) {
			const result = parseComposioOutput({ [key]: { items: [{ name: key }] } }, 'structured', EMPTY_MAPPING);
			expect(result.items[0].name).toBe(key);
		}
	});

	it('parses a JSON string', () => {
		const result = parseComposioOutput(JSON.stringify({ items: [{ name: 'X' }] }), 'structured', EMPTY_MAPPING);
		expect(result.items).toHaveLength(1);
	});

	it('throws on a non-JSON string', () => {
		expect(() => parseComposioOutput('not json', 'structured', EMPTY_MAPPING)).toThrow(/not valid JSON/i);
	});

	it('throws on an object with no items + no envelope keys', () => {
		expect(() => parseComposioOutput({ foo: 'bar' }, 'structured', EMPTY_MAPPING)).toThrow(
			/does not contain an "items" array/
		);
	});

	it('throws on null / undefined', () => {
		expect(() => parseComposioOutput(null, 'structured', EMPTY_MAPPING)).toThrow(/no data/);
		expect(() => parseComposioOutput(undefined, 'structured', EMPTY_MAPPING)).toThrow(/no data/);
	});

	it('throws when items is present but every entry is invalid', () => {
		expect(() =>
			parseComposioOutput({ items: [{ description: 'no name' }, 'string', null] }, 'structured', EMPTY_MAPPING)
		).toThrow(/no usable items/i);
	});

	it('aggregates categories from explicit list + per-item category', () => {
		const result = parseComposioOutput(
			{
				items: [{ name: 'A', category: 'Auto' }],
				categories: [{ name: 'Manual', description: 'from list' }]
			},
			'structured',
			EMPTY_MAPPING
		);

		const names = result.categories.map((c) => c.name).sort();
		expect(names).toEqual(['Auto', 'Manual']);
	});

	it('aggregates tags from explicit list + per-item tags', () => {
		const result = parseComposioOutput(
			{
				items: [{ name: 'A', tags: ['x', 'y'] }],
				tags: [{ name: 'z' }]
			},
			'structured',
			EMPTY_MAPPING
		);

		const names = result.tags.map((t) => t.name).sort();
		expect(names).toEqual(['x', 'y', 'z']);
	});
});

describe('parseComposioOutput — native shape', () => {
	const mapping: ComposioFieldMapping = {
		nameField: 'title',
		urlField: 'link',
		descriptionField: 'snippet',
		tagsField: 'labels',
		imageField: 'image',
		brandField: 'org'
	};

	it('maps array records onto items via field mapping', () => {
		const result = parseComposioOutput(
			[
				{
					title: 'Alice',
					link: 'https://alice.example',
					snippet: 'About Alice',
					labels: ['admin'],
					org: 'Acme'
				},
				{ title: 'Bob', link: 'https://bob.example', labels: 'engineer, designer' }
			],
			'native',
			mapping
		);

		expect(result.items).toHaveLength(2);
		expect(result.items[0].name).toBe('Alice');
		expect(result.items[0].source_url).toBe('https://alice.example');
		expect(result.items[0].description).toBe('About Alice');
		expect(result.items[0].tags).toEqual(['admin']);
		expect(result.items[0].brand).toBe('Acme');
		expect(result.items[1].tags).toEqual(['engineer', 'designer']);
	});

	it('reads from common envelopes (messages, issues, records, …)', () => {
		const result = parseComposioOutput({ messages: [{ title: 'A' }, { title: 'B' }] }, 'native', {
			nameField: 'title'
		});
		expect(result.items).toHaveLength(2);
	});

	it('walks dot-paths and array indexes', () => {
		const result = parseComposioOutput([{ profile: { name: 'Alice' } }, { profile: { name: 'Bob' } }], 'native', {
			nameField: 'profile.name'
		});

		expect(result.items.map((i) => i.name)).toEqual(['Alice', 'Bob']);
	});

	it('drops records with an empty name', () => {
		const result = parseComposioOutput([{ title: 'Alice' }, { title: '' }, { title: '   ' }], 'native', {
			nameField: 'title'
		});
		expect(result.items).toHaveLength(1);
	});

	it('throws if zero records produce items', () => {
		expect(() => parseComposioOutput([{}], 'native', { nameField: 'missing' })).toThrow(/none could be mapped/i);
	});

	it('treats a single object as a one-record list', () => {
		const result = parseComposioOutput({ title: 'Solo' }, 'native', { nameField: 'title' });
		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('Solo');
	});

	it('accepts array image fields', () => {
		const result = parseComposioOutput(
			[{ title: 'A', image: ['https://a/img.png', 'https://a/img2.png'] }],
			'native',
			{ nameField: 'title', imageField: 'image' }
		);
		expect(result.items[0].images).toEqual(['https://a/img.png', 'https://a/img2.png']);
	});

	it('accepts string image fields', () => {
		const result = parseComposioOutput([{ title: 'A', image: 'https://a/img.png' }], 'native', {
			nameField: 'title',
			imageField: 'image'
		});
		expect(result.items[0].images).toEqual(['https://a/img.png']);
	});
});

describe('deduplicateItems', () => {
	function makeItem(name: string): ItemData {
		return { name, description: '', source_url: '', category: '', tags: [] };
	}

	it('removes items whose name matches case-insensitively', () => {
		const result = deduplicateItems([makeItem('Alice'), makeItem('Bob'), makeItem('alice')], ['ALICE']);
		expect(result.map((i) => i.name)).toEqual(['Bob']);
	});

	it('returns input unchanged when no existing names', () => {
		const items = [makeItem('A'), makeItem('B')];
		expect(deduplicateItems(items, [])).toEqual(items);
	});

	it('trims whitespace when comparing', () => {
		const result = deduplicateItems([makeItem('  Alice  ')], ['Alice']);
		expect(result).toHaveLength(0);
	});
});
