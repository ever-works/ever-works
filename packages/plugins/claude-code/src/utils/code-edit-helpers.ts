import { exec } from 'child_process';
import { promisify } from 'util';
import type { CodeEditFileChange, CodeEditRequest } from '@ever-works/plugin';

const execAsync = promisify(exec);

const CODE_EDIT_SYSTEM_PROMPT = `You are Claude Code running inside an Ever Works directory site repository.

Your job: apply the user's requested change directly to the codebase. You have full
file-edit permissions. Make the smallest set of focused changes that satisfy the request.

Guidelines:
- Respect the existing framework, style, and component conventions in the repo.
- Read the repository's AGENTS.md / CLAUDE.md / SKILLS.md before making non-trivial
  changes — those files describe the template's architecture.
- Do not introduce new dependencies unless strictly required. Prefer existing utilities.
- Keep changes scoped: do not refactor unrelated code, do not run formatters across
  files you did not touch, do not modify CI / build config unless asked.
- Do not delete or move data files under .content/ — that directory is managed by
  the platform's data generator.
- Do not commit. The platform commits and opens a pull request after you finish.
- When you are done, output a short plain-text summary of what you changed.`;

export function buildCodeEditSystemPrompt(request: CodeEditRequest): string {
	const lines = [CODE_EDIT_SYSTEM_PROMPT];

	if (request.allowedPaths && request.allowedPaths.length > 0) {
		lines.push(
			'',
			'Restrict edits to the following paths only:',
			...request.allowedPaths.map((p) => `  - ${p}`)
		);
	}

	return lines.join('\n');
}

/**
 * Compute which files changed in a workspace by parsing `git status --porcelain`.
 * Falls back to an empty list if git is unavailable or the directory is not a repo.
 */
export async function readGitStatus(workspaceDir: string): Promise<CodeEditFileChange[]> {
	try {
		const { stdout } = await execAsync('git status --porcelain=v1 -uall', {
			cwd: workspaceDir,
			maxBuffer: 10 * 1024 * 1024
		});
		return parsePorcelain(stdout);
	} catch {
		return [];
	}
}

function parsePorcelain(output: string): CodeEditFileChange[] {
	const changes: CodeEditFileChange[] = [];
	for (const line of output.split('\n')) {
		if (!line.trim()) continue;
		// Porcelain v1: XY <path>  (XY is 2-char status; rename uses "R  old -> new")
		const code = line.slice(0, 2);
		const rest = line.slice(3);
		const path = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
		changes.push({ path, status: mapStatus(code) });
	}
	return changes;
}

function mapStatus(code: string): CodeEditFileChange['status'] {
	const c = code.trim();
	if (c.startsWith('D')) return 'deleted';
	if (c.startsWith('A') || c === '??') return 'added';
	return 'modified';
}
