import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	createWorkspace,
	getWorkspacePath,
	readGeneratedItems,
	seedExistingItems,
	seedMetadata
} from '../utils/workspace-manager.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('workspace-manager', () => {
	it('creates a workspace with the _meta directory', async () => {
		const userId = `user-${Date.now()}`;
		const directoryId = `dir-${Date.now()}`;
		const workspacePath = await createWorkspace(userId, directoryId);
		cleanupPaths.push(path.join('/tmp/codex-generator', userId));

		expect(workspacePath).toBe(getWorkspacePath(userId, directoryId));

		const metaStats = await fs.stat(path.join(workspacePath, '_meta'));
		expect(metaStats.isDirectory()).toBe(true);
	});

	it('writes metadata files when provided', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workspace-meta-'));
		cleanupPaths.push(tempRoot);
		await fs.mkdir(path.join(tempRoot, '_meta'), { recursive: true });

		await seedMetadata(tempRoot, {
			directory: { name: 'Directory', description: 'Desc' },
			request: { name: 'Prompt name', prompt: 'Prompt text' },
			categories: [{ id: 'cat', name: 'Cat' }],
			tags: [{ id: 'tag', name: 'Tag' }]
		});

		await expect(fs.readFile(path.join(tempRoot, '_meta', 'directory.json'), 'utf-8')).resolves.toContain(
			'Directory'
		);
		await expect(fs.readFile(path.join(tempRoot, '_meta', 'request.json'), 'utf-8')).resolves.toContain(
			'Prompt text'
		);
	});

	it('returns only changed or new generated items', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workspace-items-'));
		cleanupPaths.push(tempRoot);
		await fs.mkdir(path.join(tempRoot, '_meta'), { recursive: true });

		await seedExistingItems(tempRoot, [
			{
				name: 'Cursor',
				description: 'Existing item',
				source_url: 'https://cursor.com',
				category: 'Editors',
				tags: ['editor'],
				slug: 'cursor'
			}
		]);

		await fs.writeFile(
			path.join(tempRoot, 'new-item.json'),
			JSON.stringify(
				{
					name: 'New Item',
					description: 'Generated item',
					source_url: 'https://example.com',
					category: 'Testing',
					tags: ['generated']
				},
				null,
				2
			),
			'utf-8'
		);

		const items = await readGeneratedItems(tempRoot, { warn: () => {} });

		expect(items).toHaveLength(1);
		expect(items[0].name).toBe('New Item');
	});

	it('returns modified seeded items when content changes', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workspace-modified-'));
		cleanupPaths.push(tempRoot);
		await fs.mkdir(path.join(tempRoot, '_meta'), { recursive: true });

		await seedExistingItems(tempRoot, [
			{
				name: 'Cursor',
				description: 'Existing item',
				source_url: 'https://cursor.com',
				category: 'Editors',
				tags: ['editor'],
				slug: 'cursor'
			}
		]);

		await fs.writeFile(
			path.join(tempRoot, 'cursor.json'),
			JSON.stringify(
				{
					name: 'Cursor',
					description: 'Updated item',
					source_url: 'https://cursor.com',
					category: 'Editors',
					tags: ['editor']
				},
				null,
				2
			),
			'utf-8'
		);

		const items = await readGeneratedItems(tempRoot, { warn: () => {} });

		expect(items).toHaveLength(1);
		expect(items[0].description).toBe('Updated item');
	});
});
