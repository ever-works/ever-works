import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pluginPackage from '@ever-works/plugin';
import {
	createWorkspace as createPluginWorkspace,
	getWorkspacePath,
	readGeneratedItems,
	readGeneratedResult,
	writeResultSchema
} from '../utils/workspace-manager.js';
import { BASE_TEMP_DIR } from '../types.js';

const tmpDirs: string[] = [];

async function createWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-agent-plugin-test-'));
	await fs.mkdir(path.join(dir, '_meta'), { recursive: true });
	tmpDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('workspace manager', () => {
	it('creates isolated workspaces for concurrent runs of the same directory', async () => {
		const workspaceA = await createPluginWorkspace('user-1', 'dir-1');
		const workspaceB = await createPluginWorkspace('user-1', 'dir-1');
		tmpDirs.push(path.resolve(BASE_TEMP_DIR));

		expect(workspaceA).not.toBe(workspaceB);
		expect(path.basename(workspaceA)).toMatch(/^run-/);
		expect(path.basename(workspaceB)).toMatch(/^run-/);
		expect(workspaceA.startsWith(getWorkspacePath('user-1', 'dir-1'))).toBe(true);
		expect(workspaceB.startsWith(getWorkspacePath('user-1', 'dir-1'))).toBe(true);
	});

	it('sanitizes workspace path segments so they stay under the Hermes temp root', () => {
		const workspaceRoot = getWorkspacePath('../unsafe/user', '../../unsafe/dir');
		const resolvedBaseDir = path.resolve(BASE_TEMP_DIR);
		const relativePath = path.relative(resolvedBaseDir, workspaceRoot);

		expect(workspaceRoot.startsWith(`${resolvedBaseDir}${path.sep}`)).toBe(true);
		expect(relativePath.split(path.sep)).not.toContain('..');
	});

	it('writes a result schema file', async () => {
		const workspace = await createWorkspace();
		await writeResultSchema(workspace);
		const content = await fs.readFile(path.join(workspace, '_meta', 'hermes-result.schema.json'), 'utf-8');
		expect(content).toContain('"items"');
	});

	it('reads item objects from the Hermes result file', async () => {
		const workspace = await createWorkspace();
		await fs.writeFile(
			path.join(workspace, '_meta', 'hermes-result.json'),
			JSON.stringify({
				items: [
					{
						name: 'Example',
						description: 'Example item',
						source_url: 'https://example.com',
						category: 'Tools',
						tags: ['alpha', 'beta']
					}
				]
			}),
			'utf-8'
		);

		const items = await readGeneratedItems(workspace, { warn: () => {} });
		expect(items).toHaveLength(1);
		expect(items[0]?.name).toBe('Example');
	});

	it('skips invalid items', async () => {
		const workspace = await createWorkspace();
		await fs.writeFile(
			path.join(workspace, '_meta', 'hermes-result.json'),
			JSON.stringify({ items: [{ name: 'Invalid' }] }),
			'utf-8'
		);

		const items = await readGeneratedItems(workspace, { warn: () => {} });
		expect(items).toEqual([]);
	});

	it('returns detailed validation errors for malformed result items', async () => {
		const workspace = await createWorkspace();
		await fs.writeFile(
			path.join(workspace, '_meta', 'hermes-result.json'),
			JSON.stringify({
				items: [
					{
						name: 'Invalid',
						description: 'Missing category and source',
						tags: 'not-an-array'
					}
				]
			}),
			'utf-8'
		);

		const result = await readGeneratedResult(workspace, { warn: () => {} });
		expect(result.items).toEqual([]);
		expect(result.errors).toContain('Item 0 is missing required fields: source_url, category');
		expect(result.errors).toContain('Item 0 has invalid tags: expected an array of strings');
		expect(result.resultFilePath).toContain('_meta/hermes-result.json');
	});

	it('returns a friendly error when malformed JSON cannot be repaired', async () => {
		const workspace = await createWorkspace();
		const repairSpy = vi.spyOn(pluginPackage, 'jsonrepair').mockImplementation(() => {
			throw new Error('repair failed');
		});
		await fs.writeFile(path.join(workspace, '_meta', 'hermes-result.json'), '{"items":[{"name":"Broken"', 'utf-8');

		const result = await readGeneratedResult(workspace, { warn: () => {} });
		repairSpy.mockRestore();
		expect(result.items).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('Hermes result file contained invalid JSON and could not be repaired');
	});
});
