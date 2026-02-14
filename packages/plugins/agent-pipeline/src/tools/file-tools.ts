import { tool } from 'ai';
import { z } from 'zod';

interface SandboxLike {
	readonly fs: {
		exists(path: string): Promise<boolean>;
	};
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
}

/**
 * Create a `createFile` tool that writes a new file.
 * Returns an error if the file already exists, directing the agent to use `updateFile` instead.
 */
export function createCreateFileTool(sandbox: SandboxLike) {
	return tool({
		description: 'Create a new file. Fails if the file already exists — use updateFile to modify existing files.',
		inputSchema: z.object({
			path: z.string().describe('Path of the file to create (e.g., my-tool.json)'),
			content: z.string().describe('Content to write to the file')
		}),
		execute: async ({ path, content }) => {
			if (await sandbox.fs.exists(path)) {
				return {
					success: false,
					error: `File "${path}" already exists. Use the updateFile tool to modify existing files.`
				};
			}
			await sandbox.writeFile(path, content);
			return { success: true, path };
		}
	});
}

/**
 * Create an `updateFile` tool that overwrites an existing file.
 * Returns an error if the file does not exist, directing the agent to use `createFile` instead.
 */
export function createUpdateFileTool(sandbox: SandboxLike) {
	return tool({
		description: 'Update an existing file. Fails if the file does not exist — use createFile to create new files.',
		inputSchema: z.object({
			path: z.string().describe('Path of the existing file to update'),
			content: z.string().describe('New content for the file')
		}),
		execute: async ({ path, content }) => {
			if (!(await sandbox.fs.exists(path))) {
				return {
					success: false,
					error: `File "${path}" does not exist. Use the createFile tool to create new files.`
				};
			}
			await sandbox.writeFile(path, content);
			return { success: true, path };
		}
	});
}
