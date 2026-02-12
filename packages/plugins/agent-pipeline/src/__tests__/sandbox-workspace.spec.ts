import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	createWorkspace,
	collectItemsFromWorkspace,
	cleanupWorkspace,
	getWorkspacePath
} from '../utils/sandbox-workspace';
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

	// Track created workspaces for cleanup
	const createdUserIds: string[] = [];

	function uniqueUserId(): string {
		const id = `test-${randomUUID()}`;
		createdUserIds.push(id);
		return id;
	}

	afterEach(async () => {
		for (const userId of createdUserIds) {
			await cleanupWorkspace(userId, 'dir1');
		}
		createdUserIds.length = 0;
	});

	describe('getWorkspacePath', () => {
		it('should return path under tmp directory', () => {
			const path = getWorkspacePath('user1', 'dir1');
			expect(path).toContain('agent-pipeline');
			expect(path).toContain('user1');
			expect(path).toContain('dir1');
		});
	});

	describe('createWorkspace', () => {
		it('should create metadata files on disk', async () => {
			const userId = uniqueUserId();
			const existing: ExistingItems = { items: [], categories: [], tags: [] };

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const dirMeta = JSON.parse(await readFile(join(workspacePath, '_meta', 'directory.json'), 'utf-8'));
			expect(dirMeta.name).toBe('AI Tools');
			expect(dirMeta.description).toBe('A curated directory of AI tools and services');

			const reqMeta = JSON.parse(await readFile(join(workspacePath, '_meta', 'request.json'), 'utf-8'));
			expect(reqMeta.prompt).toBe('Generate AI tools');
		});

		it('should seed existing items as individual JSON files', async () => {
			const userId = uniqueUserId();
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

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const item = JSON.parse(await readFile(join(workspacePath, 'cursor.json'), 'utf-8'));
			expect(item.name).toBe('Cursor');
			expect(item.source_url).toBe('https://cursor.sh');
		});

		it('should generate slugs for items without slugs', async () => {
			const userId = uniqueUserId();
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

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const entries = await readdir(workspacePath);
			expect(entries).toContain('my-cool-tool.json');
		});

		it('should deduplicate slugs', async () => {
			const userId = uniqueUserId();
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

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const entries = await readdir(workspacePath);
			expect(entries).toContain('tool.json');
			expect(entries).toContain('tool-2.json');
		});

		it('should write compact JSONL index with dedup fields only', async () => {
			const userId = uniqueUserId();
			const existing: ExistingItems = {
				items: [
					{
						name: 'Cursor',
						slug: 'cursor',
						description: 'AI code editor',
						source_url: 'https://cursor.sh',
						category: 'Editors',
						tags: ['ai']
					},
					{
						name: 'Copilot',
						slug: 'copilot',
						description: 'AI coding assistant',
						source_url: 'https://github.com/features/copilot',
						category: 'Assistants',
						tags: ['ai']
					}
				],
				categories: [],
				tags: []
			};

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const jsonl = await readFile(join(workspacePath, '_meta', 'existing-items.jsonl'), 'utf-8');
			const lines = jsonl.trim().split('\n');
			expect(lines).toHaveLength(2);

			const first = JSON.parse(lines[0]);
			expect(first.slug).toBe('cursor');
			expect(first.name).toBe('Cursor');
			expect(first.source_url).toBe('https://cursor.sh');
			// Only dedup fields, not full item data
			expect(first.description).toBeUndefined();
			expect(first.category).toBeUndefined();
			expect(first.tags).toBeUndefined();
		});

		it('should write seeded manifest', async () => {
			const userId = uniqueUserId();
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
				categories: [],
				tags: []
			};

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const seeded = JSON.parse(await readFile(join(workspacePath, '_meta', 'seeded.json'), 'utf-8'));
			expect(seeded).toEqual(['cursor.json']);
		});

		it('should not create JSONL index when no existing items', async () => {
			const userId = uniqueUserId();
			const existing: ExistingItems = { items: [], categories: [], tags: [] };

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const metaEntries = await readdir(join(workspacePath, '_meta'));
			expect(metaEntries).not.toContain('existing-items.jsonl');
		});

		it('should include categories, tags, and brands metadata', async () => {
			const userId = uniqueUserId();
			const existing: ExistingItems = {
				items: [],
				categories: [{ id: 'cat1', name: 'Category 1' }],
				tags: [{ id: 'tag1', name: 'Tag 1' }],
				brands: [{ id: 'brand1', name: 'Brand 1' }]
			};

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const metaEntries = await readdir(join(workspacePath, '_meta'));
			expect(metaEntries).toContain('categories.json');
			expect(metaEntries).toContain('tags.json');
			expect(metaEntries).toContain('brands.json');
		});

		it('should not create metadata files for empty arrays', async () => {
			const userId = uniqueUserId();
			const existing: ExistingItems = { items: [], categories: [], tags: [] };

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const metaEntries = await readdir(join(workspacePath, '_meta'));
			expect(metaEntries).not.toContain('categories.json');
			expect(metaEntries).not.toContain('tags.json');
			expect(metaEntries).not.toContain('brands.json');
		});
	});

	describe('collectItemsFromWorkspace', () => {
		it('should collect new items (no manifest)', async () => {
			const dir = join(tmpdir(), `test-collect-${randomUUID()}`);
			await mkdir(dir, { recursive: true });

			await writeFile(
				join(dir, 'cursor.json'),
				JSON.stringify({
					name: 'Cursor',
					description: 'AI code editor',
					source_url: 'https://cursor.sh',
					category: 'Editors',
					tags: ['ai']
				})
			);
			await writeFile(
				join(dir, 'copilot.json'),
				JSON.stringify({
					name: 'GitHub Copilot',
					description: 'AI coding assistant',
					source_url: 'https://github.com/features/copilot',
					category: 'Assistants',
					tags: ['ai', 'github']
				})
			);

			const items = await collectItemsFromWorkspace(dir);

			expect(items).toHaveLength(2);
			expect(items.map((i) => i.name).sort()).toEqual(['Cursor', 'GitHub Copilot']);

			await rm(dir, { recursive: true, force: true });
		});

		it('should skip unchanged seeded files', async () => {
			const userId = uniqueUserId();
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
				categories: [],
				tags: []
			};

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			// Wait briefly so new file gets a later mtime
			await sleep(50);

			// Simulate agent creating a new file
			await writeFile(
				join(workspacePath, 'new-tool.json'),
				JSON.stringify({
					name: 'New Tool',
					description: 'A brand new tool',
					source_url: 'https://newtool.com',
					category: 'Tools',
					tags: []
				})
			);

			const items = await collectItemsFromWorkspace(workspacePath);

			// Should only return the new item, not the seeded cursor.json
			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('New Tool');
		});

		it('should return modified seeded files', async () => {
			const userId = uniqueUserId();
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
				categories: [],
				tags: []
			};

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			// Wait briefly then overwrite the seeded file (simulating agent update)
			await sleep(50);
			await writeFile(
				join(workspacePath, 'cursor.json'),
				JSON.stringify({
					name: 'Cursor',
					description: 'Updated description with more info',
					source_url: 'https://cursor.sh',
					category: 'Editors',
					tags: ['ai', 'ide']
				})
			);

			const items = await collectItemsFromWorkspace(workspacePath);

			// Should return the modified file
			expect(items).toHaveLength(1);
			expect(items[0].description).toBe('Updated description with more info');
		});

		it('should skip items missing required fields', async () => {
			const logger = { log: vi.fn(), warn: vi.fn() };
			const dir = join(tmpdir(), `test-collect-${randomUUID()}`);
			await mkdir(dir, { recursive: true });

			await writeFile(
				join(dir, 'valid.json'),
				JSON.stringify({
					name: 'Valid',
					description: 'A valid item',
					source_url: 'https://example.com',
					category: 'Tools',
					tags: []
				})
			);
			await writeFile(
				join(dir, 'invalid.json'),
				JSON.stringify({
					name: 'Invalid',
					description: 'Missing source_url and category'
				})
			);

			const items = await collectItemsFromWorkspace(dir, logger);

			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('Valid');
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing required fields'));

			await rm(dir, { recursive: true, force: true });
		});

		it('should normalize tags to arrays', async () => {
			const dir = join(tmpdir(), `test-collect-${randomUUID()}`);
			await mkdir(dir, { recursive: true });

			await writeFile(
				join(dir, 'item.json'),
				JSON.stringify({
					name: 'No Tags',
					description: 'An item without tags array',
					source_url: 'https://example.com',
					category: 'Tools',
					tags: 'not-an-array'
				})
			);

			const items = await collectItemsFromWorkspace(dir);

			expect(items).toHaveLength(1);
			expect(Array.isArray(items[0].tags)).toBe(true);
			expect(items[0].tags).toEqual([]);

			await rm(dir, { recursive: true, force: true });
		});

		it('should skip invalid JSON files', async () => {
			const logger = { log: vi.fn(), warn: vi.fn() };
			const dir = join(tmpdir(), `test-collect-${randomUUID()}`);
			await mkdir(dir, { recursive: true });

			await writeFile(
				join(dir, 'valid.json'),
				JSON.stringify({
					name: 'Valid',
					description: 'Valid item',
					source_url: 'https://example.com',
					category: 'Tools',
					tags: []
				})
			);
			await writeFile(join(dir, 'broken.json'), 'not valid json {');

			const items = await collectItemsFromWorkspace(dir, logger);

			expect(items).toHaveLength(1);
			expect(logger.warn).toHaveBeenCalled();

			await rm(dir, { recursive: true, force: true });
		});

		it('should return empty array when no files exist', async () => {
			const dir = join(tmpdir(), `test-collect-${randomUUID()}`);
			await mkdir(dir, { recursive: true });

			const items = await collectItemsFromWorkspace(dir);
			expect(items).toEqual([]);

			await rm(dir, { recursive: true, force: true });
		});

		it('should return empty array when directory does not exist', async () => {
			const logger = { log: vi.fn(), warn: vi.fn() };
			const dir = join(tmpdir(), `test-collect-nonexistent-${randomUUID()}`);

			const items = await collectItemsFromWorkspace(dir, logger);
			expect(items).toEqual([]);
			expect(logger.warn).toHaveBeenCalledWith('Could not read workspace directory');
		});

		it('should skip _meta directory files', async () => {
			const dir = join(tmpdir(), `test-collect-${randomUUID()}`);
			const metaDir = join(dir, '_meta');
			await mkdir(metaDir, { recursive: true });

			await writeFile(
				join(dir, 'item.json'),
				JSON.stringify({
					name: 'Item',
					description: 'An item',
					source_url: 'https://example.com',
					category: 'Tools',
					tags: []
				})
			);
			await writeFile(join(metaDir, 'directory.json'), JSON.stringify({ name: 'Test' }));

			const items = await collectItemsFromWorkspace(dir);

			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('Item');

			await rm(dir, { recursive: true, force: true });
		});
	});

	describe('cleanupWorkspace', () => {
		it('should remove the workspace directory', async () => {
			const userId = uniqueUserId();
			const existing: ExistingItems = { items: [], categories: [], tags: [] };

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const entries = await readdir(workspacePath);
			expect(entries.length).toBeGreaterThan(0);

			await cleanupWorkspace(userId, 'dir1');

			await expect(readdir(workspacePath)).rejects.toThrow();
		});

		it('should not throw when workspace does not exist', async () => {
			await expect(cleanupWorkspace('nonexistent-user', 'nonexistent-dir')).resolves.toBeUndefined();
		});
	});
});
