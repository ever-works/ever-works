import { tool } from 'ai';
import { z } from 'zod';
import { jsonrepair } from '@ever-works/plugin';
import { resolveSandboxPath } from './file-tools.js';
import type { WrappedSandbox } from '../types.js';

/**
 * Create a `validateItemJson` tool that validates a JSON file and attempts
 * automatic repair via jsonrepair when the content is invalid.
 */
export function createValidateItemJsonTool(sandbox: WrappedSandbox, cwd: string) {
	return tool({
		description:
			'Validate a JSON file. If invalid, attempts automatic repair and rewrites the file. Use this after creating or updating item files.',
		inputSchema: z.object({
			path: z.string().describe('Path of the JSON file to validate (e.g., my-item.json)')
		}),
		execute: async ({ path }) => {
			// Security: confine the LLM-supplied path to the workspace sandbox.
			// `resolveSandboxPath` rejects absolute paths and any traversal that
			// escapes `cwd`, matching createFile/updateFile in file-tools.ts. A
			// prompt-injected model could otherwise pass `/etc/passwd` or
			// `../../sensitive` and have it read/repaired-and-overwritten here.
			let resolvedPath: string;
			try {
				resolvedPath = resolveSandboxPath(cwd, path);
			} catch (err) {
				return { valid: false, error: err instanceof Error ? err.message : String(err) };
			}

			// Read the file
			let content: string;
			try {
				content = await sandbox.readFile(resolvedPath);
			} catch {
				return { valid: false, error: `File "${path}" not found.` };
			}

			// Try JSON.parse first
			try {
				JSON.parse(content);
				return { valid: true, message: 'JSON is valid.' };
			} catch {
				// Invalid — try jsonrepair
			}

			// Attempt repair
			try {
				const repaired = jsonrepair(content);
				JSON.parse(repaired); // verify repair produced valid JSON
				await sandbox.writeFiles([{ path: resolvedPath, content: repaired }]);
				return { valid: true, repaired: true, message: 'JSON was invalid but has been repaired.' };
			} catch (err) {
				return {
					valid: false,
					error: `JSON is invalid and could not be repaired: ${(err as Error).message}`
				};
			}
		}
	});
}
