import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
	slugify,
	getWorkspacePath,
	createWorkspace,
	seedExistingItems,
	seedMetadata,
	readGeneratedItems,
	collectMetadataFromItems,
	cleanupWorkspace,
	ensureOnboardingConfig
} from '../utils/workspace-manager';
import type { ItemData, Category, Tag, Brand } from '@ever-works/plugin';

vi.mock('fs/promises');

describe('workspace-manager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('slugify', () => {
		it('should convert to lowercase', () => {
			expect(slugify('Hello World')).toBe('hello-world');
		});

		it('should replace spaces with hyphens', () => {
			expect(slugify('foo bar baz')).toBe('foo-bar-baz');
		});

		it('should remove special characters', () => {
			expect(slugify('Hello, World!')).toBe('hello-world');
		});

		it('should collapse multiple hyphens', () => {
			expect(slugify('foo---bar')).toBe('foo-bar');
		});

		it('should trim leading and trailing hyphens', () => {
			expect(slugify('  -hello-  ')).toBe('hello');
		});

		it('should handle underscores', () => {
			expect(slugify('foo_bar_baz')).toBe('foo-bar-baz');
		});

		it('should handle empty string', () => {
			expect(slugify('')).toBe('');
		});
	});

	describe('getWorkspacePath', () => {
		it('should return path under BASE_TEMP_DIR', () => {
			const result = getWorkspacePath('user1', 'dir1');
			expect(result).toBe('/tmp/claude-code-generator/user1/dir1');
		});
	});

	describe('createWorkspace', () => {
		it('should remove existing workspace', async () => {
			vi.mocked(fs.rm).mockResolvedValue(undefined);
			vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string);

			await createWorkspace('user1', 'dir1');

			expect(fs.rm).toHaveBeenCalledWith('/tmp/claude-code-generator/user1/dir1', {
				recursive: true,
				force: true
			});
		});

		it('should create workspace with _meta directory', async () => {
			vi.mocked(fs.rm).mockResolvedValue(undefined);
			vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string);

			await createWorkspace('user1', 'dir1');

			expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('_meta'), { recursive: true });
		});

		it('should return workspace path', async () => {
			vi.mocked(fs.rm).mockResolvedValue(undefined);
			vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string);

			const result = await createWorkspace('user1', 'dir1');

			expect(result).toBe('/tmp/claude-code-generator/user1/dir1');
		});
	});

	describe('seedExistingItems', () => {
		it('should write each item as a JSON file', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const items: ItemData[] = [
				{
					name: 'Test Item',
					description: 'A test',
					source_url: 'https://example.com',
					category: 'Testing',
					tags: ['test'],
					slug: 'test-item'
				}
			];

			await seedExistingItems('/workspace', items);

			expect(fs.writeFile).toHaveBeenCalledWith('/workspace/test-item.json', expect.any(String), 'utf-8');
		});

		it('should generate slug from name if missing', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const items: ItemData[] = [
				{
					name: 'My Awesome Tool',
					description: 'A tool',
					source_url: 'https://example.com',
					category: 'Tools',
					tags: []
				}
			];

			await seedExistingItems('/workspace', items);

			expect(fs.writeFile).toHaveBeenCalledWith('/workspace/my-awesome-tool.json', expect.any(String), 'utf-8');
		});

		it('should handle duplicate slugs by appending index', async () => {
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

			const calls = vi.mocked(fs.writeFile).mock.calls;
			expect(calls[0][0]).toBe('/workspace/test.json');
			expect(calls[1][0]).toBe('/workspace/test-2.json');
		});

		it('should do nothing for empty items array', async () => {
			await seedExistingItems('/workspace', []);
			expect(fs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe('seedMetadata', () => {
		it('should write directory metadata', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await seedMetadata('/workspace', {
				directory: { name: 'Dir', description: 'Desc' }
			});

			expect(fs.writeFile).toHaveBeenCalledWith('/workspace/_meta/directory.json', expect.any(String), 'utf-8');
		});

		it('should write categories when provided', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const categories: Category[] = [{ id: '1', name: 'Cat1' }];
			await seedMetadata('/workspace', { categories });

			expect(fs.writeFile).toHaveBeenCalledWith('/workspace/_meta/categories.json', expect.any(String), 'utf-8');
		});

		it('should not write empty arrays', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await seedMetadata('/workspace', {
				categories: [],
				tags: [],
				brands: []
			});

			expect(fs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe('readGeneratedItems', () => {
		const mockLogger = {
			log: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn()
		};

		it('should read valid JSON files from workspace root', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'item1.json', isDirectory: () => false },
				{ name: 'item2.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			const validItem = {
				name: 'Item 1',
				description: 'Desc',
				source_url: 'https://example.com',
				category: 'Cat',
				tags: ['tag1']
			};

			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validItem));

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('Item 1');
		});

		it('should skip directories', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: '_meta', isDirectory: () => true },
				{ name: 'item.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			const validItem = {
				name: 'Item',
				description: 'Desc',
				source_url: 'https://example.com',
				category: 'Cat',
				tags: []
			};

			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validItem));

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(1);
		});

		it('should skip non-JSON files', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'readme.md', isDirectory: () => false },
				{ name: 'item.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			const validItem = {
				name: 'Item',
				description: 'Desc',
				source_url: 'https://example.com',
				category: 'Cat',
				tags: []
			};

			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validItem));

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(1);
		});

		it('should skip items missing required fields', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'bad.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					name: 'Missing Fields'
					// Missing description, source_url, category
				})
			);

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(0);
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('missing required fields'));
		});

		it('should skip invalid JSON files', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'bad.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockResolvedValue('not json{{{');

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(0);
			expect(mockLogger.warn).toHaveBeenCalled();
		});

		it('should set tags to empty array if not present', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'item.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					name: 'Item',
					description: 'Desc',
					source_url: 'https://example.com',
					category: 'Cat'
				})
			);

			const result = await readGeneratedItems('/workspace', mockLogger);

			expect(result).toHaveLength(1);
			expect(result[0].tags).toEqual([]);
		});
	});

	describe('collectMetadataFromItems', () => {
		it('should collect categories, tags, and brands from items', () => {
			const items: ItemData[] = [
				{
					name: 'A',
					description: 'D',
					source_url: 'https://a.com',
					category: 'Monitoring',
					tags: ['cloud'],
					brand: 'CNCF'
				},
				{
					name: 'B',
					description: 'D',
					source_url: 'https://b.com',
					category: 'CI/CD',
					tags: ['cloud', 'devops'],
					brand: 'CNCF'
				}
			];

			const result = collectMetadataFromItems(items);

			expect(result.categories).toHaveLength(2);
			expect(result.tags).toHaveLength(2);
			expect(result.brands).toHaveLength(1);
		});

		it('should return empty arrays for empty items', () => {
			const result = collectMetadataFromItems([]);

			expect(result.categories).toEqual([]);
			expect(result.tags).toEqual([]);
			expect(result.brands).toEqual([]);
		});
	});

	describe('ensureOnboardingConfig', () => {
		const configDir = '/tmp/claude-code-generator/user1';
		const configFile = '/tmp/claude-code-generator/user1/.claude.json';

		it('should create config with all headless flags when file does not exist', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await ensureOnboardingConfig(configDir);

			expect(fs.mkdir).toHaveBeenCalledWith(configDir, { recursive: true });
			expect(fs.writeFile).toHaveBeenCalledWith(configFile, expect.any(String), 'utf-8');

			const written = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string);
			expect(written.hasCompletedOnboarding).toBe(true);
			expect(written.bypassPermissionsModeAccepted).toBe(true);
			expect(written.hasTrustDialogHooksAccepted).toBe(true);
			expect(written.autoUpdates).toBe(false);
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

		it('should patch existing config when flags are missing', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ someExisting: 'data' }));
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await ensureOnboardingConfig(configDir);

			expect(fs.writeFile).toHaveBeenCalled();
			const written = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string);
			expect(written.hasCompletedOnboarding).toBe(true);
			expect(written.bypassPermissionsModeAccepted).toBe(true);
			expect(written.hasTrustDialogHooksAccepted).toBe(true);
			expect(written.autoUpdates).toBe(false);
			expect(written.someExisting).toBe('data');
		});

		it('should handle invalid JSON in existing file', async () => {
			vi.mocked(fs.readFile).mockResolvedValue('not json{{{');
			vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await ensureOnboardingConfig(configDir);

			const written = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string);
			expect(written.hasCompletedOnboarding).toBe(true);
			expect(written.bypassPermissionsModeAccepted).toBe(true);
		});

		it('should write when a single flag differs', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({
					hasCompletedOnboarding: true,
					bypassPermissionsModeAccepted: true,
					hasTrustDialogHooksAccepted: true,
					autoUpdates: true // differs from expected false
				})
			);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await ensureOnboardingConfig(configDir);

			expect(fs.writeFile).toHaveBeenCalled();
			const written = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string);
			expect(written.autoUpdates).toBe(false);
		});

		it('should not include per-project entries (concurrent-safe)', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			await ensureOnboardingConfig(configDir);

			const written = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string);
			expect(written.projects).toBeUndefined();
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
