import * as fs from 'fs/promises';
import * as os from 'os';
// Source uses path/posix; tests must match so platform-specific separators
// don't drift assertions on Windows.
import * as path from 'path/posix';

import { afterEach, describe, expect, it } from 'vitest';

import {
	createWorkspace,
	describeWorkspaceOutputs,
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
	it('creates a workspace with the _meta work', async () => {
		const userId = `user-${Date.now()}`;
		const workId = `dir-${Date.now()}`;
		const workspacePath = await createWorkspace(userId, workId);
		cleanupPaths.push(path.join('/tmp/codex-generator', userId));

		expect(workspacePath.startsWith(path.join('/tmp/codex-generator', userId, `${workId}-`))).toBe(true);
		expect(path.dirname(workspacePath)).toBe(path.join('/tmp/codex-generator', userId));

		const metaStats = await fs.stat(path.join(workspacePath, '_meta'));
		expect(metaStats.isDirectory()).toBe(true);
	});

	it('writes metadata files when provided', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workspace-meta-'));
		cleanupPaths.push(tempRoot);
		await fs.mkdir(path.join(tempRoot, '_meta'), { recursive: true });

		await seedMetadata(tempRoot, {
			work: { name: 'Work', description: 'Desc' },
			request: { name: 'Prompt name', prompt: 'Prompt text' },
			categories: [{ id: 'cat', name: 'Cat' }],
			tags: [{ id: 'tag', name: 'Tag' }]
		});

		await expect(fs.readFile(path.join(tempRoot, '_meta', 'work.json'), 'utf-8')).resolves.toContain('Work');
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

	it('parses fenced or wrapped JSON item files', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workspace-fenced-'));
		cleanupPaths.push(tempRoot);
		await fs.mkdir(path.join(tempRoot, '_meta'), { recursive: true });

		await fs.writeFile(
			path.join(tempRoot, 'wrapped-item.json'),
			[
				'Here is the final item:',
				'```json',
				JSON.stringify(
					{
						item: {
							name: 'Wrapped Item',
							description: 'Recovered from fenced JSON',
							source_url: 'https://example.com/wrapped',
							category: 'Testing',
							tags: ['wrapped']
						}
					},
					null,
					2
				),
				'```'
			].join('\n'),
			'utf-8'
		);

		const items = await readGeneratedItems(tempRoot, { warn: () => {} });

		expect(items).toHaveLength(1);
		expect(items[0].name).toBe('Wrapped Item');
		expect(items[0].source_url).toBe('https://example.com/wrapped');
	});

	it('describes visible workspace outputs', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workspace-outputs-'));
		cleanupPaths.push(tempRoot);
		await fs.mkdir(path.join(tempRoot, '_meta'), { recursive: true });
		await fs.writeFile(path.join(tempRoot, 'alpha.json'), '{}', 'utf-8');
		await fs.mkdir(path.join(tempRoot, 'notes'), { recursive: true });

		const outputs = await describeWorkspaceOutputs(tempRoot);

		expect(outputs).toEqual(['_meta/', 'alpha.json', 'notes/']);
	});
});
