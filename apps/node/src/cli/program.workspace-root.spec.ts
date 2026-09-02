import { describe, expect, it } from 'vitest';
import { CliError, parseWorkspaceRoot } from './program';

/**
 * `start --workspace-root <dir>` is the operator's choice of where the node
 * keeps its bare-repository cache and per-Task worktrees. The rule is
 * "absolute, and not a filesystem root", judged by the HOST platform — so
 * both shapes are pinned here, independent of the machine running the tests.
 */
describe('parseWorkspaceRoot', () => {
	it('is undefined when the flag was not given', () => {
		expect(parseWorkspaceRoot(undefined, 'linux')).toBeUndefined();
		expect(parseWorkspaceRoot(undefined, 'win32')).toBeUndefined();
	});

	it('accepts an absolute POSIX directory and normalizes it', () => {
		expect(parseWorkspaceRoot('/srv/fleet-workspaces', 'linux')).toBe('/srv/fleet-workspaces');
		expect(parseWorkspaceRoot('/srv/fleet/../fleet-workspaces/', 'darwin')).toBe('/srv/fleet-workspaces');
		expect(parseWorkspaceRoot('  /srv/fleet-workspaces  ', 'linux')).toBe('/srv/fleet-workspaces');
	});

	it('accepts an absolute Windows directory (drive or UNC) and normalizes it', () => {
		expect(parseWorkspaceRoot('C:\\fleet\\workspaces', 'win32')).toBe('C:\\fleet\\workspaces');
		expect(parseWorkspaceRoot('D:/fleet/workspaces/', 'win32')).toBe('D:\\fleet\\workspaces');
		expect(parseWorkspaceRoot('\\\\build-nas\\fleet\\workspaces', 'win32')).toBe(
			'\\\\build-nas\\fleet\\workspaces'
		);
	});

	it('refuses a relative path as a usage error', () => {
		for (const [raw, platform] of [
			['fleet-workspaces', 'linux'],
			['./fleet-workspaces', 'linux'],
			['../fleet', 'darwin'],
			['fleet\\workspaces', 'win32'],
			['C:fleet', 'win32'], // drive-relative, not absolute
			['C:\\fleet', 'linux'] // a Windows path is NOT absolute on POSIX
		] as const) {
			expect(() => parseWorkspaceRoot(raw, platform), `${raw} on ${platform}`).toThrow(CliError);
			expect(() => parseWorkspaceRoot(raw, platform)).toThrow(/--workspace-root must be an absolute directory/);
		}
	});

	it('refuses an empty or blank value', () => {
		expect(() => parseWorkspaceRoot('', 'linux')).toThrow(/--workspace-root must not be empty/);
		expect(() => parseWorkspaceRoot('   ', 'win32')).toThrow(/--workspace-root must not be empty/);
	});

	it('refuses a filesystem root', () => {
		expect(() => parseWorkspaceRoot('/', 'linux')).toThrow(/cannot be a filesystem root/);
		expect(() => parseWorkspaceRoot('C:\\', 'win32')).toThrow(/cannot be a filesystem root/);
		expect(() => parseWorkspaceRoot('C:/', 'win32')).toThrow(/cannot be a filesystem root/);
	});

	it('reports usage errors with the generic failure exit code', () => {
		try {
			parseWorkspaceRoot('relative', 'linux');
			expect.unreachable('expected a CliError');
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).exitCode).toBe(1);
		}
	});
});
