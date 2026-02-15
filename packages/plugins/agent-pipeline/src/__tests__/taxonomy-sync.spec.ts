import { describe, it, expect, vi } from 'vitest';
import { syncTaxonomyFromFile } from '../utils/taxonomy-sync';

function createStore(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial));
	return {
		files,
		read: vi.fn(async (path: string) => {
			if (!files.has(path)) throw new Error('ENOENT');
			return files.get(path)!;
		}),
		write: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
		})
	};
}

function itemJson(fields: Record<string, unknown>): string {
	return JSON.stringify(fields);
}

describe('syncTaxonomyFromFile', () => {
	// ── Categories ──────────────────────────────────────────────────

	it('should add a new category to _meta/categories.json', async () => {
		const store = createStore();
		const content = itemJson({ name: 'Tool', category: 'Cloud Services' });

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/tool.json', content);

		const cats = JSON.parse(store.files.get('/workspace/_meta/categories.json')!);
		expect(cats).toEqual([{ id: 'cloud-services', name: 'Cloud Services' }]);
	});

	it('should skip duplicate categories (case-insensitive)', async () => {
		const store = createStore({
			'/workspace/_meta/categories.json': JSON.stringify([{ id: 'cloud-services', name: 'Cloud Services' }])
		});
		const content = itemJson({ name: 'Tool', category: 'cloud services' });

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/tool.json', content);

		// write should not have been called for categories (no new entries)
		const writeCalls = store.write.mock.calls.filter(([p]: [string]) => p.includes('categories'));
		expect(writeCalls).toHaveLength(0);
	});

	it('should handle array categories', async () => {
		const store = createStore();
		const content = itemJson({ name: 'Tool', category: ['CI/CD', 'DevOps'] });

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/tool.json', content);

		const cats = JSON.parse(store.files.get('/workspace/_meta/categories.json')!);
		expect(cats).toHaveLength(2);
		expect(cats.map((c: { name: string }) => c.name)).toContain('CI/CD');
		expect(cats.map((c: { name: string }) => c.name)).toContain('DevOps');
	});

	// ── Tags ────────────────────────────────────────────────────────

	it('should add new tags to _meta/tags.json', async () => {
		const store = createStore();
		const content = itemJson({ name: 'Tool', category: 'Tools', tags: ['open-source', 'free'] });

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/tool.json', content);

		const tags = JSON.parse(store.files.get('/workspace/_meta/tags.json')!);
		expect(tags).toHaveLength(2);
		expect(tags[0].name).toBe('Open Source');
		expect(tags[1].name).toBe('Free');
	});

	it('should handle Tag objects with name field', async () => {
		const store = createStore();
		const content = itemJson({
			name: 'Tool',
			category: 'Tools',
			tags: [{ id: 'ai', name: 'AI' }, 'machine-learning']
		});

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/tool.json', content);

		const tags = JSON.parse(store.files.get('/workspace/_meta/tags.json')!);
		expect(tags).toHaveLength(2);
	});

	// ── Brands ──────────────────────────────────────────────────────

	it('should add a new brand (string form)', async () => {
		const store = createStore();
		const content = itemJson({ name: 'Tool', category: 'Tools', brand: 'Acme Corp' });

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/tool.json', content);

		const brands = JSON.parse(store.files.get('/workspace/_meta/brands.json')!);
		expect(brands).toEqual([{ id: 'acme-corp', name: 'Acme Corp' }]);
	});

	it('should add a new brand (object form with logo_url)', async () => {
		const store = createStore();
		const content = itemJson({
			name: 'Tool',
			category: 'Tools',
			brand: { name: 'Acme Corp', logo_url: 'https://acme.com/logo.png' }
		});

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/tool.json', content);

		const brands = JSON.parse(store.files.get('/workspace/_meta/brands.json')!);
		expect(brands).toEqual([{ id: 'acme-corp', name: 'Acme Corp', logo_url: 'https://acme.com/logo.png' }]);
	});

	it('should use brand_logo_url as fallback for string brands', async () => {
		const store = createStore();
		const content = itemJson({
			name: 'Tool',
			category: 'Tools',
			brand: 'Acme Corp',
			brand_logo_url: 'https://acme.com/logo.png'
		});

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/tool.json', content);

		const brands = JSON.parse(store.files.get('/workspace/_meta/brands.json')!);
		expect(brands[0].logo_url).toBe('https://acme.com/logo.png');
	});

	// ── Taxonomy file creation ──────────────────────────────────────

	it('should create taxonomy files when they do not exist', async () => {
		const store = createStore();
		const content = itemJson({
			name: 'Tool',
			category: 'Databases',
			tags: ['sql'],
			brand: 'Oracle'
		});

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/tool.json', content);

		expect(store.files.has('/workspace/_meta/categories.json')).toBe(true);
		expect(store.files.has('/workspace/_meta/tags.json')).toBe(true);
		expect(store.files.has('/workspace/_meta/brands.json')).toBe(true);
	});

	// ── Guards ───────────────────────────────────────────────────────

	it('should skip _meta/ paths (recursion guard)', async () => {
		const store = createStore();
		const content = itemJson({ name: 'Tool', category: 'Test' });

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/_meta/categories.json', content);

		expect(store.write).not.toHaveBeenCalled();
	});

	it('should skip non-JSON files', async () => {
		const store = createStore();

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/readme.md', '# Hello');

		expect(store.write).not.toHaveBeenCalled();
	});

	it('should handle unparseable content gracefully', async () => {
		const store = createStore();

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/broken.json', '{not json');

		expect(store.write).not.toHaveBeenCalled();
	});

	it('should not write when no new taxonomy values are found', async () => {
		const store = createStore({
			'/workspace/_meta/categories.json': JSON.stringify([{ id: 'tools', name: 'Tools' }]),
			'/workspace/_meta/tags.json': JSON.stringify([{ id: 'free', name: 'Free' }]),
			'/workspace/_meta/brands.json': JSON.stringify([{ id: 'acme', name: 'Acme' }])
		});
		const content = itemJson({
			name: 'Existing',
			category: 'Tools',
			tags: ['free'],
			brand: 'Acme'
		});

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/existing.json', content);

		expect(store.write).not.toHaveBeenCalled();
	});

	it('should handle content that is a JSON array (not an object)', async () => {
		const store = createStore();

		await syncTaxonomyFromFile(store.read, store.write, '/workspace/array.json', '[1, 2, 3]');

		expect(store.write).not.toHaveBeenCalled();
	});
});
