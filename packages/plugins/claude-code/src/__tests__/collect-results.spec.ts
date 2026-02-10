import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import { readGeneratedItems, collectMetadataFromItems } from '../utils/workspace-manager';

vi.mock('fs/promises');

/**
 * Tests focused on the result collection logic:
 * JSON parsing, field validation, metadata reading, error handling.
 */
describe('collect-results', () => {
	const mockLogger = {
		log: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn()
	};

	beforeEach(() => {
		vi.resetAllMocks();
	});

	describe('readGeneratedItems - validation', () => {
		function setupSingleFile(content: string) {
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'item.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);
		}

		it('should accept item with all required fields', async () => {
			setupSingleFile(
				JSON.stringify({
					name: 'VS Code',
					description: 'A code editor',
					source_url: 'https://code.visualstudio.com',
					category: 'Code Editors',
					tags: ['editor', 'ide']
				})
			);

			const result = await readGeneratedItems('/workspace', mockLogger);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('VS Code');
		});

		it('should reject item without name', async () => {
			setupSingleFile(
				JSON.stringify({
					description: 'Desc',
					source_url: 'https://example.com',
					category: 'Cat'
				})
			);

			const result = await readGeneratedItems('/workspace', mockLogger);
			expect(result).toHaveLength(0);
		});

		it('should reject item without description', async () => {
			setupSingleFile(
				JSON.stringify({
					name: 'Test',
					source_url: 'https://example.com',
					category: 'Cat'
				})
			);

			const result = await readGeneratedItems('/workspace', mockLogger);
			expect(result).toHaveLength(0);
		});

		it('should reject item without source_url', async () => {
			setupSingleFile(
				JSON.stringify({
					name: 'Test',
					description: 'Desc',
					category: 'Cat'
				})
			);

			const result = await readGeneratedItems('/workspace', mockLogger);
			expect(result).toHaveLength(0);
		});

		it('should reject item without category', async () => {
			setupSingleFile(
				JSON.stringify({
					name: 'Test',
					description: 'Desc',
					source_url: 'https://example.com'
				})
			);

			const result = await readGeneratedItems('/workspace', mockLogger);
			expect(result).toHaveLength(0);
		});

		it('should accept item with optional fields', async () => {
			setupSingleFile(
				JSON.stringify({
					name: 'Test',
					description: 'Desc',
					source_url: 'https://example.com',
					category: 'Cat',
					tags: ['tag'],
					featured: true,
					slug: 'test',
					brand: 'TestBrand',
					markdown: '# Test',
					images: ['https://img.com/test.png']
				})
			);

			const result = await readGeneratedItems('/workspace', mockLogger);
			expect(result).toHaveLength(1);
			expect(result[0].featured).toBe(true);
			expect(result[0].brand).toBe('TestBrand');
		});

		it('should handle completely invalid JSON', async () => {
			setupSingleFile('}}not json at all{{');

			const result = await readGeneratedItems('/workspace', mockLogger);
			expect(result).toHaveLength(0);
			expect(mockLogger.warn).toHaveBeenCalled();
		});

		it('should handle empty file', async () => {
			setupSingleFile('');

			const result = await readGeneratedItems('/workspace', mockLogger);
			expect(result).toHaveLength(0);
		});
	});

	describe('readGeneratedItems - multiple files', () => {
		it('should collect items from multiple valid files', async () => {
			const item1 = { name: 'A', description: 'D', source_url: 'https://a.com', category: 'C', tags: [] };
			const item2 = { name: 'B', description: 'D', source_url: 'https://b.com', category: 'C', tags: [] };

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'a.json', isDirectory: () => false },
				{ name: 'b.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const p = filePath as string;
				if (p.endsWith('a.json')) return JSON.stringify(item1);
				if (p.endsWith('b.json')) return JSON.stringify(item2);
				throw new Error('Not found');
			});

			const result = await readGeneratedItems('/workspace', mockLogger);
			expect(result).toHaveLength(2);
		});

		it('should skip invalid items but keep valid ones', async () => {
			const valid = { name: 'A', description: 'D', source_url: 'https://a.com', category: 'C', tags: [] };
			const invalid = { name: 'B' }; // Missing required fields

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'good.json', isDirectory: () => false },
				{ name: 'bad.json', isDirectory: () => false }
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				const p = filePath as string;
				if (p.endsWith('/good.json')) return JSON.stringify(valid);
				if (p.endsWith('/bad.json')) return JSON.stringify(invalid);
				throw new Error('Not found');
			});

			const result = await readGeneratedItems('/workspace', mockLogger);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('A');
		});
	});

	describe('collectMetadataFromItems', () => {
		it('should collect unique categories from items', () => {
			const items = [
				{ name: 'A', description: 'D', source_url: 'https://a.com', category: 'Monitoring', tags: [] },
				{ name: 'B', description: 'D', source_url: 'https://b.com', category: 'Monitoring', tags: [] },
				{ name: 'C', description: 'D', source_url: 'https://c.com', category: 'CI/CD', tags: [] }
			];

			const result = collectMetadataFromItems(items);
			expect(result.categories).toHaveLength(2);
			expect(result.categories.map((c) => c.name)).toEqual(['Monitoring', 'CI/CD']);
		});

		it('should collect unique tags from items', () => {
			const items = [
				{
					name: 'A',
					description: 'D',
					source_url: 'https://a.com',
					category: 'C',
					tags: ['open-source', 'cloud']
				},
				{
					name: 'B',
					description: 'D',
					source_url: 'https://b.com',
					category: 'C',
					tags: ['cloud', 'real-time']
				}
			];

			const result = collectMetadataFromItems(items);
			expect(result.tags).toHaveLength(3);
			expect(result.tags.map((t) => t.name)).toEqual(['open-source', 'cloud', 'real-time']);
		});

		it('should collect brands with logo_url from items', () => {
			const items = [
				{
					name: 'A',
					description: 'D',
					source_url: 'https://a.com',
					category: 'C',
					tags: [],
					brand: 'Google',
					brand_logo_url: 'https://google.com/logo.svg'
				},
				{ name: 'B', description: 'D', source_url: 'https://b.com', category: 'C', tags: [], brand: 'Google' },
				{ name: 'C', description: 'D', source_url: 'https://c.com', category: 'C', tags: [] }
			];

			const result = collectMetadataFromItems(items);
			expect(result.brands).toHaveLength(1);
			expect(result.brands[0].name).toBe('Google');
			expect(result.brands[0].logo_url).toBe('https://google.com/logo.svg');
		});

		it('should return empty arrays for empty items', () => {
			const result = collectMetadataFromItems([]);
			expect(result.categories).toEqual([]);
			expect(result.tags).toEqual([]);
			expect(result.brands).toEqual([]);
		});
	});
});
