import { describe, expect, it } from 'vitest';
import type { CommandRunner } from './prereq-check';
import { checkPrerequisites, nodeVersionSatisfies, parseVersion, requiredPrereqsOk } from './prereq-check';

function runnerWith(results: Record<string, { code: number; stdout: string } | Error>): CommandRunner {
	return {
		run: async (command: string) => {
			const result = results[command];
			if (!result) {
				throw new Error(`unexpected command: ${command}`);
			}
			if (result instanceof Error) {
				throw result;
			}
			return { code: result.code, stdout: result.stdout, stderr: '' };
		}
	};
}

describe('parseVersion', () => {
	it('extracts semver from node and docker output', () => {
		expect(parseVersion('v22.11.0')).toBe('22.11.0');
		expect(parseVersion('Docker version 27.4.0, build deadbeef')).toBe('27.4.0');
		expect(parseVersion('no digits here')).toBeUndefined();
	});
});

describe('nodeVersionSatisfies', () => {
	it('accepts the minimum major and above, rejects older and missing', () => {
		expect(nodeVersionSatisfies('22.0.0')).toBe(true);
		expect(nodeVersionSatisfies('23.5.1')).toBe(true);
		expect(nodeVersionSatisfies('20.19.0')).toBe(false);
		expect(nodeVersionSatisfies(undefined)).toBe(false);
	});
});

describe('checkPrerequisites', () => {
	it('reports all prerequisites ok when every tool is present', async () => {
		const results = await checkPrerequisites(
			runnerWith({
				node: { code: 0, stdout: 'v22.11.0' },
				pnpm: { code: 0, stdout: '10.33.3' },
				docker: { code: 0, stdout: 'Docker version 27.4.0, build deadbeef' }
			})
		);
		expect(results).toHaveLength(3);
		expect(results.every((result) => result.ok)).toBe(true);
		expect(requiredPrereqsOk(results)).toBe(true);
	});

	it('fails the node prereq when the version is too old', async () => {
		const results = await checkPrerequisites(
			runnerWith({
				node: { code: 0, stdout: 'v20.9.0' },
				pnpm: { code: 0, stdout: '10.33.3' },
				docker: new Error('not found')
			})
		);
		const node = results.find((result) => result.id === 'node');
		expect(node?.found).toBe(true);
		expect(node?.ok).toBe(false);
		expect(node?.message).toContain('22');
		expect(requiredPrereqsOk(results)).toBe(false);
	});

	it('treats missing docker as optional — required prereqs still pass', async () => {
		const results = await checkPrerequisites(
			runnerWith({
				node: { code: 0, stdout: 'v22.11.0' },
				pnpm: { code: 0, stdout: '10.33.3' },
				docker: new Error('ENOENT')
			})
		);
		const docker = results.find((result) => result.id === 'docker');
		expect(docker?.required).toBe(false);
		expect(docker?.found).toBe(false);
		expect(docker?.ok).toBe(false);
		expect(requiredPrereqsOk(results)).toBe(true);
	});

	it('stops requiring the host toolchain when the install ships a bundled runtime', async () => {
		const results = await checkPrerequisites(
			runnerWith({
				node: new Error('ENOENT'),
				pnpm: new Error('ENOENT'),
				docker: new Error('ENOENT')
			}),
			{ requireHostToolchain: false }
		);
		const node = results.find((result) => result.id === 'node');
		const pnpm = results.find((result) => result.id === 'pnpm');
		expect(node?.required).toBe(false);
		expect(node?.found).toBe(false);
		expect(node?.ok).toBe(true);
		expect(node?.message).toContain('bundled platform runtime');
		expect(pnpm?.required).toBe(false);
		expect(pnpm?.ok).toBe(true);
		// A machine with no Node.js and no pnpm can still complete the wizard.
		expect(requiredPrereqsOk(results)).toBe(true);
	});

	it('treats a non-zero exit code as not found', async () => {
		const results = await checkPrerequisites(
			runnerWith({
				node: { code: 1, stdout: '' },
				pnpm: { code: 0, stdout: '10.33.3' },
				docker: { code: 0, stdout: 'Docker version 27.4.0' }
			})
		);
		const node = results.find((result) => result.id === 'node');
		expect(node?.found).toBe(false);
		expect(requiredPrereqsOk(results)).toBe(false);
	});
});
