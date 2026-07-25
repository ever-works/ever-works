import type { PrereqCheckResult } from '../shared/ipc-contract';

/** Minimal command abstraction so prerequisite checks are unit-testable. */
export interface CommandRunner {
	run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/** Node.js major version the platform requires (root package.json engines). */
export const MIN_NODE_MAJOR = 22;

/** Extract the first semver-looking token from tool output (`v22.11.0`, `Docker version 27.4.0, build ...`). */
export function parseVersion(raw: string): string | undefined {
	const match = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
	return match ? match[0] : undefined;
}

export function nodeVersionSatisfies(version: string | undefined, minMajor: number = MIN_NODE_MAJOR): boolean {
	if (!version) {
		return false;
	}
	const major = Number.parseInt(version.split('.')[0] ?? '', 10);
	return Number.isFinite(major) && major >= minMajor;
}

async function probe(
	runner: CommandRunner,
	command: string,
	args: string[]
): Promise<{ found: boolean; version?: string }> {
	try {
		const result = await runner.run(command, args);
		if (result.code !== 0) {
			return { found: false };
		}
		return { found: true, version: parseVersion(`${result.stdout} ${result.stderr}`) };
	} catch {
		return { found: false };
	}
}

/**
 * Check the wizard prerequisites: Node.js >= 22 and pnpm are required to run
 * the platform from source; Docker is optional and only gates the
 * docker-compose infra choice.
 */
export async function checkPrerequisites(runner: CommandRunner): Promise<PrereqCheckResult[]> {
	const [node, pnpm, docker] = await Promise.all([
		probe(runner, 'node', ['--version']),
		probe(runner, 'pnpm', ['--version']),
		probe(runner, 'docker', ['--version'])
	]);

	const nodeOk = node.found && nodeVersionSatisfies(node.version);
	return [
		{
			id: 'node',
			label: `Node.js >= ${MIN_NODE_MAJOR}`,
			required: true,
			found: node.found,
			version: node.version,
			ok: nodeOk,
			message: node.found
				? nodeOk
					? undefined
					: `Node.js ${node.version ?? '?'} found but >= ${MIN_NODE_MAJOR} is required`
				: 'Node.js was not found on PATH'
		},
		{
			id: 'pnpm',
			label: 'pnpm',
			required: true,
			found: pnpm.found,
			version: pnpm.version,
			ok: pnpm.found,
			message: pnpm.found ? undefined : 'pnpm was not found on PATH (npm install -g pnpm)'
		},
		{
			id: 'docker',
			label: 'Docker (optional)',
			required: false,
			found: docker.found,
			version: docker.version,
			ok: docker.found,
			message: docker.found ? undefined : 'Docker not found — docker-compose infra will be unavailable'
		}
	];
}

/** True when every required prerequisite passed. */
export function requiredPrereqsOk(results: PrereqCheckResult[] | undefined): boolean {
	if (!results || results.length === 0) {
		return false;
	}
	return results.filter((result) => result.required).every((result) => result.ok);
}
