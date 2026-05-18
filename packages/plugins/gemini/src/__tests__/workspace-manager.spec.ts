import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import {
	createWorkspace,
	seedExistingItems,
	seedMetadata,
	readGeneratedItems,
	cleanupWorkspace,
	ensureOnboardingConfig
} from '../utils/workspace-manager';
import { BASE_TEMP_DIR } from '../types';
import type { ItemData, Category } from '@ever-works/plugin';

vi.mock('fs/promises');

describe('workspace-manager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('createWorkspace', () => {
		// BASE_TEMP_DIR derives from `os.tmpdir()`, so it differs by platform
		// (`/tmp/gemini-generator` on Linux, `C:/.../Temp/gemini-generator` on
		// Windows). Anchor the assertions against the live value rather than
		// a Linux-only literal.
		const workspaceRoot = `${BASE_TEMP_DIR}/user1/dir1`;

		it('should create a per-run workspace and create _meta work', async () => {
			vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string);
			vi.mocked(fs.mkdtemp).mockResolvedValue(`${workspaceRoot}/run-123`);

			const result = await createWorkspace('user1', 'dir1');

			expect(fs.mkdir).toHaveBeenCalledWith(workspaceRoot, { recursive: true });
			expect(fs.mkdtemp).toHaveBeenCalledWith(`${workspaceRoot}/run-`);
			expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('_meta'), { recursive: true });
			expect(result).toBe(`${workspaceRoot}/run-123`);
		});
	});

	describe('seedExistingItems', () => {
		it('should write item files, seeded hash manifest, and JSONL index', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const items: ItemData[] = [
				{
					name: 'Cursor',
					description: 'AI code editor',
					source_url: 'https://cursor.sh',
					category: 'Editors',
					tags: ['ai'],
					slug: 'cursor'
				}
			];

			await seedExistingItems('/workspace', items);

			const writePaths = vi.mocked(fs.writeFile).mock.calls.map((c) => c[0]);
			expect(writePaths).toContain('/workspace/cursor.json');
			expect(writePaths).toContain('/workspace/_meta/seeded.json');
			expect(writePaths).toContain('/workspace/_meta/existing-items.jsonl');

			const seededCall = vi.mocked(fs.writeFile).mock.calls.find((c) => (c[0] as string).includes('seeded.json'));
			const seededData = JSON.parse(seededCall![1] as string);
			expect(seededData).toBeTypeOf('object');
			expect(seededData).toHaveProperty('cursor.json');
			expect(seededData['cursor.json']).toMatch(/^[a-f0-9]{64}$/);

			const jsonlCall = vi
				.mocked(fs.writeFile)
				.mock.calls.find((c) => (c[0] as string).includes('existing-items.jsonl'));
			const line = JSON.parse((jsonlCall![1] as string).trim());
			expect(line.slug).toBe('cursor');
			expect(line.name).toBe('Cursor');
			expect(line.source_url).toBe('https://cursor.sh');
			expect(line.description).toBeUndefined();
		});

		it('should handle duplicate slugs', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const items: ItemData[] = [
				{
					name: 'Test',
					description: 'First',
					source_url: 'https://a.com',
					category: 'Cat',
					tags: [],
					slug: 'test'
				},
				{
					name: 'Test',
					description: 'Second',
					source_url: 'https://b.com',
					category: 'Cat',
					tags: [],
					slug: 'test'
				}
			];

			await seedExistingItems('/workspace', items);

			const writePaths = vi.mocked(fs.writeFile).mock.calls.map((c) => c[0]);
			expect(writePaths).toContain('/workspace/test.json');
			expect(writePaths).toContain('/workspace/test-2.json');
		});

		it('should do nothing for empty items array', async () => {
			await seedExistingItems('/workspace', []);
			expect(fs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe('seedMetadata', () => {
		it('should write metadata files when provided', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const categories: Category[] = [{ id: '1', name: 'Cat1' }];
			await seedMetadata('/workspace', {
				work: { name: 'Dir', description: 'Desc' },
				categories
			});

			const writePaths = vi.mocked(fs.writeFile).mock.calls.map((c) => c[0]);
			expect(writePaths).toContain('/workspace/_meta/work.json');
			expect(writePaths).toContain('/workspace/_meta/categories.json');
		});

		it('should not write empty arrays', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);
			await seedMetadata('/workspace', { categories: [], tags: [], brands: [] });
			expect(fs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe('readGeneratedItems', () => {
		const mockLogger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn() };

		it('should read valid JSON files and skip works', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: '_meta', isDirectory: () => true },
				{ name: 'item.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockImplementation(((filePath: string) => {
				if (filePath.includes('seeded.json')) return Promise.reject(new Error('ENOENT'));
				return Promise.resolve(
					JSON.stringify({
						name: 'Item',
						description: 'Desc',
						source_url: 'https://example.com',
						category: 'Cat',
						tags: ['tag1']
					})
				);
			}) as typeof fs.readFile);

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Item');
		});

		it('should skip unchanged seeded files via content hash', async () => {
			const seededContent = JSON.stringify({
				name: 'Seeded Item',
				description: 'Desc',
				source_url: 'https://seeded.com',
				category: 'Cat',
				tags: []
			});
			const { createHash } = await import('node:crypto');
			const seededHash = createHash('sha256').update(seededContent).digest('hex');

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'seeded.json', isDirectory: () => false },
				{ name: 'new-item.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockImplementation(((filePath: string) => {
				if (filePath.includes('seeded.json') && filePath.includes('_meta')) {
					return Promise.resolve(JSON.stringify({ 'seeded.json': seededHash }));
				}
				if (filePath.includes('seeded.json')) return Promise.resolve(seededContent);
				return Promise.resolve(
					JSON.stringify({
						name: 'New Item',
						description: 'Desc',
						source_url: 'https://example.com',
						category: 'Cat',
						tags: []
					})
				);
			}) as typeof fs.readFile);

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('New Item');
		});

		it('should return modified seeded files', async () => {
			const originalContent = JSON.stringify({ name: 'Cursor', description: 'Original' });
			const { createHash } = await import('node:crypto');
			const originalHash = createHash('sha256').update(originalContent).digest('hex');

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'cursor.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockImplementation(((filePath: string) => {
				if (filePath.includes('_meta')) {
					return Promise.resolve(JSON.stringify({ 'cursor.json': originalHash }));
				}
				return Promise.resolve(
					JSON.stringify({
						name: 'Cursor',
						description: 'Updated',
						source_url: 'https://cursor.sh',
						category: 'Editors',
						tags: []
					})
				);
			}) as typeof fs.readFile);

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(1);
			expect(result[0].description).toBe('Updated');
		});

		it('should skip invalid items and log warnings', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'bad.json', isDirectory: () => false },
				{ name: 'broken.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockImplementation(((filePath: string) => {
				if (filePath.includes('seeded.json')) return Promise.reject(new Error('ENOENT'));
				if (filePath.includes('broken.json')) return Promise.resolve('not json{{{');
				return Promise.resolve(JSON.stringify({ name: 'Missing Fields' }));
			}) as typeof fs.readFile);

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(0);
			expect(mockLogger.warn).toHaveBeenCalledTimes(2);
		});
	});

	describe('ensureOnboardingConfig', () => {
		const configDir = '/tmp/gemini-generator/user1';

		it('should create config when file does not exist', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await ensureOnboardingConfig(configDir);

			const written = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string);
			expect(written.general.disableAutoUpdate).toBe(true);
			expect(written.general.disableUpdateNag).toBe(true);
			expect(written.general.checkpointing.enabled).toBe(false);
			expect(written.tools.sandbox).toBe(true);
		});

		it('should not overwrite when all flags are already set', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					general: {
						disableAutoUpdate: true,
						disableUpdateNag: true,
						checkpointing: { enabled: false }
					},
					tools: {
						sandbox: true
					}
				})
			);

			await ensureOnboardingConfig(configDir);

			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('should patch existing config preserving other keys', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ someExisting: 'data' }));
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await ensureOnboardingConfig(configDir);

			const written = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string);
			expect(written.general.disableAutoUpdate).toBe(true);
			expect(written.someExisting).toBe('data');
		});
	});

	describe('cleanupWorkspace', () => {
		it('should remove workspace work', async () => {
			vi.mocked(fs.rm).mockResolvedValue(undefined);
			await cleanupWorkspace('/tmp/gemini-generator/user1/dir1/run-123');
			expect(fs.rm).toHaveBeenCalledWith('/tmp/gemini-generator/user1/dir1/run-123', {
				recursive: true,
				force: true
			});
		});

		it('should not throw on failure', async () => {
			vi.mocked(fs.rm).mockRejectedValue(new Error('Permission denied'));
			await expect(cleanupWorkspace('/tmp/gemini-generator/user1/dir1/run-123')).resolves.not.toThrow();
		});
	});
});
