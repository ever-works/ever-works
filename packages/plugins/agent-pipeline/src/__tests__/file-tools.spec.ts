import { describe, it, expect, vi } from 'vitest';
import { createCreateFileTool, createUpdateFileTool } from '../tools/file-tools';
import * as taxonomySync from '../utils/taxonomy-sync';

function createMockSandbox(existingFiles: Record<string, string> = {}) {
	const files = new Map(Object.entries(existingFiles));
	return {
		readFile: vi.fn(async (path: string) => {
			if (!files.has(path)) throw new Error('ENOENT');
			return files.get(path)!;
		}),
		writeFiles: vi.fn(async (entries: Array<{ path: string; content: string }>) => {
			for (const { path, content } of entries) {
				files.set(path, content);
			}
		})
	};
}

describe('file-tools', () => {
	describe('createFile', () => {
		it('should create a new file successfully', async () => {
			const sandbox = createMockSandbox();
			const tool = createCreateFileTool(sandbox, '/');

			const result = await (tool as any).execute({ path: 'new-item.json', content: '{"name":"Test"}' });

			expect(result).toEqual({ success: true, path: 'new-item.json' });
			expect(sandbox.writeFiles).toHaveBeenCalledWith([{ path: '/new-item.json', content: '{"name":"Test"}' }]);
		});

		it('should return error when file already exists', async () => {
			const sandbox = createMockSandbox({ '/existing.json': '{"name":"Old"}' });
			const tool = createCreateFileTool(sandbox, '/');

			const result = await (tool as any).execute({ path: 'existing.json', content: '{"name":"New"}' });

			expect(result.success).toBe(false);
			expect(result.error).toContain('already exists');
			expect(result.error).toContain('updateFile');
			expect(sandbox.writeFiles).not.toHaveBeenCalled();
		});

		it('should resolve relative paths against cwd', async () => {
			const sandbox = createMockSandbox();
			const tool = createCreateFileTool(sandbox, '/workspace');

			const result = await (tool as any).execute({ path: 'sub/file.json', content: '{}' });

			expect(result).toEqual({ success: true, path: 'sub/file.json' });
			expect(sandbox.writeFiles).toHaveBeenCalledWith([{ path: '/workspace/sub/file.json', content: '{}' }]);
		});

		it('should trigger taxonomy sync after write', async () => {
			const spy = vi.spyOn(taxonomySync, 'syncTaxonomyFromFile').mockResolvedValue();
			const sandbox = createMockSandbox();
			const tool = createCreateFileTool(sandbox, '/workspace');
			const content = JSON.stringify({ name: 'Tool', category: 'AI' });

			await (tool as any).execute({ path: 'tool.json', content });

			expect(spy).toHaveBeenCalledWith(
				expect.any(Function),
				expect.any(Function),
				'/workspace/tool.json',
				content
			);
			spy.mockRestore();
		});

		it('should succeed even if taxonomy sync fails', async () => {
			const spy = vi.spyOn(taxonomySync, 'syncTaxonomyFromFile').mockRejectedValue(new Error('sync failed'));
			const sandbox = createMockSandbox();
			const tool = createCreateFileTool(sandbox, '/workspace');
			const content = JSON.stringify({ name: 'Tool', category: 'AI' });

			const result = await (tool as any).execute({ path: 'tool.json', content });

			expect(result).toEqual({ success: true, path: 'tool.json' });
			spy.mockRestore();
		});
	});

	describe('updateFile', () => {
		it('should update an existing file successfully', async () => {
			const sandbox = createMockSandbox({ '/existing.json': '{"name":"Old"}' });
			const tool = createUpdateFileTool(sandbox, '/');

			const result = await (tool as any).execute({ path: 'existing.json', content: '{"name":"Updated"}' });

			expect(result).toEqual({ success: true, path: 'existing.json' });
			expect(sandbox.writeFiles).toHaveBeenCalledWith([
				{ path: '/existing.json', content: '{"name":"Updated"}' }
			]);
		});

		it('should return error when file does not exist', async () => {
			const sandbox = createMockSandbox();
			const tool = createUpdateFileTool(sandbox, '/');

			const result = await (tool as any).execute({ path: 'missing.json', content: '{"name":"New"}' });

			expect(result.success).toBe(false);
			expect(result.error).toContain('does not exist');
			expect(result.error).toContain('createFile');
			expect(sandbox.writeFiles).not.toHaveBeenCalled();
		});

		it('should resolve relative paths against cwd', async () => {
			const sandbox = createMockSandbox({ '/workspace/data.json': '{}' });
			const tool = createUpdateFileTool(sandbox, '/workspace');

			const result = await (tool as any).execute({ path: 'data.json', content: '{"updated":true}' });

			expect(result).toEqual({ success: true, path: 'data.json' });
			expect(sandbox.writeFiles).toHaveBeenCalledWith([
				{ path: '/workspace/data.json', content: '{"updated":true}' }
			]);
		});

		it('should trigger taxonomy sync after update', async () => {
			const spy = vi.spyOn(taxonomySync, 'syncTaxonomyFromFile').mockResolvedValue();
			const content = JSON.stringify({ name: 'Tool', category: 'AI' });
			const sandbox = createMockSandbox({ '/workspace/tool.json': '{"name":"Old"}' });
			const tool = createUpdateFileTool(sandbox, '/workspace');

			await (tool as any).execute({ path: 'tool.json', content });

			expect(spy).toHaveBeenCalledWith(
				expect.any(Function),
				expect.any(Function),
				'/workspace/tool.json',
				content
			);
			spy.mockRestore();
		});
	});

	// H-23 — reject paths that try to escape the workspace cwd.
	describe('H-23 — path-escape rejection', () => {
		it('rejects an absolute POSIX path passed by the model', async () => {
			const sandbox = createMockSandbox();
			const tool = createCreateFileTool(sandbox, '/workspace');

			const result = await (tool as any).execute({
				path: '/etc/passwd',
				content: 'attacker-payload'
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/absolute paths are not allowed/);
			expect(sandbox.writeFiles).not.toHaveBeenCalled();
		});

		it('rejects an absolute Windows path passed by the model', async () => {
			const sandbox = createMockSandbox();
			const tool = createCreateFileTool(sandbox, '/workspace');

			const result = await (tool as any).execute({
				path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
				content: 'attacker-payload'
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/absolute paths are not allowed/);
			expect(sandbox.writeFiles).not.toHaveBeenCalled();
		});

		it('rejects a relative path that traverses out of cwd', async () => {
			const sandbox = createMockSandbox();
			const tool = createCreateFileTool(sandbox, '/workspace');

			const result = await (tool as any).execute({
				path: '../../etc/passwd',
				content: 'attacker-payload'
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/resolves outside the workspace/);
			expect(sandbox.writeFiles).not.toHaveBeenCalled();
		});

		it('rejects empty path', async () => {
			const sandbox = createMockSandbox();
			const tool = createCreateFileTool(sandbox, '/workspace');

			const result = await (tool as any).execute({ path: '', content: 'x' });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/non-empty string/);
		});
	});
});
