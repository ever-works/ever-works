import { describe, expect, it } from 'vitest';
import { CliError, EXIT_USAGE, resolveEnrollToken, type CliDeps, type EnrollTokenFileIo } from './program';

/**
 * Virtual computers (FL-16, T-13, CONTRACTS R-35) — `enroll --token-file`: the
 * guest's one-time token travels by a private file, never on a command line,
 * and the file never outlives the attempt.
 */

const TOKEN = 'dG9rZW4tZm9yLWEtdmlydHVhbC1jb21wdXRlci0xMjM0';

function fakeFile(content: string | null, stat: { uid: number; mode: number } | null = { uid: 1000, mode: 0o100600 }) {
	const removed: string[] = [];
	const io: EnrollTokenFileIo = {
		stat: async () => stat,
		readFile: async () => content,
		remove: async (path) => {
			removed.push(path);
		},
		currentUid: () => 1000
	};
	return { io, removed };
}

const deps = (platform = 'linux') => ({ platform }) as unknown as CliDeps;

describe('resolveEnrollToken', () => {
	it('reads, trims and deletes the token file', async () => {
		const file = fakeFile(`  ${TOKEN}\n`);
		await expect(resolveEnrollToken(deps(), { tokenFile: '/run/ever-works/enroll-token' }, file.io)).resolves.toBe(TOKEN);
		expect(file.removed).toEqual(['/run/ever-works/enroll-token']);
	});

	it('keeps --token working exactly as before', async () => {
		const file = fakeFile(null);
		await expect(resolveEnrollToken(deps(), { token: TOKEN }, file.io)).resolves.toBe(TOKEN);
		expect(file.removed).toEqual([]);
	});

	it('is a usage error (exit 2) with both or neither', async () => {
		const file = fakeFile(TOKEN);
		for (const options of [{ token: TOKEN, tokenFile: '/t' }, {}]) {
			const error = await resolveEnrollToken(deps(), options, file.io).catch((thrown: unknown) => thrown);
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).exitCode).toBe(EXIT_USAGE);
		}
	});

	it('refuses a file other users may read, and still deletes it', async () => {
		const file = fakeFile(TOKEN, { uid: 1000, mode: 0o100644 });
		await expect(resolveEnrollToken(deps(), { tokenFile: '/t' }, file.io)).rejects.toThrow(/0600/);
		expect(file.removed).toEqual(['/t']);
	});

	it('refuses a file another user owns', async () => {
		const file = fakeFile(TOKEN, { uid: 0, mode: 0o100600 });
		await expect(resolveEnrollToken(deps(), { tokenFile: '/t' }, file.io)).rejects.toThrow(/another user/);
	});

	it('does not judge POSIX mode bits on Windows', async () => {
		const file = fakeFile(TOKEN, { uid: 0, mode: 0o100666 });
		await expect(resolveEnrollToken(deps('win32'), { tokenFile: 'C:\\t' }, file.io)).resolves.toBe(TOKEN);
	});

	it('refuses an empty or missing file', async () => {
		await expect(resolveEnrollToken(deps(), { tokenFile: '/t' }, fakeFile('  \n').io)).rejects.toThrow(/empty/);
		await expect(resolveEnrollToken(deps(), { tokenFile: '/t' }, fakeFile(TOKEN, null).io)).rejects.toThrow(
			/does not exist/
		);
	});
});
