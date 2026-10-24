import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../../capabilities';
import {
	GitIdentityError,
	readGitIdentity,
	setGitIdentity,
	validGitIdentityEmail,
	validGitIdentityValue
} from './git-identity';

/**
 * FL-15 P2 — the machine's global git identity (spec FR-12 … FR-15, U10):
 * unset is exit 1, not an error; every value is one argv element; control
 * characters are refused before anything runs; only `user.name` and
 * `user.email` are ever written.
 */

type Call = { command: string; args: string[] };

function fakeRunner(answers: Record<string, { code: number | null; stdout?: string; stderr?: string }>) {
	const calls: Call[] = [];
	const runner: CommandRunner = {
		run: async (command, args) => {
			calls.push({ command, args });
			const key = args.join(' ');
			const answer = answers[key] ?? { code: 0, stdout: '' };
			return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
		}
	};
	return { runner, calls };
}

describe('readGitIdentity', () => {
	it('reads name, email and the helper, with exit 1 meaning unset', async () => {
		const { runner } = fakeRunner({
			'config --global --get user.name': { code: 0, stdout: 'Nina Dev\n' },
			'config --global --get user.email': { code: 1 },
			'config --global --get credential.helper': { code: 0, stdout: 'osxkeychain\n' }
		});
		expect(await readGitIdentity(runner)).toEqual({
			name: { set: true, value: 'Nina Dev' },
			email: { set: false },
			helper: { present: true, value: 'osxkeychain' }
		});
	});

	it('says git is missing when it cannot run', async () => {
		const { runner } = fakeRunner({
			'config --global --get user.name': { code: null, stderr: 'spawn git ENOENT' }
		});
		expect((await readGitIdentity(runner)).gitMissing).toBe(true);
	});
});

describe('setGitIdentity', () => {
	it('writes exactly user.name and user.email, each value one argv element', async () => {
		const { runner, calls } = fakeRunner({});
		const result = await setGitIdentity(runner, { name: 'Nina; rm -rf ~', email: '12345+nina@users.noreply.github.com' });
		expect(result.fields).toEqual(['user.name', 'user.email']);
		expect(calls).toEqual([
			{ command: 'git', args: ['config', '--global', 'user.name', 'Nina; rm -rf ~'] },
			{ command: 'git', args: ['config', '--global', 'user.email', '12345+nina@users.noreply.github.com'] }
		]);
	});

	it('refuses control characters and bad emails before running anything', async () => {
		const { runner, calls } = fakeRunner({});
		await expect(setGitIdentity(runner, { name: 'Nina\nevil', email: 'a@b.c' })).rejects.toBeInstanceOf(
			GitIdentityError
		);
		await expect(setGitIdentity(runner, { name: 'Nina', email: 'not an email' })).rejects.toBeInstanceOf(
			GitIdentityError
		);
		expect(calls).toHaveLength(0);
	});

	it('reports the first stderr line when git config fails (U10)', async () => {
		const { runner } = fakeRunner({
			'config --global user.name Nina': { code: 255, stderr: 'error: could not lock config file\nmore' }
		});
		await expect(setGitIdentity(runner, { name: 'Nina', email: 'n@x.io' })).rejects.toThrow(
			'error: could not lock config file'
		);
	});
});

describe('value checks', () => {
	it('bounds and cleans values', () => {
		expect(validGitIdentityValue('  Nina  ')).toBe('Nina');
		expect(validGitIdentityValue('x'.repeat(201))).toBeNull();
		expect(validGitIdentityValue('-c core.pager=evil')).toBeNull();
		expect(validGitIdentityEmail('nina@example.com')).toBe('nina@example.com');
		expect(validGitIdentityEmail('<nina@example.com>')).toBeNull();
	});
});
