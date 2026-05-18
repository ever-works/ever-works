import nodePath from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { syncTaxonomyFromFile } from '../utils/taxonomy-sync.js';
import type { WrappedSandbox } from '../types.js';

/**
 * H-23: resolve an LLM-supplied path relative to the agent's workspace cwd
 * and refuse anything that escapes it. `nodePath.posix.resolve(cwd, path)`
 * silently honours absolute paths in the model's output — e.g. a model
 * emitting `path: "/etc/passwd"` would write outside the sandbox. The wrapping
 * `ReadWriteFs({ root: workspacePath })` in `modification-worker.ts` catches
 * the read/write attempt, but the tool description itself encourages absolute
 * paths in earlier model traces; enforce the boundary at the tool layer too
 * so any future sandbox helper that doesn't enforce `root` still rejects
 * escape attempts.
 */
export function resolveSandboxPath(cwd: string, rawPath: string): string {
	if (typeof rawPath !== 'string' || rawPath.length === 0) {
		throw new Error('Invalid path: must be a non-empty string');
	}
	if (nodePath.posix.isAbsolute(rawPath) || nodePath.win32.isAbsolute(rawPath)) {
		throw new Error(
			`Invalid path "${rawPath}": absolute paths are not allowed. Use a path relative to the workspace (e.g. "data/items/foo.json").`
		);
	}
	const resolvedCwd = nodePath.posix.resolve(cwd);
	const resolved = nodePath.posix.resolve(resolvedCwd, rawPath);
	// Edge case: when cwd is `/`, `resolvedCwd + sep` becomes `//`, which
	// nothing starts with. Use the raw separator boundary instead.
	const cwdWithSep = resolvedCwd === '/' ? '/' : resolvedCwd + nodePath.posix.sep;
	if (resolved !== resolvedCwd && !resolved.startsWith(cwdWithSep)) {
		throw new Error(
			`Invalid path "${rawPath}": resolves outside the workspace (${resolved} is not under ${resolvedCwd}).`
		);
	}
	return resolved;
}

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
			let resolvedPath: string;
			try {
				resolvedPath = resolveSandboxPath(cwd, path);
			} catch (err) {
				return { success: false, error: err instanceof Error ? err.message : String(err) };
			}
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
			let resolvedPath: string;
			try {
				resolvedPath = resolveSandboxPath(cwd, path);
			} catch (err) {
				return { success: false, error: err instanceof Error ? err.message : String(err) };
			}
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
