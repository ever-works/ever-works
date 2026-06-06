import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks so they are available inside the vi.mock factories below.
const { httpsGetMock, hashUpdateMock, hashDigestMock } = vi.hoisted(() => ({
	httpsGetMock: vi.fn(),
	hashUpdateMock: vi.fn(),
	hashDigestMock: vi.fn()
}));

vi.mock('https', () => ({
	get: (...args: unknown[]) => httpsGetMock(...args)
}));

vi.mock('http', () => ({
	get: (...args: unknown[]) => httpsGetMock(...args)
}));

vi.mock('node:crypto', () => ({
	createHash: () => ({
		update: (...args: unknown[]) => {
			hashUpdateMock(...args);
			return {
				digest: (...dArgs: unknown[]) => hashDigestMock(...dArgs)
			};
		}
	})
}));

vi.mock('tar', () => ({
	x: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('child_process', () => ({
	spawn: vi.fn()
}));

vi.mock('fs/promises', () => ({
	access: vi.fn().mockRejectedValue(new Error('not cached')),
	mkdir: vi.fn().mockResolvedValue(undefined),
	mkdtemp: vi.fn().mockResolvedValue('/tmp/codex-generator/bin/codex-download-abc'),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(Buffer.from('archive-bytes')),
	readdir: vi.fn().mockResolvedValue([{ name: 'codex', isFile: () => true, isDirectory: () => false }]),
	chmod: vi.fn().mockResolvedValue(undefined),
	copyFile: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
	constants: { X_OK: 1 }
}));

vi.mock('../utils/platform.js', () => ({
	detectPlatform: vi.fn().mockResolvedValue({
		os: 'linux',
		arch: 'x64',
		platformString: 'linux-x64',
		assetName: 'codex-x86_64-unknown-linux-gnu.tar.gz',
		isMusl: false
	}),
	getBinaryPath: vi.fn().mockReturnValue('/tmp/codex-generator/bin/codex-0.120.0-linux-x64')
}));

import { spawn } from 'child_process';

import { ensureBinary } from '../utils/binary-manager.js';

const ASSET_NAME = 'codex-x86_64-unknown-linux-gnu.tar.gz';
const ARCHIVE_URL = `https://github.com/openai/codex/releases/download/rust-v0.120.0/${ASSET_NAME}`;
const GOOD_SHA = 'a'.repeat(64);

class MockResponse extends EventEmitter {
	statusCode = 200;
	headers: Record<string, string> = {};
	resume = vi.fn();
}

class MockRequest extends EventEmitter {
	destroy = vi.fn();
}

/**
 * Drives the mocked https.get: each call resolves the URL, invokes the callback with a fresh
 * response, then streams the body the test supplied for that URL (or 404s if unknown).
 */
function installHttpResponder(bodyByUrl: Record<string, string>): void {
	httpsGetMock.mockImplementation((url: string, _opts: unknown, cb?: (res: MockResponse) => void) => {
		const callback = typeof _opts === 'function' ? (_opts as (res: MockResponse) => void) : cb;
		const res = new MockResponse();
		const req = new MockRequest();
		const body = bodyByUrl[url];
		queueMicrotask(() => {
			if (body === undefined) {
				res.statusCode = 404;
				callback?.(res);
				return;
			}
			callback?.(res);
			res.emit('data', Buffer.from(body, 'utf-8'));
			res.emit('end');
		});
		return req;
	});
}

function releaseJson(assets: Array<{ name: string; digest?: string }>): string {
	return JSON.stringify({
		tag_name: 'rust-v0.120.0',
		assets: assets.map((a) => ({
			name: a.name,
			browser_download_url: `https://github.com/openai/codex/releases/download/rust-v0.120.0/${a.name}`,
			...(a.digest ? { digest: a.digest } : {})
		}))
	});
}

describe('codex binary-manager integrity verification', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		hashUpdateMock.mockReturnValue(undefined);
		hashDigestMock.mockReturnValue(GOOD_SHA);
		// Make canExecute('codex') (the system-PATH fallback) fail so a rejected download
		// surfaces as a thrown error rather than silently falling back to a system binary.
		vi.mocked(spawn).mockImplementation(() => {
			const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
			child.stderr = new EventEmitter();
			queueMicrotask(() => child.emit('error', new Error('no system codex')));
			return child as unknown as ReturnType<typeof spawn>;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('installs the binary when the published digest matches the archive hash', async () => {
		installHttpResponder({
			[`https://api.github.com/repos/openai/codex/releases/tags/rust-v0.120.0`]: releaseJson([
				{ name: ASSET_NAME, digest: `sha256:${GOOD_SHA}` }
			]),
			[ARCHIVE_URL]: 'archive-bytes'
		});
		// canExecute(binaryPath) must report runnable so ensureBinary returns the managed path.
		vi.mocked(spawn).mockImplementation(() => {
			const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
			child.stderr = new EventEmitter();
			queueMicrotask(() => child.emit('exit', 0));
			return child as unknown as ReturnType<typeof spawn>;
		});

		const result = await ensureBinary('0.120.0');
		expect(result).toBe('/tmp/codex-generator/bin/codex-0.120.0-linux-x64');
	});

	it('refuses to install when the archive hash does not match the published digest (MITM/trojan)', async () => {
		hashDigestMock.mockReturnValue('b'.repeat(64)); // attacker-swapped archive hashes differently
		installHttpResponder({
			[`https://api.github.com/repos/openai/codex/releases/tags/rust-v0.120.0`]: releaseJson([
				{ name: ASSET_NAME, digest: `sha256:${GOOD_SHA}` }
			]),
			[ARCHIVE_URL]: 'tampered-bytes'
		});

		await expect(ensureBinary('0.120.0')).rejects.toThrow(/Checksum mismatch|Failed to resolve a runnable Codex/);
	});

	it('fails closed when the release publishes no checksum at all', async () => {
		installHttpResponder({
			[`https://api.github.com/repos/openai/codex/releases/tags/rust-v0.120.0`]: releaseJson([
				{ name: ASSET_NAME } // no digest, no .sha256 sibling asset
			]),
			[ARCHIVE_URL]: 'archive-bytes'
		});

		await expect(ensureBinary('0.120.0')).rejects.toThrow(
			/No checksum|refusing to install an unverified binary|Failed to resolve a runnable Codex/
		);
	});

	it('refuses a release-metadata fetch redirected to a non-GitHub host (SSRF/open-redirect)', async () => {
		httpsGetMock.mockImplementation((url: string, _opts: unknown, cb?: (res: MockResponse) => void) => {
			const callback = typeof _opts === 'function' ? (_opts as (res: MockResponse) => void) : cb;
			const res = new MockResponse();
			const req = new MockRequest();
			queueMicrotask(() => {
				res.statusCode = 302;
				res.headers = { location: 'https://attacker.example.com/evil.json' };
				callback?.(res);
			});
			return req;
		});

		await expect(ensureBinary('0.120.0')).rejects.toThrow(/disallowed host|Failed to resolve a runnable Codex/);
	});
});
