import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { LocalWorkspacePlugin } from '../local-workspace.plugin.js';
import type { WorkspaceHandle } from '@ever-works/plugin';

/**
 * Scoped push credentials and commit attribution (self-build slice AM).
 *
 * Two halves, because the two questions need different instruments:
 *
 *  1. **Real git, hermetic loopback origin** — what a commit actually
 *     carries (author vs committer), and what the repository's config
 *     holds afterwards. Only real git can answer those.
 *  2. **The `execFile` seam** — HOW the credential reaches git. The
 *     assertion that matters most in this slice is a negative one (the
 *     token appears in no argv element and no config file), and the only
 *     way to prove it is to look at the exact invocation.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

let root: string;
let originUrl: string;
let baseDir: string;
let seedDir: string;
let plugin: LocalWorkspacePlugin;

const settings = () => ({ baseDir, fetchDepth: 1 });

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'ew-lw-push-'));
	const originDir = join(root, 'origin.git');
	seedDir = join(root, 'seed');
	baseDir = join(root, 'workspaces');
	mkdirSync(originDir, { recursive: true });
	mkdirSync(seedDir, { recursive: true });
	git(originDir, 'init', '--bare', '--initial-branch', 'main');
	originUrl = pathToFileURL(originDir).toString();
	git(seedDir, 'init', '--initial-branch', 'main');
	writeFileSync(join(seedDir, 'README.md'), 'hello\n');
	git(seedDir, 'add', '-A');
	git(seedDir, '-c', 'user.name=Seed', '-c', 'user.email=seed@test.local', 'commit', '-m', 'seed');
	git(seedDir, 'push', originUrl, 'HEAD:refs/heads/main');
	plugin = new LocalWorkspacePlugin();
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function provision(bindingKey: string, branch: string): Promise<WorkspaceHandle> {
	return plugin.provision({
		repoUrl: originUrl,
		baseRef: 'main',
		branch,
		bindingKey,
		settings: settings()
	});
}

describe('commit attribution (real git)', () => {
	it('records the AGENT as author and the NODE as committer', async () => {
		const handle = await provision('push-identity', 'task/identity-aaaa1111');
		writeFileSync(join(handle.path, 'work.txt'), 'work\n');

		await plugin.finalize(handle, {
			commitMessage: 'feat: attributed run',
			push: false,
			identity: {
				authorName: 'Refactor Bot',
				authorEmail: 'refactor-bot@agents.ever.works',
				committerName: 'Ever Works node studio-win',
				committerEmail: 'node-11111111-1111-4111-8111-111111111111@nodes.ever.works'
			}
		});

		// The whole point: `git log` can now answer WHICH agent and WHICH
		// machine. Before this slice both were `Ever Works Agent
		// <agent@ever.works>` on every node in the fleet.
		expect(git(handle.path, 'log', '-1', '--format=%an|%ae')).toBe('Refactor Bot|refactor-bot@agents.ever.works');
		expect(git(handle.path, 'log', '-1', '--format=%cn|%ce')).toBe(
			'Ever Works node studio-win|node-11111111-1111-4111-8111-111111111111@nodes.ever.works'
		);
	});

	it('keeps the pre-slice literals when no identity is supplied', async () => {
		// The cloud runner passes none, and its commits must not change.
		const handle = await provision('push-identity-default', 'task/identity-bbbb2222');
		writeFileSync(join(handle.path, 'work.txt'), 'work\n');

		await plugin.finalize(handle, { commitMessage: 'feat: default run', push: false });

		expect(git(handle.path, 'log', '-1', '--format=%an|%ae')).toBe('Ever Works Agent|agent@ever.works');
		expect(git(handle.path, 'log', '-1', '--format=%cn|%ce')).toBe('Ever Works Agent|agent@ever.works');
	});
});

describe('scoped push credential (real git)', () => {
	it('pushes with the credential and leaves NOTHING in the repository config', async () => {
		const handle = await provision('push-scoped', 'task/scoped-cccc3333');
		writeFileSync(join(handle.path, 'work.txt'), 'scoped\n');

		const result = await plugin.finalize(handle, {
			commitMessage: 'feat: scoped push',
			push: true,
			pushCredential: {
				username: 'x-access-token',
				token: 'ghs_scoped_push_token_value',
				remoteUrl: originUrl
			}
		});

		expect(result.pushed).toBe(true);
		// The credential lived in the child's environment and nowhere else.
		// `--local` inside a linked worktree reads the SHARED pool config,
		// so this also proves nothing landed where a sibling Task's
		// worktree could read it.
		const config = git(handle.path, 'config', '--local', '--list');
		expect(config).not.toContain('ghs_scoped_push_token_value');
		expect(config.toLowerCase()).not.toContain('extraheader');
		expect(config.toLowerCase()).not.toContain('credential.');
	});

	it('leaves the token in NO file anywhere under the workspace pool', async () => {
		// The strongest form of "prove it is gone before anything can commit
		// it": the credential is never written down at all, so `git add -A`
		// (which ran moments earlier, in this very finalize) had nothing to
		// stage and a crash has nothing to leave behind. Slice Y had to
		// DELETE its `.env` files before the first Git command; there is
		// nothing here to delete.
		const handle = await provision('push-nofiles', 'task/nofiles-ffff6666');
		writeFileSync(join(handle.path, 'work.txt'), 'no files\n');
		const token = 'ghs_unique_sentinel_for_the_file_scan';

		await plugin.finalize(handle, {
			commitMessage: 'feat: no files',
			push: true,
			pushCredential: { username: 'x-access-token', token, remoteUrl: originUrl }
		});

		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				let stats;
				try {
					stats = statSync(full);
				} catch {
					continue;
				}
				if (stats.isDirectory()) {
					walk(full);
					continue;
				}
				if (stats.size > 4 * 1024 * 1024) continue;
				try {
					if (readFileSync(full, 'utf8').includes(token)) offenders.push(full);
				} catch {
					// Binary or unreadable: a token is utf8 text, so a file
					// that cannot be read as utf8 cannot be holding one.
				}
			}
		};
		walk(baseDir);

		expect(offenders).toEqual([]);
		// And the checkout itself is clean, so nothing new appeared for a
		// later `git add -A` to pick up either.
		expect(git(handle.path, 'status', '--porcelain')).toBe('');
	});

	it('REFUSES to push when origin is not the remote the credential was issued for', async () => {
		const handle = await provision('push-mismatch', 'task/mismatch-dddd4444');
		writeFileSync(join(handle.path, 'work.txt'), 'mismatch\n');
		const before = git(handle.path, 'rev-parse', 'HEAD');

		await expect(
			plugin.finalize(handle, {
				commitMessage: 'feat: wrong remote',
				push: true,
				pushCredential: {
					username: 'x-access-token',
					token: 'ghs_scoped_push_token_value',
					remoteUrl: 'https://github.com/someone-else/private-repo.git'
				}
			})
		).rejects.toThrow(/does not cover this checkout/);

		// The commit still exists locally (nothing is rolled back), but the
		// branch was never published — a write credential must not be
		// offered to a remote the platform did not scope it to.
		expect(git(handle.path, 'rev-parse', 'HEAD')).not.toBe(before);
		expect(() => git(seedDir, 'ls-remote', originUrl, 'task/mismatch-dddd4444')).not.toThrow();
		expect(git(seedDir, 'ls-remote', originUrl, 'task/mismatch-dddd4444')).toBe('');
	});

	it('REFUSES to publish when a credential is already persisted in the repository config', async () => {
		// Fail closed: a helper sitting in the pool config could answer the
		// push instead of the scoped credential, which is the ambient
		// fallback this slice exists to remove.
		const handle = await provision('push-persisted', 'task/persisted-eeee5555');
		writeFileSync(join(handle.path, 'work.txt'), 'persisted\n');
		git(handle.path, 'config', '--local', 'credential.helper', 'store');

		try {
			await expect(
				plugin.finalize(handle, {
					commitMessage: 'feat: persisted helper',
					push: true,
					pushCredential: {
						username: 'x-access-token',
						token: 'ghs_scoped_push_token_value',
						remoteUrl: originUrl
					}
				})
				// The probe's message widened when the slice AM review added the
				// `url.*.insteadOf` / `pushInsteadOf` family to it (see the
				// rewrite cases below), so the assertion names the family this
				// case actually seeds rather than the whole sentence.
			).rejects.toThrow(/credential.*settings \(credential\.helper\)/);
			expect(git(seedDir, 'ls-remote', originUrl, 'task/persisted-eeee5555')).toBe('');
		} finally {
			git(handle.path, 'config', '--local', '--unset', 'credential.helper');
		}
	});

	// REGRESSION — a URL REWRITE aims the credential at another host
	// (slice AM review, F1/F4, and the `pushInsteadOf` variant found while
	// fixing them).
	//
	// `url.<x>.insteadOf` is visible to `git remote get-url origin`, so the
	// node's host check sees the rewritten URL and refuses. `pushInsteadOf`
	// is NOT: measured against git 2.53, with `url.<B>.pushInsteadOf = <A>`,
	// `git remote get-url origin` still reports A while `git push A` writes
	// to B — and this plugin pushes an EXPLICIT url, which Git rewrites just
	// the same. So the publish could be aimed at a host nothing upstream ever
	// saw. The pool config is exactly the scope a model with acceptEdits over
	// the checkout can reach through the worktree's `.git` pointer, which is
	// why the probe is `--local`.
	it.each([['insteadOf'], ['pushInsteadOf']])(
		'REFUSES to publish when the pool config carries a %s',
		async (variable) => {
			const branch = `task/rewrite-${variable.toLowerCase()}-9999`;
			const handle = await provision(`push-rewrite-${variable}`, branch);
			writeFileSync(join(handle.path, 'work.txt'), 'rewrite\n');
			git(handle.path, 'config', '--local', `url.https://evil.tld/.${variable}`, 'https://github.com/');

			try {
				await expect(
					plugin.finalize(handle, {
						commitMessage: 'feat: rewritten remote',
						push: true,
						pushCredential: {
							username: 'x-access-token',
							token: 'ghs_scoped_push_token_value',
							remoteUrl: originUrl
						}
					})
				).rejects.toThrow(/remote-rewrite settings/);
				// Nothing was published under the rewrite.
				expect(git(seedDir, 'ls-remote', originUrl, branch)).toBe('');
			} finally {
				git(handle.path, 'config', '--local', '--unset', `url.https://evil.tld/.${variable}`);
			}
		}
	);

	// REGRESSION — a `pre-push` hook in the POOL reads the credential out of
	// the push's own environment (slice AM review, F2).
	//
	// The hook lives in the common dir, so it is untracked, outside the
	// checkout, invisible to `assertNoPersistedCredential`, and survives
	// worktree teardown to fire on every later Task of this repository on
	// this machine.
	it('runs no pool hook on a credentialed push, so nothing can read the environment', async () => {
		const handle = await provision('push-hook', 'task/hook-7777aaaa');
		writeFileSync(join(handle.path, 'work.txt'), 'hooked\n');

		// `<worktree>/.git` is a file pointing at `<pool>/worktrees/<name>`;
		// the hooks dir is two levels up from there, in the common dir.
		const gitDir = git(handle.path, 'rev-parse', '--git-common-dir');
		const hooksDir = join(gitDir, 'hooks');
		const receipt = join(root, `hook-receipt-${Date.now()}.txt`);
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(
			join(hooksDir, 'pre-push'),
			// Writes whatever credential material the environment hands it.
			`#!/bin/sh\nprintf '%s' "fired:$GIT_CONFIG_VALUE_3" > '${receipt.replace(/\\/g, '/')}'\nexit 0\n`,
			{ mode: 0o755 }
		);

		const result = await plugin.finalize(handle, {
			commitMessage: 'feat: hooked push',
			push: true,
			pushCredential: {
				username: 'x-access-token',
				token: 'ghs_hook_harvest_sentinel_token',
				remoteUrl: originUrl
			}
		});

		expect(result.pushed).toBe(true);
		// The hook never ran, so it never saw the header. If it had, the
		// receipt would hold the base64 basic-auth form of a live token.
		let harvested: string | null = null;
		try {
			harvested = readFileSync(receipt, 'utf8');
		} catch {
			harvested = null;
		}
		expect(harvested).toBeNull();
	});
});

describe('how the credential reaches git (execFile seam)', () => {
	type Invocation = { args: string[]; env: NodeJS.ProcessEnv };

	const TOKEN = 'ghs_0123456789abcdefghijklmnopqrstuvwxyz';
	const REMOTE = 'https://github.com/ever-works/ever-works.git';

	function fakeGit(invocations: Invocation[], pushStderr?: string) {
		return ((
			_command: string,
			args: string[],
			options: { env?: NodeJS.ProcessEnv },
			callback: (error: Error | null, stdout: string, stderr: string) => void
		) => {
			invocations.push({ args: [...args], env: { ...(options.env ?? {}) } });
			const joined = args.join(' ');
			let stdout = '';
			let stderr = '';
			let error: Error | null = null;
			if (joined.startsWith('status')) stdout = ' M work.txt\n';
			else if (joined.startsWith('rev-parse')) stdout = 'a'.repeat(40);
			else if (joined.startsWith('remote get-url')) stdout = `${REMOTE}\n`;
			else if (joined.startsWith('diff')) stdout = 'work.txt\n';
			else if (joined.includes('--get-regexp')) {
				// git exits 1 when nothing matches, which is the healthy answer.
				error = Object.assign(new Error('no match'), { code: 1 });
			} else if (joined.startsWith('push') && pushStderr) {
				stderr = pushStderr;
				error = Object.assign(new Error('push failed'), { code: 128 });
			}
			setImmediate(() => callback(error, stdout, stderr));
			return { pid: 1 } as never;
		}) as never;
	}

	const handle: WorkspaceHandle = {
		path: '/tmp/does-not-matter',
		baseSha: 'b'.repeat(40),
		reused: false,
		branch: 'task/seam-ffff6666',
		bindingKey: 'seam'
	};

	const credential = { username: 'x-access-token', token: TOKEN, remoteUrl: REMOTE };

	it('carries the credential in the ENVIRONMENT and never in argv', async () => {
		const invocations: Invocation[] = [];
		const seamed = new LocalWorkspacePlugin({ execFile: fakeGit(invocations) });

		await seamed.finalize(handle, { commitMessage: 'feat: seam', push: true, pushCredential: credential });

		const push = invocations.find((entry) => entry.args[0] === 'push');
		expect(push).toBeDefined();

		// NOT in argv. This is the hazard the cloud path's URL-userinfo form
		// has: any local account can read a process listing.
		for (const entry of invocations) {
			// `\u0000` as the escape, never a raw NUL byte in the source: a
			// control character in a file is invisible in review and in a
			// diff, which is the same reason `sanitizeFleetPushIdentityText`
			// is written as a code-point walk rather than a regex.
			expect(entry.args.join('\u0000')).not.toContain(TOKEN);
			// And the remote is still the token-free URL.
			expect(entry.args).not.toContain(`https://x-access-token:${TOKEN}@github.com/ever-works/ever-works.git`);
		}

		// IN the environment of exactly the push, as a URL-scoped header.
		// FOUR entries, not two: the slice AM review found that resetting
		// `credential.helper` alone does not close the fallbacks —
		// `core.askpass` is consulted before any helper, and `core.hooksPath`
		// decides whether a `pre-push` hook gets handed this very
		// environment. The header is LAST, so its index moves with them.
		const basic = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64');
		expect(push?.env.GIT_CONFIG_COUNT).toBe('4');
		expect(push?.env.GIT_CONFIG_KEY_3).toBe(`http.${REMOTE}.extraheader`);
		expect(push?.env.GIT_CONFIG_VALUE_3).toBe(`Authorization: Basic ${basic}`);
	});

	it('APPENDS to environment config the process already carries', async () => {
		// `GIT_CONFIG_COUNT` may already be set — an operator pinning a
		// setting, a harness rewriting remotes with `url.<x>.insteadOf`.
		// Writing index 0 would silently drop theirs, and would also stop
		// our `credential.helper` reset from being the LAST word in config
		// order, which is the only reason it beats the system helper.
		const previous = {
			count: process.env.GIT_CONFIG_COUNT,
			key: process.env.GIT_CONFIG_KEY_0,
			value: process.env.GIT_CONFIG_VALUE_0
		};
		process.env.GIT_CONFIG_COUNT = '1';
		process.env.GIT_CONFIG_KEY_0 = 'url.file:///local/.insteadOf';
		process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/';
		try {
			const invocations: Invocation[] = [];
			const seamed = new LocalWorkspacePlugin({ execFile: fakeGit(invocations) });

			await seamed.finalize(handle, {
				commitMessage: 'feat: seam',
				push: true,
				pushCredential: credential
			});

			const push = invocations.find((entry) => entry.args[0] === 'push');
			expect(push?.env.GIT_CONFIG_COUNT).toBe('5');
			expect(push?.env.GIT_CONFIG_KEY_0).toBe('url.file:///local/.insteadOf');
			expect(push?.env.GIT_CONFIG_KEY_1).toBe('credential.helper');
			expect(push?.env.GIT_CONFIG_VALUE_1).toBe('');
			expect(push?.env.GIT_CONFIG_KEY_2).toBe('core.askpass');
			expect(push?.env.GIT_CONFIG_KEY_3).toBe('core.hooksPath');
			expect(push?.env.GIT_CONFIG_KEY_4).toBe(`http.${REMOTE}.extraheader`);
		} finally {
			if (previous.count === undefined) delete process.env.GIT_CONFIG_COUNT;
			else process.env.GIT_CONFIG_COUNT = previous.count;
			if (previous.key === undefined) delete process.env.GIT_CONFIG_KEY_0;
			else process.env.GIT_CONFIG_KEY_0 = previous.key;
			if (previous.value === undefined) delete process.env.GIT_CONFIG_VALUE_0;
			else process.env.GIT_CONFIG_VALUE_0 = previous.value;
		}
	});

	it('resets the credential helper list so no ambient helper can answer', async () => {
		// THE fail-closed guarantee. The fleet's Windows nodes carry
		// `credential.helper=manager` in the SYSTEM gitconfig — no HOME
		// override touches it — so without this reset the long-lived
		// machine PAT authenticates the push exactly as before and the
		// slice changes nothing. Verified against real git: with the reset,
		// `git credential fill` goes straight to "terminal prompts
		// disabled" instead of invoking the manager.
		const invocations: Invocation[] = [];
		const seamed = new LocalWorkspacePlugin({ execFile: fakeGit(invocations) });

		await seamed.finalize(handle, { commitMessage: 'feat: seam', push: true, pushCredential: credential });

		const push = invocations.find((entry) => entry.args[0] === 'push');
		expect(push?.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
		expect(push?.env.GIT_CONFIG_VALUE_0).toBe('');
		// And terminal prompting stays off, so a rejected header cannot fall
		// through to an interactive read either.
		expect(push?.env.GIT_TERMINAL_PROMPT).toBe('0');
	});

	// REGRESSION — the askpass fallback (slice AM review, F5).
	//
	// The doc above used to claim that with `GIT_TERMINAL_PROMPT=0` and the
	// helper reset "Git has no other credential source and a rejected header
	// FAILS". Measured against git 2.53, that was false: askpass is consulted
	// BEFORE any credential helper and is not part of the helper list, so
	//
	//   GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=./a.sh GIT_CONFIG_COUNT=1 \
	//   GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= git credential fill
	//
	// returned a username and password from the helper with exit 0. So every
	// 401 — an expired token, a token the platform scoped elsewhere — fell
	// back to the machine's own long-lived credentials and the push succeeded
	// with no trace in the run, which is precisely the gap this slice closes.
	// Closing it needs BOTH halves, also measured: with `core.askpass` reset
	// AND the environment ones deleted the same command dies `could not read
	// Username ... terminal prompts disabled`.
	it('closes the askpass fallback in BOTH of its forms', async () => {
		const previous = {
			ask: process.env.GIT_ASKPASS,
			ssh: process.env.SSH_ASKPASS,
			params: process.env.GIT_CONFIG_PARAMETERS
		};
		process.env.GIT_ASKPASS = 'C:\\ambient\\askpass.exe';
		process.env.SSH_ASKPASS = '/usr/bin/ssh-askpass';
		// Not askpass, but the same class of hole: `GIT_CONFIG_PARAMETERS` is
		// the transport `git -c` uses and Git reads it AFTER `GIT_CONFIG_COUNT`,
		// so it OVERRIDES the reset. Measured: `git config --get-all
		// credential.helper` with our reset plus this variable ends with the
		// variable's value, i.e. an inherited helper answers the push anyway.
		process.env.GIT_CONFIG_PARAMETERS = "'credential.helper=imposter'";
		try {
			const invocations: Invocation[] = [];
			const seamed = new LocalWorkspacePlugin({ execFile: fakeGit(invocations) });

			await seamed.finalize(handle, { commitMessage: 'feat: seam', push: true, pushCredential: credential });

			const push = invocations.find((entry) => entry.args[0] === 'push');
			// Half one: the CONFIG form, for a `core.askpass` set in the
			// system or global gitconfig, which the helper reset cannot
			// displace because it is not a helper.
			expect(push?.env.GIT_CONFIG_KEY_1).toBe('core.askpass');
			expect(push?.env.GIT_CONFIG_VALUE_1).toBe('');
			// Half two: the ENVIRONMENT forms, DELETED rather than emptied —
			// an empty `GIT_ASKPASS` is still set, and Git would try to run
			// "" as a program.
			expect(push?.env).not.toHaveProperty('GIT_ASKPASS');
			expect(push?.env).not.toHaveProperty('SSH_ASKPASS');
			expect(push?.env).not.toHaveProperty('GIT_CONFIG_PARAMETERS');

			// Every OTHER command keeps the operator's environment: none of
			// them carries a write token, so none of them needs narrowing.
			const status = invocations.find((entry) => entry.args[0] === 'status');
			expect(status?.env.GIT_ASKPASS).toBe('C:\\ambient\\askpass.exe');
		} finally {
			for (const [name, value] of [
				['GIT_ASKPASS', previous.ask],
				['SSH_ASKPASS', previous.ssh],
				['GIT_CONFIG_PARAMETERS', previous.params]
			] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	// REGRESSION — the pre-push hook harvests the token (slice AM review, F2).
	//
	// Git hands a `pre-push` hook the whole child environment, so the hook
	// can read `GIT_CONFIG_VALUE_<n>` — the base64 basic-auth form of a live
	// `contents: write` token — and `exit 0` so the run still looks clean.
	// Measured against git 2.53 in this plugin's exact layout (bare pool +
	// `git worktree add`): a hook at `<poolDir>/hooks/pre-push` fired on a
	// push from the linked worktree and printed
	// `GIT_CONFIG_VALUE_1=Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzXy4uLg`.
	// It is outside the checkout, so `git add -A` never stages it,
	// `assertNoPersistedCredential` never sees it, and it survives worktree
	// teardown to harvest the NEXT Task's token too.
	it('runs no hooks on a credentialed push', async () => {
		const invocations: Invocation[] = [];
		const seamed = new LocalWorkspacePlugin({ execFile: fakeGit(invocations) });

		await seamed.finalize(handle, { commitMessage: 'feat: seam', push: true, pushCredential: credential });

		const push = invocations.find((entry) => entry.args[0] === 'push');
		expect(push?.args).toContain('--no-verify');
		expect(push?.env.GIT_CONFIG_KEY_2).toBe('core.hooksPath');
		expect(push?.env.GIT_CONFIG_VALUE_2).toBe('');
		// The refspec and the remote still follow, in that order — the flag
		// was inserted, not substituted for one of them.
		expect(push?.args.slice(-2)).toEqual([REMOTE, `HEAD:refs/heads/${handle.branch}`]);
	});

	it('leaves hooks alone when there is no credential to protect', async () => {
		// The cloud runner's path. It authenticates through URL userinfo and
		// carries no environment credential for a hook to read, so silencing
		// its hooks would be an unrelated behaviour change.
		const invocations: Invocation[] = [];
		const seamed = new LocalWorkspacePlugin({ execFile: fakeGit(invocations) });

		await seamed.finalize(handle, { commitMessage: 'feat: seam', push: true });

		const push = invocations.find((entry) => entry.args[0] === 'push');
		expect(push?.args).not.toContain('--no-verify');
	});

	// REGRESSION — the post-push probe used to mask the push failure and to
	// fail a push that had already landed (slice AM review, F9).
	//
	// No test reached this branch before: the only spec that makes the probe
	// throw seeds `credential.helper` BEFORE finalize, so the PRE-push probe
	// fires and the push never runs; in every seam test the `--get-regexp`
	// fake exits 1, so the post-push probe runs but can never throw.
	// Deleting the post-push call left the whole suite green.
	describe('the post-push proof', () => {
		/** A git fake whose `--get-regexp` answers differ before and after the push. */
		function fakeGitWithLateConfig(invocations: Invocation[], pushFails: boolean) {
			let pushed = false;
			return ((
				_command: string,
				args: string[],
				options: { env?: NodeJS.ProcessEnv },
				callback: (error: Error | null, stdout: string, stderr: string) => void
			) => {
				invocations.push({ args: [...args], env: { ...(options.env ?? {}) } });
				const joined = args.join(' ');
				let stdout = '';
				let stderr = '';
				let error: Error | null = null;
				if (joined.startsWith('status')) stdout = ' M work.txt\n';
				else if (joined.startsWith('rev-parse')) stdout = 'a'.repeat(40);
				else if (joined.startsWith('remote get-url')) stdout = `${REMOTE}\n`;
				else if (joined.startsWith('diff')) stdout = 'work.txt\n';
				else if (joined.includes('--get-regexp')) {
					// Clean before the push, dirty after it — the shape of a
					// credential that only appears once git has run.
					if (pushed) stdout = 'credential.helper\n';
					else error = Object.assign(new Error('no match'), { code: 1 });
				} else if (joined.startsWith('push')) {
					pushed = true;
					if (pushFails) {
						stderr = 'remote rejected: refs/heads/task/seam-ffff6666 (protected branch)';
						error = Object.assign(new Error('push failed'), { code: 128 });
					}
				}
				setImmediate(() => callback(error, stdout, stderr));
				return { pid: 1 } as never;
			}) as never;
		}

		it('never replaces the real push failure with its own', async () => {
			const invocations: Invocation[] = [];
			const seamed = new LocalWorkspacePlugin({ execFile: fakeGitWithLateConfig(invocations, true) });

			const error = await seamed
				.finalize(handle, { commitMessage: 'feat: seam', push: true, pushCredential: credential })
				.then(
					() => null,
					(caught: Error) => caught
				);

			// The operator debugs the protected branch, which is what
			// actually failed the run — not a config probe that fired
			// afterwards. Before this fix `pushFailure` was silently
			// discarded and only the probe's message survived.
			expect(error?.message).toContain('protected branch');
			// And the probe's finding is not dropped either: a credential in
			// the shared pool config is a security event, not a footnote.
			expect(error?.message).toContain('credential.helper');
		});

		it('says the branch IS on the remote when the push already succeeded', async () => {
			const invocations: Invocation[] = [];
			const seamed = new LocalWorkspacePlugin({ execFile: fakeGitWithLateConfig(invocations, false) });

			const error = await seamed
				.finalize(handle, { commitMessage: 'feat: seam', push: true, pushCredential: credential })
				.then(
					() => null,
					(caught: Error) => caught
				);

			// The control still fails closed — a persisted credential stops
			// the run — but the message no longer reads `refusing to
			// publish` for a ref the remote has already accepted. The caller
			// records `pushed: false`, so without this sentence the operator
			// (and the reconciler behind them) chases state that diverged.
			expect(error?.message).toContain('the push completed');
			expect(error?.message).toContain('the branch IS on the remote');
			expect(error?.message).not.toContain('refusing to publish');
		});
	});

	it('gives no other git command the credential', async () => {
		const invocations: Invocation[] = [];
		const seamed = new LocalWorkspacePlugin({ execFile: fakeGit(invocations) });

		await seamed.finalize(handle, { commitMessage: 'feat: seam', push: true, pushCredential: credential });

		for (const entry of invocations.filter((call) => call.args[0] !== 'push')) {
			expect(entry.env.GIT_CONFIG_COUNT).toBeUndefined();
			expect(JSON.stringify(entry.env)).not.toContain(TOKEN);
		}
	});

	it('scrubs the token — raw AND base64 — out of a failed push', async () => {
		// `git push` stderr is wrapped into the fleet job's git result and
		// stored verbatim in `fleet_jobs.result`, so anything git echoes
		// back has to be scrubbed at the source.
		const basic = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64');
		const invocations: Invocation[] = [];
		const seamed = new LocalWorkspacePlugin({
			execFile: fakeGit(invocations, `remote rejected: header was 'Authorization: Basic ${basic}' (${TOKEN})`)
		});

		await expect(
			seamed.finalize(handle, { commitMessage: 'feat: seam', push: true, pushCredential: credential })
		).rejects.toThrow(/git push failed/);

		await seamed
			.finalize(handle, { commitMessage: 'feat: seam', push: true, pushCredential: credential })
			.catch((error: Error) => {
				expect(error.message).not.toContain(TOKEN);
				expect(error.message).not.toContain(basic);
				expect(error.message).toContain('***');
			});
	});

	it('does not install anything when the caller supplied no credential', async () => {
		// The cloud runner's path, byte-for-byte what it was.
		const invocations: Invocation[] = [];
		const seamed = new LocalWorkspacePlugin({ execFile: fakeGit(invocations) });

		await seamed.finalize(handle, { commitMessage: 'feat: seam', push: true });

		for (const entry of invocations) {
			expect(entry.env.GIT_CONFIG_COUNT).toBeUndefined();
		}
		// And no persisted-credential probe runs either: the check belongs
		// to the scoped path, not to every caller of this provider.
		expect(invocations.some((entry) => entry.args.includes('--get-regexp'))).toBe(false);
	});
});
