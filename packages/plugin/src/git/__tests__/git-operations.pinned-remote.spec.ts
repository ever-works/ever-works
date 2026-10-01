import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import git from 'isomorphic-git';
import { GitOperations } from '../git-operations.js';

/**
 * Where `push`, `pull` and `fetch` send the git credentials — against the REAL
 * isomorphic-git, with two local HTTP servers: `remote` stands in for the
 * repository's real host, `stranger` for any other server.
 *
 * Left to itself, isomorphic-git chooses the destination from the checkout's
 * config, and not only from `remote.origin.url`: a push prefers
 * `remote.origin.pushurl`, a pull or fetch follows `branch.<ref>.remote` to
 * another remote, and all three route through `http.corsProxy`. A checkout's
 * config is a file; anything that has written into the checkout could have set
 * any of them. Resetting `remote.origin.url` alone (what `cloneOrPull` does)
 * left every other key in place. Against the previous `GitOperations`, 8 of
 * these 10 cases fail; the `pushDefault` / `pushRemote` cases pass either way,
 * because isomorphic-git's public `push` defaults `remote` to `'origin'` before
 * its internals would read them — they are here so an upgrade cannot change
 * that silently.
 *
 * Both servers answer `401`, so isomorphic-git asks `onAuth` for the
 * credentials and sends them on its retry: a request that reaches `stranger`
 * with an `Authorization` header is the token leaving.
 */

interface Seen {
	requests: number;
	withAuth: number;
}

function startServer(): Promise<{ server: http.Server; url: string; seen: Seen }> {
	const seen: Seen = { requests: 0, withAuth: 0 };
	const server = http.createServer((req, res) => {
		seen.requests += 1;
		if (req.headers.authorization) seen.withAuth += 1;
		res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
		res.end();
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			resolve({ server, url: `http://127.0.0.1:${port}`, seen });
		});
	});
}

let remote: Awaited<ReturnType<typeof startServer>>;
let stranger: Awaited<ReturnType<typeof startServer>>;
let root: string;
let dir: string;

const OWNER = 'acme';
const REPO = 'widgets';

function makeOps(): GitOperations {
	return new GitOperations(
		() => ({ username: 'x-access-token', password: 'member-token' }),
		(owner, repo) => `${remote.url}/${owner}/${repo}.git`,
		{ baseDir: root }
	);
}

async function setConfig(key: string, value: string): Promise<void> {
	await git.setConfig({ fs, dir, path: key, value });
}

beforeAll(async () => {
	remote = await startServer();
	stranger = await startServer();
});

afterAll(async () => {
	await new Promise((r) => remote.server.close(r));
	await new Promise((r) => stranger.server.close(r));
});

beforeEach(async () => {
	remote.seen.requests = remote.seen.withAuth = 0;
	stranger.seen.requests = stranger.seen.withAuth = 0;
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-remote-'));
	dir = path.join(root, 'checkout');
	fs.mkdirSync(dir);
	await git.init({ fs, dir, defaultBranch: 'main' });
	fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
	await git.add({ fs, dir, filepath: 'README.md' });
	await git.commit({ fs, dir, message: 'init', author: { name: 't', email: 't@example.com' } });
	await git.addRemote({ fs, dir, remote: 'origin', url: `${remote.url}/${OWNER}/${REPO}.git` });
	// What a clone leaves behind: `main` tracks origin.
	await setConfig('branch.main.remote', 'origin');
	await setConfig('branch.main.merge', 'refs/heads/main');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('GitOperations — the checkout config never chooses where credentials go', () => {
	describe('push', () => {
		it.each([
			['remote.origin.pushurl', async () => setConfig('remote.origin.pushurl', `${stranger.url}/x.git`)],
			// The next two pass against the previous code as well — see the header.
			[
				'remote.pushDefault',
				async () => {
					await setConfig('remote.elsewhere.url', `${stranger.url}/x.git`);
					await setConfig('remote.pushDefault', 'elsewhere');
				}
			],
			[
				'branch.<ref>.pushRemote',
				async () => {
					await setConfig('remote.elsewhere.url', `${stranger.url}/x.git`);
					await setConfig('branch.main.pushRemote', 'elsewhere');
				}
			],
			['http.corsProxy', async () => setConfig('http.corsProxy', stranger.url)]
		])('ignores %s', async (_key, poison) => {
			await poison();

			await expect(makeOps().push({ dir, token: 'member-token', ref: 'main', maxRetries: 1 })).rejects.toThrow();

			expect(stranger.seen.requests).toBe(0);
			expect(remote.seen.withAuth).toBeGreaterThan(0);
		});

		it('with owner/repo, pushes to the URL it computes — even when origin itself was rewritten', async () => {
			await setConfig('remote.origin.url', `${stranger.url}/x.git`);

			await expect(
				makeOps().push({ dir, token: 'member-token', ref: 'main', maxRetries: 1, owner: OWNER, repo: REPO })
			).rejects.toThrow();

			expect(stranger.seen.requests).toBe(0);
			expect(remote.seen.withAuth).toBeGreaterThan(0);
		});
	});

	describe('pull and fetch', () => {
		it.each([
			[
				'branch.<ref>.remote',
				async () => {
					await setConfig('remote.elsewhere.url', `${stranger.url}/x.git`);
					await setConfig('branch.main.remote', 'elsewhere');
				}
			],
			['http.corsProxy', async () => setConfig('http.corsProxy', stranger.url)]
		])('pull ignores %s', async (_key, poison) => {
			await poison();

			await expect(makeOps().pull(dir, 'member-token')).rejects.toThrow();

			expect(stranger.seen.requests).toBe(0);
			expect(remote.seen.withAuth).toBeGreaterThan(0);
		});

		it('cloneOrPull pulls from the URL it computes, with a poisoned proxy left in the config', async () => {
			// The checkout `cloneOrPull` would reuse for this repository.
			const ops = makeOps();
			const existing = ops.getLocalDir(OWNER, REPO);
			fs.mkdirSync(path.dirname(existing), { recursive: true });
			fs.renameSync(dir, existing);
			dir = existing;
			await setConfig('http.corsProxy', stranger.url);

			// The pull is refused (401), so `cloneOrPull` drops the directory and
			// tries a fresh clone — which the same server refuses too.
			await expect(
				ops.cloneOrPull({ owner: OWNER, repo: REPO, token: 'member-token', autoSwitchToMainBranch: false })
			).rejects.toThrow();

			expect(stranger.seen.requests).toBe(0);
			expect(remote.seen.withAuth).toBeGreaterThan(0);
		});

		it('fetch ignores http.corsProxy', async () => {
			await setConfig('http.corsProxy', stranger.url);

			await expect(makeOps().fetch(dir, 'member-token')).rejects.toThrow();

			expect(stranger.seen.requests).toBe(0);
			expect(remote.seen.withAuth).toBeGreaterThan(0);
		});
	});

	it('refuses a network operation on a checkout with no origin URL, rather than guessing one', async () => {
		await git.deleteRemote({ fs, dir, remote: 'origin' });

		await expect(makeOps().push({ dir, token: 'member-token', ref: 'main', maxRetries: 1 })).rejects.toThrow(
			/No URL is configured for git remote 'origin'/
		);
		expect(remote.seen.requests + stranger.seen.requests).toBe(0);
	});
});
