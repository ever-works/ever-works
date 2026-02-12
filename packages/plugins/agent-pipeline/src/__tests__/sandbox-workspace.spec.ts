import { describe, it, expect, vi } from 'vitest';
import { Bash } from 'just-bash';
import { buildSandboxFiles, collectItemsFromSandbox } from '../utils/sandbox-workspace';
import type { DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';

describe('sandbox-workspace', () => {
	const baseDirectory: DirectoryReference = {
		id: 'dir1',
		name: 'AI Tools',
		slug: 'ai-tools',
		description: 'A curated directory of AI tools and services'
	};

	const baseRequest: GenerationRequest = {
		prompt: 'Generate AI tools',
		name: 'AI Tools'
	};

	describe('buildSandboxFiles', () => {
		it('should create metadata files', () => {
			const existing: ExistingItems = {
				items: [],
				categories: [],
				tags: []
			};

			const files = buildSandboxFiles(existing, baseDirectory, baseRequest);

			expect(files['_meta/directory.json']).toBeDefined();
			expect(files['_meta/request.json']).toBeDefined();

			const dirMeta = JSON.parse(files['_meta/directory.json']);
			expect(dirMeta.name).toBe('AI Tools');
			expect(dirMeta.description).toBe('A curated directory of AI tools and services');

			const reqMeta = JSON.parse(files['_meta/request.json']);
			expect(reqMeta.prompt).toBe('Generate AI tools');
		});

		it('should seed existing items as JSON files', () => {
			const existing: ExistingItems = {
				items: [
					{
						name: 'Cursor',
						slug: 'cursor',
						description: 'AI code editor',
						source_url: 'https://cursor.sh',
						category: 'Editors',
						tags: ['ai']
					}
				],
				categories: [{ id: 'editors', name: 'Editors' }],
				tags: [{ id: 'ai', name: 'ai' }]
			};

			const files = buildSandboxFiles(existing, baseDirectory, baseRequest);

			expect(files['cursor.json']).toBeDefined();
			const item = JSON.parse(files['cursor.json']);
			expect(item.name).toBe('Cursor');
			expect(item.source_url).toBe('https://cursor.sh');
		});

		it('should generate slugs for items without slugs', () => {
			const existing: ExistingItems = {
				items: [
					{
						name: 'My Cool Tool',
						description: 'A tool',
						source_url: 'https://example.com',
						category: 'Tools',
						tags: []
					}
				],
				categories: [],
				tags: []
			};

			const files = buildSandboxFiles(existing, baseDirectory, baseRequest);

			expect(files['my-cool-tool.json']).toBeDefined();
		});

		it('should deduplicate slugs', () => {
			const existing: ExistingItems = {
				items: [
					{
						name: 'Tool',
						slug: 'tool',
						description: 'First tool',
						source_url: 'https://tool1.com',
						category: 'Tools',
						tags: []
					},
					{
						name: 'Tool',
						slug: 'tool',
						description: 'Second tool',
						source_url: 'https://tool2.com',
						category: 'Tools',
						tags: []
					}
				],
				categories: [],
				tags: []
			};

			const files = buildSandboxFiles(existing, baseDirectory, baseRequest);

			expect(files['tool.json']).toBeDefined();
			expect(files['tool-2.json']).toBeDefined();
		});

		it('should include categories, tags, and brands metadata', () => {
			const existing: ExistingItems = {
				items: [],
				categories: [{ id: 'cat1', name: 'Category 1' }],
				tags: [{ id: 'tag1', name: 'Tag 1' }],
				brands: [{ id: 'brand1', name: 'Brand 1' }]
			};

			const files = buildSandboxFiles(existing, baseDirectory, baseRequest);

			expect(files['_meta/categories.json']).toBeDefined();
			expect(files['_meta/tags.json']).toBeDefined();
			expect(files['_meta/brands.json']).toBeDefined();
		});

		it('should not create metadata files for empty arrays', () => {
			const existing: ExistingItems = {
				items: [],
				categories: [],
				tags: []
			};

			const files = buildSandboxFiles(existing, baseDirectory, baseRequest);

			expect(files['_meta/categories.json']).toBeUndefined();
			expect(files['_meta/tags.json']).toBeUndefined();
			expect(files['_meta/brands.json']).toBeUndefined();
		});
	});

	describe('collectItemsFromSandbox', () => {
		it('should collect valid items from sandbox', async () => {
			const sandbox = new Bash({
				files: {
					'cursor.json': JSON.stringify({
						name: 'Cursor',
						description: 'AI code editor',
						source_url: 'https://cursor.sh',
						category: 'Editors',
						tags: ['ai']
					}),
					'copilot.json': JSON.stringify({
						name: 'GitHub Copilot',
						description: 'AI coding assistant',
						source_url: 'https://github.com/features/copilot',
						category: 'Assistants',
						tags: ['ai', 'github']
					})
				}
			});

			const items = await collectItemsFromSandbox(sandbox);

			expect(items).toHaveLength(2);
			expect(items.map((i) => i.name).sort()).toEqual(['Cursor', 'GitHub Copilot']);
		});

		it('should skip items missing required fields', async () => {
			const logger = {
				log: vi.fn(),
				warn: vi.fn()
			};

			const sandbox = new Bash({
				files: {
					'valid.json': JSON.stringify({
						name: 'Valid',
						description: 'A valid item',
						source_url: 'https://example.com',
						category: 'Tools',
						tags: []
					}),
					'invalid.json': JSON.stringify({
						name: 'Invalid',
						description: 'Missing source_url and category'
					})
				}
			});

			const items = await collectItemsFromSandbox(sandbox, logger);

			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('Valid');
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing required fields'));
		});

		it('should normalize tags to arrays', async () => {
			const sandbox = new Bash({
				files: {
					'item.json': JSON.stringify({
						name: 'No Tags',
						description: 'An item without tags array',
						source_url: 'https://example.com',
						category: 'Tools',
						tags: 'not-an-array'
					})
				}
			});

			const items = await collectItemsFromSandbox(sandbox);

			expect(items).toHaveLength(1);
			expect(Array.isArray(items[0].tags)).toBe(true);
			expect(items[0].tags).toEqual([]);
		});

		it('should skip invalid JSON files', async () => {
			const logger = {
				log: vi.fn(),
				warn: vi.fn()
			};

			const sandbox = new Bash({
				files: {
					'valid.json': JSON.stringify({
						name: 'Valid',
						description: 'Valid item',
						source_url: 'https://example.com',
						category: 'Tools',
						tags: []
					}),
					'broken.json': 'not valid json {'
				}
			});

			const items = await collectItemsFromSandbox(sandbox, logger);

			expect(items).toHaveLength(1);
			expect(logger.warn).toHaveBeenCalled();
		});

		it('should return empty array when no files exist', async () => {
			const sandbox = new Bash({ files: {} });

			const items = await collectItemsFromSandbox(sandbox);

			expect(items).toEqual([]);
		});

		it('should skip _meta directory files', async () => {
			const sandbox = new Bash({
				files: {
					'item.json': JSON.stringify({
						name: 'Item',
						description: 'An item',
						source_url: 'https://example.com',
						category: 'Tools',
						tags: []
					}),
					'_meta/directory.json': JSON.stringify({ name: 'Test' })
				}
			});

			const items = await collectItemsFromSandbox(sandbox);

			// Only root-level .json files should be collected
			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('Item');
		});
	});
});
