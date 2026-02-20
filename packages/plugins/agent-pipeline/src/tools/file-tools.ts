import nodePath from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { syncTaxonomyFromFile } from '../utils/taxonomy-sync.js';
import type { WrappedSandbox } from '../types.js';

export interface CreateFileToolOptions {
	/** Called after a file is successfully created. Receives the resolved path and content. */
	onCreated?: (path: string, content: string) => Promise<void>;
}

export interface UpdateFileToolOptions {
	/** Called after a file is successfully updated. Receives the resolved path and content. */
	onUpdated?: (path: string, content: string) => Promise<void>;
}

/**
 * Create a `createFile` tool that writes a new file.
 * Returns an error if the file already exists, directing the agent to use `updateFile` instead.
 */
export function createCreateFileTool(sandbox: WrappedSandbox, cwd: string, options?: CreateFileToolOptions) {
	return tool({
		description: 'Create a new file. Fails if the file already exists — use updateFile to modify existing files.',
		inputSchema: z.object({
			path: z.string().describe('Path of the file to create (e.g., my-tool.json)'),
			content: z.string().describe('Content to write to the file')
		}),
		execute: async ({ path, content }) => {
			const resolvedPath = nodePath.posix.resolve(cwd, path);
			try {
				await sandbox.readFile(resolvedPath);
				return {
					success: false,
					error: `File "${path}" already exists. Use the updateFile tool to modify existing files.`
				};
			} catch {
				// File doesn't exist — proceed
			}

			await sandbox.writeFiles([{ path: resolvedPath, content }]);
			try {
				await syncTaxonomyFromFile(
					(p) => sandbox.readFile(p),
					(p, c) => sandbox.writeFiles([{ path: p, content: c }]),
					resolvedPath,
					content
				);
			} catch {
				/* best-effort */
			}

			if (options?.onCreated) {
				try {
					await options.onCreated(path, content);
				} catch {
					/* best-effort */
				}
			}

			return { success: true, path };
		}
	});
}

/**
 * Create an `updateFile` tool that overwrites an existing file.
 * Returns an error if the file does not exist, directing the agent to use `createFile` instead.
 */
export function createUpdateFileTool(sandbox: WrappedSandbox, cwd: string, options?: UpdateFileToolOptions) {
	return tool({
		description: 'Update an existing file. Fails if the file does not exist — use createFile to create new files.',
		inputSchema: z.object({
			path: z.string().describe('Path of the existing file to update'),
			content: z.string().describe('New content for the file')
		}),
		execute: async ({ path, content }) => {
			const resolvedPath = nodePath.posix.resolve(cwd, path);
			try {
				await sandbox.readFile(resolvedPath);
			} catch {
				return {
					success: false,
					error: `File "${path}" does not exist. Use the createFile tool to create new files.`
				};
			}
			await sandbox.writeFiles([{ path: resolvedPath, content }]);
			try {
				await syncTaxonomyFromFile(
					(p) => sandbox.readFile(p),
					(p, c) => sandbox.writeFiles([{ path: p, content: c }]),
					resolvedPath,
					content
				);
			} catch {
				/* best-effort */
			}
			if (options?.onUpdated) {
				try {
					await options.onUpdated(path, content);
				} catch {
					/* best-effort */
				}
			}
			return { success: true, path };
		}
	});
}
