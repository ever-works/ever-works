import { describe, it, expect, vi } from 'vitest';
import { createValidateItemJsonTool } from '../tools/validate-json-tools';

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
		}),
		getFile: (path: string) => files.get(path)
	};
}

describe('validate-json-tools', () => {
	describe('validateItemJson', () => {
		it('should return valid for a correct JSON file', async () => {
			const sandbox = createMockSandbox({ '/item.json': '{"name":"Test","source_url":"https://example.com"}' });
			const tool = createValidateItemJsonTool(sandbox, '/');

			const result = await (tool as any).execute({ path: 'item.json' });

			expect(result).toEqual({ valid: true, message: 'JSON is valid.' });
			expect(sandbox.writeFiles).not.toHaveBeenCalled();
		});

		it('should repair invalid JSON with a missing colon and rewrite the file', async () => {
			// Missing colon between key and value
			const sandbox = createMockSandbox({ '/broken.json': '{"name" "Test"}' });
			const tool = createValidateItemJsonTool(sandbox, '/');

			const result = await (tool as any).execute({ path: 'broken.json' });

			expect(result.valid).toBe(true);
			expect(result.repaired).toBe(true);
			expect(result.message).toContain('repaired');
			expect(sandbox.writeFiles).toHaveBeenCalledOnce();

			// Verify the written content is valid JSON
			const writtenContent = sandbox.writeFiles.mock.calls[0][0][0].content;
			expect(() => JSON.parse(writtenContent)).not.toThrow();
		});

		it('should repair invalid JSON with a trailing comma', async () => {
			const sandbox = createMockSandbox({ '/trailing.json': '{"name":"Test","value":1,}' });
			const tool = createValidateItemJsonTool(sandbox, '/');

			const result = await (tool as any).execute({ path: 'trailing.json' });

			expect(result.valid).toBe(true);
			expect(result.repaired).toBe(true);
			expect(sandbox.writeFiles).toHaveBeenCalledOnce();

			const writtenContent = sandbox.writeFiles.mock.calls[0][0][0].content;
			const parsed = JSON.parse(writtenContent);
			expect(parsed.name).toBe('Test');
			expect(parsed.value).toBe(1);
		});

		it('should return error for file not found', async () => {
			const sandbox = createMockSandbox();
			const tool = createValidateItemJsonTool(sandbox, '/');

			const result = await (tool as any).execute({ path: 'missing.json' });

			expect(result.valid).toBe(false);
			expect(result.error).toContain('not found');
			expect(sandbox.writeFiles).not.toHaveBeenCalled();
		});

		it('should return error for completely unrepairable content', async () => {
			const sandbox = createMockSandbox({ '/garbage.json': '' });
			const tool = createValidateItemJsonTool(sandbox, '/');

			const result = await (tool as any).execute({ path: 'garbage.json' });

			expect(result.valid).toBe(false);
			expect(result.error).toContain('could not be repaired');
			expect(sandbox.writeFiles).not.toHaveBeenCalled();
		});

		it('should resolve relative paths against cwd', async () => {
			const sandbox = createMockSandbox({ '/workspace/item.json': '{"name":"Test"}' });
			const tool = createValidateItemJsonTool(sandbox, '/workspace');

			const result = await (tool as any).execute({ path: 'item.json' });

			expect(result).toEqual({ valid: true, message: 'JSON is valid.' });
			expect(sandbox.readFile).toHaveBeenCalledWith('/workspace/item.json');
		});
	});
});
