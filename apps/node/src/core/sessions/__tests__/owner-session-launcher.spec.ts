import { describe, expect, it } from 'vitest';
import type { HookOverlayPort } from '../hook-overlay.port';
import { NO_HOOK_OVERLAY } from '../hook-overlay.port';
import {
	composeOwnerSession,
	expandHome,
	findOnPath,
	resolveLoginShell,
	type OwnerSessionLaunchInput
} from '../owner-session-launcher';

/**
 * What an owner session runs (spec FR-12 … FR-15, FR-17, U1, U17, U18;
 * ACC-FL04-08 … 10).
 */

const LINUX_HOME = '/home/dana';

function input(overrides: Partial<OwnerSessionLaunchInput> = {}): OwnerSessionLaunchInput {
	return {
		sessionId: 's1',
		provider: 'shell',
		cwd: '~/code/api',
		consents: { work: false, attend: false, manage: true, usageScan: false },
		nodeName: 'build-01',
		platform: 'linux',
		env: { SHELL: '/usr/bin/fish', PATH: '/usr/bin', HOME: LINUX_HOME, EDITOR: 'vim' },
		homedir: LINUX_HOME,
		modelCli: { 'claude-code': '/usr/local/bin/claude', codex: '/usr/local/bin/codex' },
		overlay: NO_HOOK_OVERLAY,
		// Every path exists and is its own real path, unless a test says otherwise.
		realpath: async (target) => target,
		fileExists: () => false,
		...overrides
	};
}

describe('composeOwnerSession', () => {
	it('runs the login shell as the person, with their own environment and nothing removed (FR-12)', async () => {
		const result = await composeOwnerSession(input());
		expect(result).toEqual({
			ok: true,
			launch: {
				command: ['/usr/bin/fish', '-l'],
				cwd: '/home/dana/code/api',
				env: { SHELL: '/usr/bin/fish', PATH: '/usr/bin', HOME: LINUX_HOME, EDITOR: 'vim' }
			}
		});
	});

	it('refuses without --manage, naming the command (FR-13, U1)', async () => {
		expect(
			await composeOwnerSession(
				input({ consents: { work: true, attend: true, manage: false, usageScan: false } })
			)
		).toEqual({ ok: false, error: { code: 'consent_missing', hint: 'start the node with --manage on build-01' } });
	});

	it("runs Claude Code interactively in the person's own configuration, first message as its prompt (FR-17)", async () => {
		const result = await composeOwnerSession(
			input({ provider: 'claude-code', firstMessage: 'run the migration tests and fix what fails' })
		);
		expect(result).toMatchObject({
			ok: true,
			launch: { command: ['/usr/local/bin/claude', 'run the migration tests and fix what fails'] }
		});
		// No headless flags, no relocated home, no MCP strictness: those are Agent-session isolation.
		const command = result.ok ? result.launch.command : [];
		for (const flag of ['-p', '--print', '--output-format', '--strict-mcp-config', '--mcp-config']) {
			expect(command).not.toContain(flag);
		}
		expect(result.ok && result.launch.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
	});

	it('adds exactly what the hook overlay returns (the FL-05 seam)', async () => {
		const calls: unknown[] = [];
		const overlay: HookOverlayPort = {
			hookOverlayFor: (kind, provider, sessionId) => {
				calls.push([kind, provider, sessionId]);
				return { args: ['--settings', '/tmp/overlay.json'], env: { EVER_WORKS_HOOKS: '1' } };
			}
		};
		const result = await composeOwnerSession(input({ provider: 'codex', firstMessage: 'lint', overlay }));
		expect(calls).toEqual([['owner', 'codex', 's1']]);
		expect(result).toMatchObject({
			ok: true,
			launch: {
				command: ['/usr/local/bin/codex', '--settings', '/tmp/overlay.json', 'lint'],
				env: { EVER_WORKS_HOOKS: '1', EDITOR: 'vim' }
			}
		});
	});

	it('refuses a CLI this machine does not have (FR-14)', async () => {
		expect(await composeOwnerSession(input({ provider: 'codex', modelCli: {} }))).toEqual({
			ok: false,
			error: { code: 'unsupported_on_node', hint: 'Codex is not installed on build-01' }
		});
	});

	it('refuses a folder that does not exist, naming the path (U17)', async () => {
		const result = await composeOwnerSession(
			input({
				cwd: '~/code/apu',
				realpath: async (target) => {
					if (target.includes('apu')) throw new Error('ENOENT');
					return target;
				}
			})
		);
		expect(result).toEqual({
			ok: false,
			error: { code: 'invalid', hint: '~/code/apu does not exist on build-01' }
		});
	});

	it('refuses a folder outside home and the allowed roots, including through a symlink', async () => {
		expect(await composeOwnerSession(input({ cwd: '/etc' }))).toMatchObject({
			ok: false,
			error: { code: 'invalid' }
		});
		const viaLink = await composeOwnerSession(
			input({
				cwd: '~/escape',
				realpath: async (target) => (target.endsWith('escape') ? '/srv/secrets' : target)
			})
		);
		expect(viaLink).toMatchObject({ ok: false, error: { code: 'invalid' } });
		expect(await composeOwnerSession(input({ cwd: 'relative/path' }))).toMatchObject({
			ok: false,
			error: { code: 'invalid', hint: 'relative/path is not a full path on build-01' }
		});
		expect(await composeOwnerSession(input({ cwd: '/srv/code', extraRoots: ['/srv'] }))).toMatchObject({
			ok: true
		});
	});

	it('types the first message instead of passing it through cmd.exe for a Windows .cmd CLI', async () => {
		const result = await composeOwnerSession(
			input({
				provider: 'claude-code',
				platform: 'win32',
				homedir: 'C:\\Users\\dana',
				cwd: 'C:\\Users\\dana\\code',
				env: { PATH: 'C:\\Windows' },
				modelCli: { 'claude-code': 'C:\\Users\\dana\\AppData\\Roaming\\npm\\claude.cmd' },
				firstMessage: 'fix it & push | rm %USERPROFILE%'
			})
		);
		expect(result).toEqual({
			ok: true,
			launch: {
				command: ['C:\\Users\\dana\\AppData\\Roaming\\npm\\claude.cmd'],
				cwd: 'C:\\Users\\dana\\code',
				env: { PATH: 'C:\\Windows' },
				typeAfterStart: 'fix it & push | rm %USERPROFILE%'
			}
		});
	});

	it('compares Windows folders without case', async () => {
		const result = await composeOwnerSession(
			input({ platform: 'win32', homedir: 'C:\\Users\\Dana', cwd: 'c:\\users\\dana\\Code', env: {} })
		);
		expect(result).toMatchObject({ ok: true, launch: { cwd: 'c:\\users\\dana\\Code' } });
	});
});

describe('the login shell (U18, OWNER-QUESTIONS B3)', () => {
	it('uses $SHELL -l, else the OS default', () => {
		expect(resolveLoginShell('linux', { SHELL: '/bin/bash' })).toEqual(['/bin/bash', '-l']);
		expect(resolveLoginShell('linux', {})).toEqual(['/bin/sh', '-l']);
		expect(resolveLoginShell('darwin', { SHELL: 'zsh' })).toEqual(['/bin/zsh', '-l']);
	});

	it('prefers PowerShell 7 on Windows, else Windows PowerShell', () => {
		const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
		expect(
			resolveLoginShell(
				'win32',
				{ PATH: 'C:\\Program Files\\PowerShell\\7;C:\\Windows' },
				(target) => target === pwsh
			)
		).toEqual([pwsh, '-NoLogo']);
		expect(resolveLoginShell('win32', { PATH: 'C:\\Windows' }, () => false)).toEqual(['powershell.exe', '-NoLogo']);
	});

	it('finds commands on PATH with the OS suffixes', () => {
		expect(findOnPath('git', { PATH: '/a:/b' }, 'linux', (target) => target === '/b/git')).toBe('/b/git');
		expect(findOnPath('git', { Path: 'C:\\a;C:\\b' }, 'win32', (target) => target === 'C:\\b\\git.cmd')).toBe(
			'C:\\b\\git.cmd'
		);
		expect(findOnPath('git', {}, 'linux', () => true)).toBeNull();
	});

	it('expands ~ only at the start', () => {
		expect(expandHome('~', '/home/dana', 'linux')).toBe('/home/dana');
		expect(expandHome('~/x', '/home/dana', 'linux')).toBe('/home/dana/x');
		expect(expandHome('/a/~/x', '/home/dana', 'linux')).toBe('/a/~/x');
		expect(expandHome('~\\x', 'C:\\Users\\dana', 'win32')).toBe('C:\\Users\\dana\\x');
	});
});
