import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { PluginContext, PluginLogger } from '@ever-works/plugin';

// We mock octokit + isomorphic-git at module-resolution time. The plugin
// imports `Octokit` and `RequestError` from `octokit`, and `GitOperations`
// from `@ever-works/plugin/git`. Both are mocked here so the test never
// hits the network or the filesystem.

const octokitMockState = {
	getContent: vi.fn(),
	createOrUpdateFileContents: vi.fn(),
	deleteFile: vi.fn(),
	get: vi.fn()
};

class RequestErrorMock extends Error {
	constructor(
		public status: number,
		message = 'fake'
	) {
		super(message);
	}
}

vi.mock('octokit', () => ({
	Octokit: vi.fn().mockImplementation(() => ({
		rest: {
			repos: {
				getContent: octokitMockState.getContent,
				createOrUpdateFileContents: octokitMockState.createOrUpdateFileContents,
				deleteFile: octokitMockState.deleteFile,
				get: octokitMockState.get
			}
		}
	})),
	RequestError: RequestErrorMock
}));

const gitOpsMockState = {
	cloneOrPull: vi.fn(),
	add: vi.fn(),
	commit: vi.fn(),
	push: vi.fn()
};

vi.mock('@ever-works/plugin/git', () => ({
	GitOperations: vi.fn().mockImplementation(() => ({
		cloneOrPull: gitOpsMockState.cloneOrPull,
		add: gitOpsMockState.add,
		commit: gitOpsMockState.commit,
		push: gitOpsMockState.push
	}))
}));

// node:fs writeFile / mkdir are used by the clone-and-push transport.
// Mock them so we can assert what the plugin wrote without touching disk.
const fsMockState = {
	writeFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined)
};
vi.mock('node:fs', () => ({
	promises: fsMockState
}));

// Global fetch — used by the LFS Batch API + LFS blob upload.
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchQueue: Array<(url: string, init?: RequestInit) => Promise<Response>> = [];
const fetchMock: Mock = vi.fn(async (url: unknown, init?: RequestInit) => {
	const next = fetchQueue.shift();
	if (!next) throw new Error(`Unexpected fetch call to ${String(url)}`);
	fetchCalls.push({ url: String(url), init });
	return next(String(url), init);
});

beforeEach(() => {
	octokitMockState.getContent.mockReset();
	octokitMockState.createOrUpdateFileContents.mockReset();
	octokitMockState.deleteFile.mockReset();
	octokitMockState.get.mockReset();
	gitOpsMockState.cloneOrPull.mockReset();
	gitOpsMockState.add.mockReset();
	gitOpsMockState.commit.mockReset();
	gitOpsMockState.push.mockReset();
	fsMockState.writeFile.mockClear();
	fsMockState.mkdir.mockClear();
	fetchCalls.length = 0;
	fetchQueue = [];
	vi.stubGlobal('fetch', fetchMock);
	// Reset every env var the plugin reads. Each test sets only what it needs.
	delete process.env.GITHUB_STORAGE_MODE;
	delete process.env.GITHUB_STORAGE_LFS_ENABLED;
	delete process.env.GITHUB_STORAGE_TRANSPORT;
	delete process.env.GITHUB_STORAGE_TOKEN;
	delete process.env.GITHUB_STORAGE_OWNER;
	delete process.env.GITHUB_STORAGE_REPO;
	delete process.env.GITHUB_STORAGE_BRANCH;
	delete process.env.GITHUB_STORAGE_PATH_PREFIX;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function loadPlugin() {
	// Re-import to get a fresh module instance — though our module is
	// stateless apart from the per-plugin token cache, this keeps tests
	// independent.
	vi.resetModules();
	const mod = await import('../github-storage.plugin.js');
	return new mod.GitHubStoragePlugin();
}

function noopLogger(): PluginLogger {
	const fn = vi.fn();
	return { log: fn, error: fn, warn: fn, debug: fn, verbose: fn };
}

function ctx(extra: Record<string, unknown> = {}): PluginContext {
	return {
		pluginId: 'github-storage',
		logger: noopLogger(),
		...extra
	} as unknown as PluginContext;
}

describe('GitHubStoragePlugin — separate-repo mode', () => {
	beforeEach(() => {
		process.env.GITHUB_STORAGE_TOKEN = 'ghp_xxx';
		process.env.GITHUB_STORAGE_OWNER = 'acme';
		process.env.GITHUB_STORAGE_REPO = 'storage';
	});

	it('legacy behaviour: lfsEnabled defaults OFF when only legacy env vars are set (no mode)', async () => {
		// IMPORTANT: do NOT set GITHUB_STORAGE_MODE here — the migration
		// rule (spec §8) only triggers when `mode` is absent.
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx());
		// 404 on getContent → create. createOrUpdateFileContents resolves.
		octokitMockState.getContent.mockRejectedValueOnce(new RequestErrorMock(404));
		octokitMockState.createOrUpdateFileContents.mockResolvedValueOnce({});
		const result = await plugin.putObject({
			buffer: Buffer.from('hello'),
			filename: 'note.txt',
			mimeType: 'text/plain',
			size: 5,
			ownerId: 'user1'
		});
		expect(result.key).toMatch(/^uploads\/user1\/[0-9a-f]{64}\.txt$/);
		// No LFS batch calls when LFS is off.
		expect(fetchCalls).toHaveLength(0);
		const call = octokitMockState.createOrUpdateFileContents.mock.calls[0][0];
		// Content is base64 of "hello" — direct blob, not a pointer.
		expect(Buffer.from(call.content, 'base64').toString('utf8')).toBe('hello');
		expect(call.path).toBe(result.key);
	});

	it('LFS path: uploads to LFS host first, then commits a pointer + .gitattributes', async () => {
		process.env.GITHUB_STORAGE_MODE = 'separate-repo';
		process.env.GITHUB_STORAGE_LFS_ENABLED = 'true';
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx());
		// LFS batch upload response → action.upload URL.
		fetchQueue.push(
			async () =>
				new Response(
					JSON.stringify({
						objects: [
							{
								oid: 'deadbeef',
								size: 5,
								actions: { upload: { href: 'https://lfs.example.com/up' } }
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/vnd.git-lfs+json' } }
				)
		);
		// LFS blob PUT.
		fetchQueue.push(async () => new Response('', { status: 200 }));
		// resolveGitattributesPatch — read .gitattributes (404 = file doesn't exist).
		octokitMockState.getContent.mockRejectedValueOnce(new RequestErrorMock(404));
		// commitFiles via Contents API loops over [.gitattributes, pointer]:
		//   .gitattributes pre-check (404) → create
		//   pointer pre-check (404) → create
		// EW-644 Greptile P1 fix: both files now go through commitFiles
		// so the assert covers the merged single-transport path.
		octokitMockState.getContent.mockRejectedValueOnce(new RequestErrorMock(404));
		octokitMockState.createOrUpdateFileContents.mockResolvedValueOnce({});
		octokitMockState.getContent.mockRejectedValueOnce(new RequestErrorMock(404));
		octokitMockState.createOrUpdateFileContents.mockResolvedValueOnce({});

		await plugin.putObject({
			buffer: Buffer.from('hello'),
			filename: 'note.txt',
			mimeType: 'text/plain',
			size: 5,
			ownerId: 'user1'
		});

		// 1st fetch = LFS batch, 2nd fetch = LFS blob PUT
		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls[0].url).toMatch(/info\/lfs\/objects\/batch$/);
		expect(fetchCalls[1].url).toBe('https://lfs.example.com/up');
		expect(fetchCalls[1].init?.method).toBe('PUT');

		// Two commits: .gitattributes + pointer file
		const commits = octokitMockState.createOrUpdateFileContents.mock.calls;
		expect(commits).toHaveLength(2);
		expect(commits[0][0].path).toBe('.gitattributes');
		expect(Buffer.from(commits[0][0].content, 'base64').toString('utf8')).toContain(
			'uploads/** filter=lfs diff=lfs merge=lfs -text'
		);
		expect(commits[1][0].path).toMatch(/^uploads\/user1\/[0-9a-f]{64}\.txt$/);
		const pointerContent = Buffer.from(commits[1][0].content, 'base64').toString('utf8');
		expect(pointerContent).toContain('version https://git-lfs.github.com/spec/v1');
		expect(pointerContent).toMatch(/^oid sha256:[0-9a-f]{64}$/m);
		expect(pointerContent).toContain('size 5');
	});

	it('LFS path: skips blob upload when the batch API reports already-exists', async () => {
		process.env.GITHUB_STORAGE_MODE = 'separate-repo';
		process.env.GITHUB_STORAGE_LFS_ENABLED = 'true';
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx());
		// LFS batch returns no actions → already-exists.
		fetchQueue.push(
			async () =>
				new Response(JSON.stringify({ objects: [{ oid: 'x', size: 1, actions: {} }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/vnd.git-lfs+json' }
				})
		);
		// .gitattributes already has the line → idempotent skip (we
		// achieve that by returning content that already includes the line).
		octokitMockState.getContent.mockResolvedValueOnce({
			data: {
				type: 'file',
				content: Buffer.from('uploads/** filter=lfs diff=lfs merge=lfs -text\n').toString('base64'),
				sha: 'gitattr-sha'
			}
		});
		// Pointer file lookup → 404, then commit.
		octokitMockState.getContent.mockRejectedValueOnce(new RequestErrorMock(404));
		octokitMockState.createOrUpdateFileContents.mockResolvedValueOnce({});

		await plugin.putObject({
			buffer: Buffer.from('hello'),
			filename: 'note.txt',
			mimeType: 'text/plain',
			size: 5,
			ownerId: 'user1'
		});

		// Only 1 fetch (batch) — no PUT to LFS host
		expect(fetchCalls).toHaveLength(1);
		// Only the pointer commit happens; .gitattributes was idempotent
		expect(octokitMockState.createOrUpdateFileContents.mock.calls).toHaveLength(1);
		expect(octokitMockState.createOrUpdateFileContents.mock.calls[0][0].path).toMatch(
			/^uploads\/user1\/[0-9a-f]{64}\.txt$/
		);
	});

	it('LFS path: surfaces a clear error when the LFS batch endpoint 403s', async () => {
		process.env.GITHUB_STORAGE_MODE = 'separate-repo';
		process.env.GITHUB_STORAGE_LFS_ENABLED = 'true';
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx());
		fetchQueue.push(async () => new Response('LFS not enabled', { status: 403 }));
		await expect(
			plugin.putObject({
				buffer: Buffer.from('hello'),
				filename: 'note.txt',
				mimeType: 'text/plain',
				size: 5,
				ownerId: 'user1'
			})
		).rejects.toThrow(/Is Git LFS enabled on the target repo/);
		// No pointer commit, no .gitattributes commit, no blob upload.
		expect(octokitMockState.createOrUpdateFileContents).not.toHaveBeenCalled();
	});
});

describe('GitHubStoragePlugin — data-repo mode', () => {
	beforeEach(() => {
		process.env.GITHUB_STORAGE_MODE = 'data-repo';
		// Default transport for data-repo is clone-and-push.
	});

	it('throws if workId is missing', async () => {
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx({ workRepoResolver: { resolve: async () => ({}) } }));
		await expect(
			plugin.putObject({
				buffer: Buffer.from('hi'),
				filename: 'n.txt',
				mimeType: 'text/plain',
				size: 2,
				ownerId: 'user1'
			})
		).rejects.toThrow(/requires StoragePutInput\.workId/);
	});

	it('throws if no WorkRepoResolver is wired into the context', async () => {
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx());
		await expect(
			plugin.putObject({
				buffer: Buffer.from('hi'),
				filename: 'n.txt',
				mimeType: 'text/plain',
				size: 2,
				ownerId: 'user1',
				workId: 'work-1'
			})
		).rejects.toThrow(/requires a WorkRepoResolver/);
	});

	it('non-LFS path uses isomorphic-git clone+commit+push', async () => {
		process.env.GITHUB_STORAGE_LFS_ENABLED = 'false';
		const resolver = {
			resolve: vi.fn().mockResolvedValue({
				owner: 'workowner',
				repo: 'workdata',
				branch: 'main',
				token: 'oauth-tok'
			})
		};
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx({ workRepoResolver: resolver }));
		gitOpsMockState.cloneOrPull.mockResolvedValueOnce('/tmp/repo');
		gitOpsMockState.commit.mockResolvedValueOnce('abc123');
		gitOpsMockState.push.mockResolvedValueOnce(undefined);

		const result = await plugin.putObject({
			buffer: Buffer.from('hi'),
			filename: 'n.txt',
			mimeType: 'text/plain',
			size: 2,
			ownerId: 'user1',
			workId: 'work-1'
		});

		expect(resolver.resolve).toHaveBeenCalledWith('work-1');
		expect(gitOpsMockState.cloneOrPull).toHaveBeenCalledWith(
			expect.objectContaining({ owner: 'workowner', repo: 'workdata', token: 'oauth-tok' })
		);
		expect(gitOpsMockState.add).toHaveBeenCalledTimes(1);
		expect(gitOpsMockState.commit).toHaveBeenCalledTimes(1);
		expect(gitOpsMockState.push).toHaveBeenCalledTimes(1);
		// Octokit never called when transport is clone-and-push and LFS is off.
		expect(octokitMockState.createOrUpdateFileContents).not.toHaveBeenCalled();
		expect(fetchCalls).toHaveLength(0);
		// EW-644 (Codex P1 fix #2): data-repo keys carry their workId
		// so a later read/delete can recover the Work coordinates
		// without an external lookup.
		expect(result.key).toMatch(/^dr:work-1:uploads\/user1\/[0-9a-f]{64}\.txt$/);
		expect(result.url).toMatch(/^\/api\/uploads\/user1\/[0-9a-f]{64}\.txt\?workId=work-1$/);
	});
});

describe('GitHubStoragePlugin — data-repo read/delete round-trip (EW-644 Codex P1 fix)', () => {
	beforeEach(() => {
		process.env.GITHUB_STORAGE_MODE = 'data-repo';
		process.env.GITHUB_STORAGE_LFS_ENABLED = 'false';
		process.env.GITHUB_STORAGE_TRANSPORT = 'contents-api';
	});

	it('encodes workId into the storage key + URL on put', async () => {
		const resolver = {
			resolve: vi.fn().mockResolvedValue({
				owner: 'workowner',
				repo: 'workdata',
				branch: 'main',
				token: 'oauth-tok'
			})
		};
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx({ workRepoResolver: resolver }));
		octokitMockState.getContent.mockRejectedValueOnce(new RequestErrorMock(404));
		octokitMockState.createOrUpdateFileContents.mockResolvedValueOnce({});

		const result = await plugin.putObject({
			buffer: Buffer.from('hi'),
			filename: 'n.txt',
			mimeType: 'text/plain',
			size: 2,
			ownerId: 'user1',
			workId: 'work-1'
		});

		expect(result.key.startsWith('dr:work-1:')).toBe(true);
		expect(result.url).toContain('workId=work-1');
	});

	it('getObject(dr-key) re-resolves the Work and fetches from its repo', async () => {
		const resolver = {
			resolve: vi.fn().mockResolvedValue({
				owner: 'workowner',
				repo: 'workdata',
				branch: 'main',
				token: 'oauth-tok'
			})
		};
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx({ workRepoResolver: resolver }));
		// Octokit returns a non-LFS direct blob.
		octokitMockState.getContent.mockResolvedValueOnce({
			data: {
				type: 'file',
				content: Buffer.from('hello').toString('base64'),
				sha: 'blob-sha'
			}
		});

		const out = await plugin.getObject('dr:work-1:uploads/user1/abc.txt');
		expect(resolver.resolve).toHaveBeenCalledWith('work-1');
		// Octokit was asked for the path WITHOUT the dr: prefix, and
		// targeted the resolved owner/repo (not any env-configured one).
		expect(octokitMockState.getContent.mock.calls[0][0]).toMatchObject({
			owner: 'workowner',
			repo: 'workdata',
			path: 'uploads/user1/abc.txt',
			ref: 'main'
		});
		expect(out.buffer.toString('utf8')).toBe('hello');
	});

	it('deleteObject(dr-key) re-resolves the Work and deletes from its repo', async () => {
		const resolver = {
			resolve: vi.fn().mockResolvedValue({
				owner: 'workowner',
				repo: 'workdata',
				branch: 'main',
				token: 'oauth-tok'
			})
		};
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx({ workRepoResolver: resolver }));
		octokitMockState.getContent.mockResolvedValueOnce({
			data: { type: 'file', content: '', sha: 'blob-sha' }
		});
		octokitMockState.deleteFile.mockResolvedValueOnce({});

		await plugin.deleteObject('dr:work-1:uploads/user1/abc.txt');
		expect(resolver.resolve).toHaveBeenCalledWith('work-1');
		expect(octokitMockState.deleteFile.mock.calls[0][0]).toMatchObject({
			owner: 'workowner',
			repo: 'workdata',
			path: 'uploads/user1/abc.txt'
		});
	});

	it('deriveKey(ownerId, filename, workId) returns the dr:-prefixed key in data-repo mode', async () => {
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx({ workRepoResolver: { resolve: vi.fn() } }));
		expect(plugin.deriveKey('user1', 'abc.txt', 'work-7')).toBe('dr:work-7:uploads/user1/abc.txt');
	});
});

describe('GitHubStoragePlugin — transport override', () => {
	beforeEach(() => {
		process.env.GITHUB_STORAGE_MODE = 'separate-repo';
		process.env.GITHUB_STORAGE_TOKEN = 'ghp_xxx';
		process.env.GITHUB_STORAGE_OWNER = 'acme';
		process.env.GITHUB_STORAGE_REPO = 'storage';
		process.env.GITHUB_STORAGE_LFS_ENABLED = 'false';
	});

	it('explicit transport=clone-and-push uses isomorphic-git even in separate-repo mode', async () => {
		process.env.GITHUB_STORAGE_TRANSPORT = 'clone-and-push';
		const plugin = await loadPlugin();
		await plugin.onLoad(ctx());
		gitOpsMockState.cloneOrPull.mockResolvedValueOnce('/tmp/repo');
		gitOpsMockState.commit.mockResolvedValueOnce('abc123');
		gitOpsMockState.push.mockResolvedValueOnce(undefined);
		await plugin.putObject({
			buffer: Buffer.from('hi'),
			filename: 'n.txt',
			mimeType: 'text/plain',
			size: 2,
			ownerId: 'user1'
		});
		expect(gitOpsMockState.push).toHaveBeenCalledTimes(1);
		expect(octokitMockState.createOrUpdateFileContents).not.toHaveBeenCalled();
	});
});
