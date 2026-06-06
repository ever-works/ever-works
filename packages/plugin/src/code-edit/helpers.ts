import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { CodeEditFileChange } from '../contracts/capabilities/code-edit-plugin.interface.js';

const execAsync = promisify(exec);

/**
 * Compute which files changed in a workspace by parsing `git status --porcelain`.
 * Falls back to an empty list if git is unavailable or the directory is not a repo.
 *
 * Plugins that produce code edits all benefit from this — every CLI tool we use
 * runs against a checked-out git working tree and we surface the diff to the
 * user via the platform's PR flow.
 *
 * NOTE: This module imports Node's `child_process` and MUST NOT be re-exported
 * from `@ever-works/plugin`'s root barrel — that would pull `child_process`
 * into the apps/web Webpack bundle. Import it via the dedicated subpath
 * `@ever-works/plugin/code-edit`.
 */
export async function computeWorkspaceFileChanges(workspaceDir: string): Promise<CodeEditFileChange[]> {
	try {
		const { stdout } = await execAsync('git status --porcelain=v1 -uall', {
			cwd: workspaceDir,
			maxBuffer: 10 * 1024 * 1024
		});
		return parsePorcelain(stdout, workspaceDir);
	} catch {
		return [];
	}
}

/**
 * Confirm a porcelain-reported path stays inside the workspace.
 *
 * Git porcelain paths are relative to the repo root (`workspaceDir`), but the
 * working tree may be an attacker-controlled cloned repo. A crafted rename
 * record (`old -> new`) whose `new` component contains `../` sequences — or an
 * absolute path — would otherwise yield a `CodeEditFileChange.path` that
 * escapes the workspace and could mislead downstream consumers (PR diff
 * rendering, file display) into touching files outside it. Mirrors the
 * confinement guard used in `cli-pipeline/workspace.ts`.
 */
function isInsideWorkspace(workspaceDir: string, relPath: string): boolean {
	if (!relPath || path.isAbsolute(relPath)) return false;
	const workspaceResolved = path.resolve(workspaceDir);
	const resolved = path.resolve(workspaceResolved, relPath);
	const relative = path.relative(workspaceResolved, resolved);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parsePorcelain(output: string, workspaceDir: string): CodeEditFileChange[] {
	const changes: CodeEditFileChange[] = [];
	for (const line of output.split('\n')) {
		if (!line.trim()) continue;
		const code = line.slice(0, 2);
		const rest = line.slice(3);
		const filePath = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
		// Security (path-traversal): skip any path that escapes the workspace
		// (e.g. a hostile rename record `app.ts -> ../../etc/passwd` in a cloned
		// attacker repo). Legitimate in-tree changes resolve inside `workspaceDir`
		// and are unaffected.
		if (!isInsideWorkspace(workspaceDir, filePath)) continue;
		changes.push({ path: filePath, status: mapStatus(code) });
	}
	return changes;
}

function mapStatus(code: string): CodeEditFileChange['status'] {
	const c = code.trim();
	if (c.startsWith('D')) return 'deleted';
	if (c.startsWith('A') || c === '??') return 'added';
	return 'modified';
}
