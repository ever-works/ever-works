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
import type { ItemData, Category } from '@ever-works/plugin';

vi.mock('fs/promises');

describe('workspace-manager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('createWorkspace', () => {
		it('should clean up existing workspace and create _meta directory', async () => {
			vi.mocked(fs.rm).mockResolvedValue(undefined);
			vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string);

			const result = await createWorkspace('user1', 'dir1');

			expect(fs.rm).toHaveBeenCalledWith('/tmp/claude-code-generator/user1/dir1', {
				recursive: true,
				force: true
			});
			expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('_meta'), { recursive: true });
			expect(result).toBe('/tmp/claude-code-generator/user1/dir1');
		});
	});

	describe('seedExistingItems', () => {
		it('should write item files, seeded manifest, and JSONL index', async () => {
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
			expect(JSON.parse(seededCall![1] as string)).toEqual(['cursor.json']);

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
				directory: { name: 'Dir', description: 'Desc' },
				categories
			});

			const writePaths = vi.mocked(fs.writeFile).mock.calls.map((c) => c[0]);
			expect(writePaths).toContain('/workspace/_meta/directory.json');
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

		it('should read valid JSON files and skip directories', async () => {
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

		it('should skip unchanged seeded files via mtime', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'seeded.json', isDirectory: () => false },
				{ name: 'new-item.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockImplementation(((filePath: string) => {
				if (filePath.includes('seeded.json') && filePath.includes('_meta')) {
					return Promise.resolve(JSON.stringify(['seeded.json']));
				}
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

			vi.mocked(fs.stat).mockImplementation(((filePath: string) => {
				if (filePath.includes('_meta')) return Promise.resolve({ mtimeMs: 1000 });
				if (filePath.includes('seeded.json')) return Promise.resolve({ mtimeMs: 900 });
				return Promise.resolve({ mtimeMs: 2000 });
			}) as unknown as typeof fs.stat);

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('New Item');
		});

		it('should return modified seeded files', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'cursor.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockImplementation(((filePath: string) => {
				if (filePath.includes('_meta')) return Promise.resolve(JSON.stringify(['cursor.json']));
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

			vi.mocked(fs.stat).mockImplementation(((filePath: string) => {
				if (filePath.includes('_meta')) return Promise.resolve({ mtimeMs: 1000 });
				return Promise.resolve({ mtimeMs: 2000 });
			}) as unknown as typeof fs.stat);

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
		const configDir = '/tmp/claude-code-generator/user1';

		it('should create config when file does not exist', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await ensureOnboardingConfig(configDir);

			const written = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string);
			expect(written.hasCompletedOnboarding).toBe(true);
			expect(written.bypassPermissionsModeAccepted).toBe(true);
		});

		it('should not overwrite when all flags are already set', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					hasCompletedOnboarding: true,
					bypassPermissionsModeAccepted: true,
					hasTrustDialogHooksAccepted: true,
					autoUpdates: false
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
			expect(written.hasCompletedOnboarding).toBe(true);
			expect(written.someExisting).toBe('data');
		});
	});

	describe('cleanupWorkspace', () => {
		it('should remove workspace directory', async () => {
			vi.mocked(fs.rm).mockResolvedValue(undefined);
			await cleanupWorkspace('user1', 'dir1');
			expect(fs.rm).toHaveBeenCalledWith('/tmp/claude-code-generator/user1/dir1', {
				recursive: true,
				force: true
			});
		});

		it('should not throw on failure', async () => {
			vi.mocked(fs.rm).mockRejectedValue(new Error('Permission denied'));
			await expect(cleanupWorkspace('user1', 'dir1')).resolves.not.toThrow();
		});
	});
});
