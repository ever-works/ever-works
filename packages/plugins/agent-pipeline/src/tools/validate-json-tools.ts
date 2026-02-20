import nodePath from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { jsonrepair } from '@ever-works/plugin';
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
			const resolvedPath = nodePath.posix.resolve(cwd, path);

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
