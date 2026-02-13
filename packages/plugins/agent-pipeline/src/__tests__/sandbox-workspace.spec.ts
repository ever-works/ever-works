import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkspace, collectItemsFromWorkspace, cleanupWorkspace } from '../utils/sandbox-workspace';
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

	describe('createWorkspace', () => {
		it('should create metadata and seed items on disk', async () => {
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
				tags: [{ id: 'ai', name: 'ai' }],
				brands: [{ id: 'brand1', name: 'Brand 1' }]
			};

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const dirMeta = JSON.parse(await readFile(join(workspacePath, '_meta', 'directory.json'), 'utf-8'));
			expect(dirMeta.name).toBe('AI Tools');

			const item = JSON.parse(await readFile(join(workspacePath, 'cursor.json'), 'utf-8'));
			expect(item.name).toBe('Cursor');

			const metaEntries = await readdir(join(workspacePath, '_meta'));
			expect(metaEntries).toContain('categories.json');
			expect(metaEntries).toContain('tags.json');
			expect(metaEntries).toContain('brands.json');
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
					}
				],
				categories: [],
				tags: []
			};

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			const jsonl = await readFile(join(workspacePath, '_meta', 'existing-items.jsonl'), 'utf-8');
			const first = JSON.parse(jsonl.trim());
			expect(first.slug).toBe('cursor');
			expect(first.name).toBe('Cursor');
			expect(first.source_url).toBe('https://cursor.sh');
			expect(first.description).toBeUndefined();
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

			const items = await collectItemsFromWorkspace(dir);
			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('Cursor');

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

			await sleep(50);

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

			await sleep(50);
			await writeFile(
				join(workspacePath, 'cursor.json'),
				JSON.stringify({
					name: 'Cursor',
					description: 'Updated description',
					source_url: 'https://cursor.sh',
					category: 'Editors',
					tags: ['ai', 'ide']
				})
			);

			const items = await collectItemsFromWorkspace(workspacePath);

			expect(items).toHaveLength(1);
			expect(items[0].description).toBe('Updated description');
		});

		it('should repair malformed JSON and accept the item', async () => {
			const logger = { log: vi.fn(), warn: vi.fn() };
			const dir = join(tmpdir(), `test-collect-${randomUUID()}`);
			await mkdir(dir, { recursive: true });

			// Trailing comma — common AI output issue
			await writeFile(
				join(dir, 'malformed.json'),
				`{
					"name": "Cursor",
					"description": "AI code editor",
					"source_url": "https://cursor.sh",
					"category": "Editors",
					"tags": ["ai"],
				}`
			);

			const items = await collectItemsFromWorkspace(dir, logger);
			expect(items).toHaveLength(1);
			expect(items[0].name).toBe('Cursor');
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Repaired malformed JSON'));

			await rm(dir, { recursive: true, force: true });
		});

		it('should skip invalid items and log warnings', async () => {
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
			await writeFile(join(dir, 'broken.json'), 'not valid json {');

			const items = await collectItemsFromWorkspace(dir, logger);

			expect(items).toHaveLength(1);
			expect(logger.warn).toHaveBeenCalledTimes(2);

			await rm(dir, { recursive: true, force: true });
		});

		it('should return empty array when directory does not exist', async () => {
			const logger = { log: vi.fn(), warn: vi.fn() };
			const dir = join(tmpdir(), `test-collect-nonexistent-${randomUUID()}`);

			const items = await collectItemsFromWorkspace(dir, logger);
			expect(items).toEqual([]);
		});
	});

	describe('cleanupWorkspace', () => {
		it('should remove the workspace directory', async () => {
			const userId = uniqueUserId();
			const existing: ExistingItems = { items: [], categories: [], tags: [] };

			const workspacePath = await createWorkspace(userId, 'dir1', existing, baseDirectory, baseRequest);

			await cleanupWorkspace(userId, 'dir1');
			await expect(readdir(workspacePath)).rejects.toThrow();
		});

		it('should not throw when workspace does not exist', async () => {
			await expect(cleanupWorkspace('nonexistent-user', 'nonexistent-dir')).resolves.toBeUndefined();
		});
	});
});
