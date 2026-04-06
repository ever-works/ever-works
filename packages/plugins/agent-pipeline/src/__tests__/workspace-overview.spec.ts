import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readWorkspaceOverview } from '../tools/workspace-overview';
import * as fsPromises from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
	readFile: vi.fn(),
	readdir: vi.fn()
}));

describe('readWorkspaceOverview', () => {
	const mockReaddir = vi.mocked(fsPromises.readdir);
	const mockReadFile = vi.mocked(fsPromises.readFile);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns item count and taxonomy data', async () => {
		mockReaddir.mockResolvedValue(['item1.json', 'item2.json', '_meta'] as never[]);
		mockReadFile.mockImplementation(async (path) => {
			const p = String(path);
			if (p.includes('seeded.json'))
				return JSON.stringify({
					'item1.json': 'hash-1',
					'item2.json': 'hash-2'
				});
			if (p.includes('item1.json')) return JSON.stringify({ name: 'Item 1', source_url: 'https://a.com' });
			if (p.includes('item2.json'))
				return JSON.stringify({ name: 'Item 2 Updated', source_url: 'https://b.com' });
			if (p.includes('categories.json')) return JSON.stringify([{ id: 'monitoring', name: 'Monitoring' }]);
			if (p.includes('tags.json')) return JSON.stringify([{ id: 'open-source', name: 'Open Source' }]);
			if (p.includes('brands.json')) return JSON.stringify([{ id: 'cncf', name: 'CNCF' }]);
			throw new Error('Not found');
		});

		const result = await readWorkspaceOverview('/workspace');

		expect(result.totalItems).toBe(2);
		expect(result.newItems).toBe(0);
		expect(result.updatedItems).toBe(2);
		expect(result.categories).toEqual(['Monitoring']);
		expect(result.tags).toEqual(['Open Source']);
		expect(result.brands).toEqual(['CNCF']);
	});

	it('returns zeros when workspace is empty', async () => {
		mockReaddir.mockResolvedValue([] as never[]);
		mockReadFile.mockRejectedValue(new Error('Not found'));

		const result = await readWorkspaceOverview('/workspace');

		expect(result.totalItems).toBe(0);
		expect(result.newItems).toBe(0);
		expect(result.updatedItems).toBe(0);
		expect(result.categories).toEqual([]);
		expect(result.tags).toEqual([]);
		expect(result.brands).toEqual([]);
	});

	it('handles missing workspace directory', async () => {
		mockReaddir.mockRejectedValue(new Error('ENOENT'));
		mockReadFile.mockRejectedValue(new Error('ENOENT'));

		const result = await readWorkspaceOverview('/nonexistent');

		expect(result.totalItems).toBe(0);
		expect(result.newItems).toBe(0);
		expect(result.updatedItems).toBe(0);
		expect(result.categories).toEqual([]);
	});

	it('handles malformed taxonomy files', async () => {
		mockReaddir.mockResolvedValue(['item.json'] as never[]);
		mockReadFile.mockResolvedValue('not json' as never);

		const result = await readWorkspaceOverview('/workspace');

		expect(result.totalItems).toBe(1);
		expect(result.newItems).toBe(1);
		expect(result.updatedItems).toBe(0);
		expect(result.categories).toEqual([]);
	});

	it('handles null and primitive entries in taxonomy arrays', async () => {
		mockReaddir.mockResolvedValue(['item.json'] as never[]);
		mockReadFile.mockImplementation(async (path) => {
			const p = String(path);
			if (p.includes('categories.json'))
				return JSON.stringify([null, 42, 'bare-string', { name: 'Valid' }, { id: 'no-name' }]);
			if (p.includes('tags.json')) return JSON.stringify([null, { name: 'Good' }]);
			if (p.includes('brands.json')) return JSON.stringify([true, false, { name: 'Brand' }]);
			throw new Error('Not found');
		});

		const result = await readWorkspaceOverview('/workspace');

		expect(result.categories).toEqual(['Valid']);
		expect(result.tags).toEqual(['Good']);
		expect(result.brands).toEqual(['Brand']);
	});

	it('only counts .json files for totalItems', async () => {
		mockReaddir.mockResolvedValue(['item.json', 'readme.txt', 'data.csv', 'other.json'] as never[]);
		mockReadFile.mockRejectedValue(new Error('Not found'));

		const result = await readWorkspaceOverview('/workspace');

		expect(result.totalItems).toBe(2);
		expect(result.newItems).toBe(2);
		expect(result.updatedItems).toBe(0);
	});

	it('falls back to comparing against provided existing items when seeded hashes are unavailable', async () => {
		mockReaddir.mockResolvedValue(['existing-item.json', 'new-item.json'] as never[]);
		mockReadFile.mockImplementation(async (path) => {
			const p = String(path);
			if (p.includes('existing-item.json')) {
				return JSON.stringify({
					name: 'Existing Item',
					slug: 'existing-item',
					description: 'Updated description',
					source_url: 'https://existing.com',
					category: 'Monitoring'
				});
			}
			if (p.includes('new-item.json')) {
				return JSON.stringify({
					name: 'New Item',
					slug: 'new-item',
					description: 'Brand new',
					source_url: 'https://new.com',
					category: 'Monitoring'
				});
			}
			throw new Error('Not found');
		});

		const result = await readWorkspaceOverview('/workspace', [
			{
				name: 'Existing Item',
				slug: 'existing-item',
				description: 'Original description',
				source_url: 'https://existing.com',
				category: 'Monitoring'
			}
		]);

		expect(result.totalItems).toBe(2);
		expect(result.newItems).toBe(1);
		expect(result.updatedItems).toBe(1);
	});
});
