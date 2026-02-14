import { describe, it, expect, vi } from 'vitest';
import { createCreateFileTool, createUpdateFileTool } from '../tools/file-tools';

function createMockSandbox(existingFiles: Record<string, string> = {}) {
	const files = new Map(Object.entries(existingFiles));
	return {
		fs: {
			exists: vi.fn(async (path: string) => files.has(path))
		},
		readFile: vi.fn(async (path: string) => {
			if (!files.has(path)) throw new Error('ENOENT');
			return files.get(path)!;
		}),
		writeFile: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
		})
	};
}

describe('file-tools', () => {
	describe('createFile', () => {
		it('should create a new file successfully', async () => {
			const sandbox = createMockSandbox();
			const tool = createCreateFileTool(sandbox);

			const result = await (tool as any).execute({ path: 'new-item.json', content: '{"name":"Test"}' });

			expect(result).toEqual({ success: true, path: 'new-item.json' });
			expect(sandbox.writeFile).toHaveBeenCalledWith('new-item.json', '{"name":"Test"}');
		});

		it('should return error when file already exists', async () => {
			const sandbox = createMockSandbox({ 'existing.json': '{"name":"Old"}' });
			const tool = createCreateFileTool(sandbox);

			const result = await (tool as any).execute({ path: 'existing.json', content: '{"name":"New"}' });

			expect(result.success).toBe(false);
			expect(result.error).toContain('already exists');
			expect(result.error).toContain('updateFile');
			expect(sandbox.writeFile).not.toHaveBeenCalled();
		});
	});

	describe('updateFile', () => {
		it('should update an existing file successfully', async () => {
			const sandbox = createMockSandbox({ 'existing.json': '{"name":"Old"}' });
			const tool = createUpdateFileTool(sandbox);

			const result = await (tool as any).execute({ path: 'existing.json', content: '{"name":"Updated"}' });

			expect(result).toEqual({ success: true, path: 'existing.json' });
			expect(sandbox.writeFile).toHaveBeenCalledWith('existing.json', '{"name":"Updated"}');
		});

		it('should return error when file does not exist', async () => {
			const sandbox = createMockSandbox();
			const tool = createUpdateFileTool(sandbox);

			const result = await (tool as any).execute({ path: 'missing.json', content: '{"name":"New"}' });

			expect(result.success).toBe(false);
			expect(result.error).toContain('does not exist');
			expect(result.error).toContain('createFile');
			expect(sandbox.writeFile).not.toHaveBeenCalled();
		});
	});
});
