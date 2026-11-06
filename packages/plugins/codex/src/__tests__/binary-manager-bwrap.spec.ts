import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as tar from 'tar';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Codex bundles bubblewrap separately since rust-v0.129.0 (models refresh review, 2026-11-06).
 *
 * At rust-v0.166.0, `codex-rs/linux-sandbox/src/bundled_bwrap.rs` looks for
 * `<exe_dir>/codex-resources/bwrap`, `<exe_dir>/../codex-resources/bwrap` and `<exe_dir>/bwrap`,
 * and checks it against a sha256 compiled into the codex binary (`CODEX_BWRAP_SHA256`).
 * `launcher.rs` panics with "bubblewrap is unavailable: no system bwrap was found on PATH and no
 * bundled codex-resources/bwrap binary was found next to the Codex executable" when neither a
 * system bwrap nor the bundled one exists. Up to rust-v0.128.0 bubblewrap was compiled in
 * (`vendored_bwrap.rs`); rust-v0.129.0 is the first stable release with the separate
 * `bwrap-<target>.tar.gz` assets.
 *
 * These specs run the real binary-manager against real tar.gz archives on disk; only the network
 * (`https`), the `codex --version` probe (`child_process`) and platform detection are faked.
 */

const { httpsGetMock, spawnMock, platformState } = vi.hoisted(() => ({
	httpsGetMock: vi.fn(),
	spawnMock: vi.fn(),
	platformState: {
		root: '',
		info: {
			os: 'linux' as 'linux' | 'darwin',
			arch: 'x64' as 'x64' | 'arm64',
			platformString: 'linux-x64',
			assetName: 'codex-x86_64-unknown-linux-musl.tar.gz',
			bwrapAssetName: 'bwrap-x86_64-unknown-linux-musl.tar.gz' as string | undefined,
			isMusl: false
		}
	}
}));

vi.mock('https', () => {
	const mocked = { get: (...args: unknown[]) => httpsGetMock(...args) };
	return { ...mocked, default: mocked };
});

vi.mock('child_process', () => ({
	spawn: (...args: unknown[]) => spawnMock(...args)
}));

vi.mock('../utils/platform.js', async () => {
	const nodePath = await import('node:path');
	const installDir = (version: string, platformString: string) =>
		nodePath.join(platformState.root, 'bin', `codex-${version}-${platformString}`);
	return {
		detectPlatform: vi.fn(async () => ({ ...platformState.info })),
		getInstallDir: installDir,
		getBinaryPath: (version: string, platformString: string) =>
			nodePath.join(installDir(version, platformString), 'codex')
	};
});

import { ensureBinary, resolveExistingBinary } from '../utils/binary-manager.js';

const CODEX_ENTRY = 'codex-x86_64-unknown-linux-musl';
const BWRAP_ENTRY = 'bwrap-x86_64-unknown-linux-musl';
const CODEX_ASSET = `${CODEX_ENTRY}.tar.gz`;
const BWRAP_ASSET = `${BWRAP_ENTRY}.tar.gz`;

let fixtureDir = '';
let codexArchive: Buffer;
let bwrapArchive: Buffer;
let tamperedBwrapArchive: Buffer;

function sha256(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

async function makeArchive(entryName: string, content: string, archiveName: string): Promise<Buffer> {
	const stage = await fs.mkdtemp(path.join(fixtureDir, 'stage-'));
	await fs.writeFile(path.join(stage, entryName), content, { mode: 0o755 });
	const file = path.join(fixtureDir, archiveName);
	await tar.c({ gzip: true, cwd: stage, file }, [entryName]);
	return fs.readFile(file);
}

function downloadUrl(version: string, asset: string): string {
	return `https://github.com/openai/codex/releases/download/rust-v${version}/${asset}`;
}

function releaseUrl(version: string): string {
	return `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`;
}

interface AssetSpec {
	readonly name: string;
	readonly body: Buffer;
	readonly digest?: string | null;
}

/** Serve a GitHub release (JSON + asset bodies). `digest: null` publishes the asset without one. */
function serveRelease(version: string, assets: AssetSpec[]): void {
	const bodies = new Map<string, Buffer>();
	bodies.set(
		releaseUrl(version),
		Buffer.from(
			JSON.stringify({
				tag_name: `rust-v${version}`,
				assets: assets.map((asset) => ({
					name: asset.name,
					browser_download_url: downloadUrl(version, asset.name),
					...(asset.digest === null ? {} : { digest: `sha256:${asset.digest ?? sha256(asset.body)}` })
				}))
			})
		)
	);
	for (const asset of assets) {
		bodies.set(downloadUrl(version, asset.name), asset.body);
	}
	httpsGetMock.mockImplementation((url: string, _options: unknown, onResponse: (res: unknown) => void) => {
		const req = new EventEmitter() as EventEmitter & { destroy: () => void };
		req.destroy = vi.fn();
		const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, resume: vi.fn() });
		queueMicrotask(() => {
			const body = bodies.get(url);
			if (!body) {
				res.statusCode = 404;
				onResponse(res);
				return;
			}
			onResponse(res);
			res.emit('data', body);
			res.emit('end');
		});
		return req;
	});
}

function requestedUrls(): string[] {
	return httpsGetMock.mock.calls.map((call) => String(call[0]));
}

function installDir(version: string): string {
	return path.join(platformState.root, 'bin', `codex-${version}-${platformState.info.platformString}`);
}

async function exists(target: string): Promise<boolean> {
	return fs.access(target).then(
		() => true,
		() => false
	);
}

beforeAll(async () => {
	fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bwrap-fixtures-'));
	codexArchive = await makeArchive(CODEX_ENTRY, '#!codex 0.166.0', 'codex.tar.gz');
	bwrapArchive = await makeArchive(BWRAP_ENTRY, '#!bwrap for 0.166.0', 'bwrap.tar.gz');
	tamperedBwrapArchive = await makeArchive(BWRAP_ENTRY, '#!trojaned bwrap', 'bwrap-tampered.tar.gz');
});

afterAll(async () => {
	await fs.rm(fixtureDir, { recursive: true, force: true });
});

beforeEach(async () => {
	vi.clearAllMocks();
	platformState.root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bwrap-cache-'));
	platformState.info = {
		os: 'linux',
		arch: 'x64',
		platformString: 'linux-x64',
		assetName: CODEX_ASSET,
		bwrapAssetName: BWRAP_ASSET,
		isMusl: false
	};
	// `--version` succeeds for any managed binary under the cache root; there is no system codex.
	spawnMock.mockImplementation((command: string) => {
		const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
		queueMicrotask(() => {
			if (command.startsWith(platformState.root)) {
				child.emit('exit', 0);
			} else {
				child.emit('error', new Error('no system codex'));
			}
		});
		return child;
	});
});

afterEach(async () => {
	await fs.rm(platformState.root, { recursive: true, force: true });
});

describe('codex binary-manager: bundled bubblewrap (rust-v0.129.0+ on Linux)', () => {
	it('downloads the bwrap asset, verifies it and installs codex-resources/bwrap next to codex', async () => {
		serveRelease('0.166.0', [
			{ name: CODEX_ASSET, body: codexArchive },
			{ name: BWRAP_ASSET, body: bwrapArchive }
		]);

		const binaryPath = await ensureBinary('0.166.0');

		const dir = installDir('0.166.0');
		expect(binaryPath).toBe(path.join(dir, 'codex'));
		expect(await fs.readFile(binaryPath, 'utf-8')).toBe('#!codex 0.166.0');
		expect(await fs.readFile(path.join(dir, 'codex-resources', 'bwrap'), 'utf-8')).toBe('#!bwrap for 0.166.0');
		expect(requestedUrls()).toEqual([
			releaseUrl('0.166.0'),
			downloadUrl('0.166.0', CODEX_ASSET),
			downloadUrl('0.166.0', BWRAP_ASSET)
		]);
		// Only the install directory and nothing else (no leftover download dirs) under bin/.
		expect(await fs.readdir(path.join(platformState.root, 'bin'))).toEqual(['codex-0.166.0-linux-x64']);
	});

	it('refuses a tampered bwrap archive and installs nothing', async () => {
		serveRelease('0.166.0', [
			{ name: CODEX_ASSET, body: codexArchive },
			// The release metadata publishes the genuine digest; the bytes served are different.
			{ name: BWRAP_ASSET, body: tamperedBwrapArchive, digest: sha256(bwrapArchive) }
		]);

		await expect(ensureBinary('0.166.0')).rejects.toThrow(/Checksum mismatch for bubblewrap/);
		expect(await exists(path.join(installDir('0.166.0'), 'codex'))).toBe(false);
		expect(await exists(path.join(installDir('0.166.0'), 'codex-resources', 'bwrap'))).toBe(false);
	});

	it('fails closed when the bwrap asset publishes no checksum', async () => {
		serveRelease('0.166.0', [
			{ name: CODEX_ASSET, body: codexArchive },
			{ name: BWRAP_ASSET, body: bwrapArchive, digest: null }
		]);

		await expect(ensureBinary('0.166.0')).rejects.toThrow(/No checksum .*bubblewrap/);
		expect(await exists(path.join(installDir('0.166.0'), 'codex'))).toBe(false);
	});

	it('fails closed when a 0.129.0+ Linux release has no bwrap asset', async () => {
		serveRelease('0.166.0', [{ name: CODEX_ASSET, body: codexArchive }]);

		await expect(ensureBinary('0.166.0')).rejects.toThrow(/bubblewrap/);
		expect(await exists(path.join(installDir('0.166.0'), 'codex'))).toBe(false);
	});

	it('installs codex alone for a release that still compiles bubblewrap in (0.128.0)', async () => {
		serveRelease('0.128.0', [{ name: CODEX_ASSET, body: codexArchive }]);

		const binaryPath = await ensureBinary('0.128.0');

		expect(binaryPath).toBe(path.join(installDir('0.128.0'), 'codex'));
		expect(await exists(path.join(installDir('0.128.0'), 'codex-resources'))).toBe(false);
	});

	it('downloads no bwrap on macOS', async () => {
		platformState.info = {
			os: 'darwin',
			arch: 'arm64',
			platformString: 'darwin-arm64',
			assetName: 'codex-aarch64-apple-darwin.tar.gz',
			bwrapAssetName: undefined,
			isMusl: false
		};
		serveRelease('0.166.0', [
			{ name: 'codex-aarch64-apple-darwin.tar.gz', body: codexArchive },
			{ name: BWRAP_ASSET, body: bwrapArchive }
		]);

		await ensureBinary('0.166.0');

		expect(requestedUrls()).not.toContain(downloadUrl('0.166.0', BWRAP_ASSET));
	});

	it('gives every CLI version its own bwrap (codex pins the bwrap sha256 it was built with)', async () => {
		serveRelease('0.165.0', [
			{ name: CODEX_ASSET, body: codexArchive },
			{ name: BWRAP_ASSET, body: bwrapArchive }
		]);
		await ensureBinary('0.165.0');
		serveRelease('0.166.0', [
			{ name: CODEX_ASSET, body: codexArchive },
			{ name: BWRAP_ASSET, body: bwrapArchive }
		]);
		await ensureBinary('0.166.0');

		expect(await exists(path.join(installDir('0.165.0'), 'codex-resources', 'bwrap'))).toBe(true);
		expect(await exists(path.join(installDir('0.166.0'), 'codex-resources', 'bwrap'))).toBe(true);
	});

	it('reuses a complete install without touching the network', async () => {
		serveRelease('0.166.0', [
			{ name: CODEX_ASSET, body: codexArchive },
			{ name: BWRAP_ASSET, body: bwrapArchive }
		]);
		const first = await ensureBinary('0.166.0');
		httpsGetMock.mockClear();

		await expect(ensureBinary('0.166.0')).resolves.toBe(first);
		expect(httpsGetMock).not.toHaveBeenCalled();
	});

	it('reinstalls when the cached codex has no bundled bwrap next to it', async () => {
		const dir = installDir('0.166.0');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, 'codex'), '#!old codex', { mode: 0o755 });
		serveRelease('0.166.0', [
			{ name: CODEX_ASSET, body: codexArchive },
			{ name: BWRAP_ASSET, body: bwrapArchive }
		]);

		await ensureBinary('0.166.0');

		expect(await fs.readFile(path.join(dir, 'codex-resources', 'bwrap'), 'utf-8')).toBe('#!bwrap for 0.166.0');
		expect(await fs.readFile(path.join(dir, 'codex'), 'utf-8')).toBe('#!codex 0.166.0');
	});

	it('replaces a bare binary cached by an older plugin release at the install-directory path', async () => {
		const legacyPath = installDir('0.166.0');
		await fs.mkdir(path.dirname(legacyPath), { recursive: true });
		await fs.writeFile(legacyPath, '#!legacy flat codex', { mode: 0o755 });
		serveRelease('0.166.0', [
			{ name: CODEX_ASSET, body: codexArchive },
			{ name: BWRAP_ASSET, body: bwrapArchive }
		]);

		const binaryPath = await ensureBinary('0.166.0');

		expect((await fs.stat(legacyPath)).isDirectory()).toBe(true);
		expect(await fs.readFile(binaryPath, 'utf-8')).toBe('#!codex 0.166.0');
	});

	describe('resolveExistingBinary', () => {
		it('finds a complete install', async () => {
			serveRelease('0.166.0', [
				{ name: CODEX_ASSET, body: codexArchive },
				{ name: BWRAP_ASSET, body: bwrapArchive }
			]);
			const binaryPath = await ensureBinary('0.166.0');

			await expect(resolveExistingBinary('0.166.0')).resolves.toBe(binaryPath);
		});

		it('still finds a bare binary cached by an older plugin release (used for codex login)', async () => {
			const legacyPath = installDir('0.166.0');
			await fs.mkdir(path.dirname(legacyPath), { recursive: true });
			await fs.writeFile(legacyPath, '#!legacy flat codex', { mode: 0o755 });

			await expect(resolveExistingBinary('0.166.0')).resolves.toBe(legacyPath);
		});

		it('answers null when nothing is installed and there is no system codex', async () => {
			await expect(resolveExistingBinary('0.166.0')).resolves.toBeNull();
		});
	});
});
