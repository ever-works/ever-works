import type { CommandRunner } from '../../../capabilities';

/**
 * Tasks on computers (FL-15 P2, spec FR-12 … FR-15) — the machine's GLOBAL git
 * identity, read and set through `git config --global` and nothing else.
 *
 *  - **argv only.** Every value is ONE argv element of `git config --global
 *    <key> <value>`; nothing is ever parsed by a shell. The runner is the
 *    machine-facts one (`shell: false`, scrubbed environment) — the node runs
 *    as the person who enrolled it, so `--global` is that person's
 *    `~/.gitconfig` (`%USERPROFILE%\.gitconfig` on Windows).
 *  - **unset is not an error.** `git config --get` exits 1 for a key that is
 *    not set; that reads as `set: false`.
 *  - **name and email only.** The set path writes exactly `user.name` and
 *    `user.email`; it never writes a credential, a token or a credential
 *    helper (spec FR-15). Values with control characters or longer than 200
 *    characters are refused before anything runs.
 */

export const GIT_IDENTITY_VALUE_MAX_LENGTH = 200;

/** How long one `git config` may take. */
export const GIT_CONFIG_TIMEOUT_MS = 10_000;

/** One value as the machine has it. */
export interface GitConfigValue {
	set: boolean;
	value?: string;
}

/** What `git.identity` answers (the platform masks the values for non-owners). */
export interface GitIdentityFacts {
	name: GitConfigValue;
	email: GitConfigValue;
	helper: { present: boolean; value?: string };
	/** `git` itself was not found or did not run. */
	gitMissing?: boolean;
}

/** A refusal before anything ran, or a `git config` that failed. */
export class GitIdentityError extends Error {
	constructor(
		readonly kind: 'invalid' | 'failed',
		message: string
	) {
		super(message);
		this.name = 'GitIdentityError';
	}
}

function firstLine(text: string | null | undefined, fallback: string): string {
	const line = (text ?? '').split(/\r?\n/, 1)[0]?.trim() ?? '';
	return (line || fallback).slice(0, 300);
}

/** A value `git config` may be handed: 1–200 characters, no control characters, trimmed. */
export function validGitIdentityValue(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > GIT_IDENTITY_VALUE_MAX_LENGTH) return null;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
	// A leading dash would read as an option to some tools; git takes the value positionally, but refuse it anyway.
	if (trimmed.startsWith('-')) return null;
	return trimmed;
}

/** A plausible email: one `@`, something either side, no spaces or angle brackets. */
export function validGitIdentityEmail(value: unknown): string | null {
	const email = validGitIdentityValue(value);
	if (!email) return null;
	return /^[^\s@<>]+@[^\s@<>]+$/.test(email) ? email : null;
}

async function readKey(runner: CommandRunner, key: string): Promise<GitConfigValue | 'missing'> {
	const result = await runner.run('git', ['config', '--global', '--get', key], { timeoutMs: GIT_CONFIG_TIMEOUT_MS });
	if (result.code === 0) {
		const value = result.stdout.replace(/\r?\n$/, '').trim();
		return value ? { set: true, value: value.slice(0, GIT_IDENTITY_VALUE_MAX_LENGTH) } : { set: false };
	}
	// Exit 1: the key is not set. Anything else without output is git itself failing.
	if (result.code === 1) return { set: false };
	if (result.code === null || result.code === 127 || /not found|ENOENT|not recognized/i.test(result.stderr)) {
		return 'missing';
	}
	return { set: false };
}

/** Read the global identity: name, email and whether a credential helper is configured. */
export async function readGitIdentity(runner: CommandRunner): Promise<GitIdentityFacts> {
	const name = await readKey(runner, 'user.name');
	if (name === 'missing') {
		return { name: { set: false }, email: { set: false }, helper: { present: false }, gitMissing: true };
	}
	const email = await readKey(runner, 'user.email');
	const helper = await readKey(runner, 'credential.helper');
	return {
		name,
		email: email === 'missing' ? { set: false } : email,
		helper:
			helper !== 'missing' && helper.set
				? { present: true, ...(helper.value ? { value: helper.value } : {}) }
				: { present: false },
	};
}

/**
 * Set the global `user.name` and `user.email` — exactly those two keys, each
 * as one argv element. Refuses invalid values before running anything; on a
 * failing `git config` reports its first stderr line and stops (the name may
 * already be written; nothing else on the machine is touched — spec U10).
 */
export async function setGitIdentity(
	runner: CommandRunner,
	input: { name: unknown; email: unknown },
): Promise<{ fields: Array<'user.name' | 'user.email'> }> {
	const name = validGitIdentityValue(input.name);
	if (!name) throw new GitIdentityError('invalid', 'the name must be 1–200 characters with no control characters');
	const email = validGitIdentityEmail(input.email);
	if (!email) throw new GitIdentityError('invalid', 'the email must be one address of at most 200 characters');
	const fields: Array<'user.name' | 'user.email'> = [];
	for (const [key, value] of [
		['user.name', name],
		['user.email', email]
	] as const) {
		const result = await runner.run('git', ['config', '--global', key, value], { timeoutMs: GIT_CONFIG_TIMEOUT_MS });
		if (result.code !== 0) {
			throw new GitIdentityError('failed', firstLine(result.stderr || result.stdout, `git config exited ${result.code ?? 1}`));
		}
		fields.push(key);
	}
	return { fields };
}
