import { beforeEach, describe, expect, it, vi } from 'vitest';

const { platformMock, archMock, readdirMock, readFileMock } = vi.hoisted(() => ({
	platformMock: vi.fn(),
	archMock: vi.fn(),
	readdirMock: vi.fn(),
	readFileMock: vi.fn()
}));

vi.mock('os', () => {
	const mocked = { platform: platformMock, arch: archMock };
	return { ...mocked, default: mocked };
});

vi.mock('fs/promises', () => {
	const mocked = { readdir: readdirMock, readFile: readFileMock };
	return { ...mocked, default: mocked };
});

import { detectPlatform, getBinaryPath, getInstallDir } from '../utils/platform.js';

/**
 * openai/codex stopped publishing `*-unknown-linux-gnu` release assets in 0.128.0 (#19445);
 * every release since then ships Linux builds as static musl binaries only, so a glibc host
 * must download the musl archive or the pinned CLI cannot be installed at all.
 * https://github.com/openai/codex/releases (checked 2026-11-05).
 */
function host(os: 'linux' | 'darwin', arch: 'x64' | 'arm64', libc: 'glibc' | 'musl' | 'none'): void {
	platformMock.mockReturnValue(os);
	archMock.mockReturnValue(arch);
	readdirMock.mockResolvedValue(libc === 'musl' ? ['ld-musl-x86_64.so.1'] : ['libc.so.6']);
	readFileMock.mockResolvedValue(libc === 'musl' ? 'musl libc' : 'GNU C Library');
}

describe('codex platform → release asset mapping', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		['x64', 'codex-x86_64-unknown-linux-musl.tar.gz'],
		['arm64', 'codex-aarch64-unknown-linux-musl.tar.gz']
	] as const)('maps glibc Linux %s to the static musl asset', async (arch, assetName) => {
		host('linux', arch, 'glibc');
		const info = await detectPlatform();
		expect(info.isMusl).toBe(false);
		expect(info.platformString).toBe(`linux-${arch}`);
		expect(info.assetName).toBe(assetName);
	});

	it.each([
		['x64', 'codex-x86_64-unknown-linux-musl.tar.gz'],
		['arm64', 'codex-aarch64-unknown-linux-musl.tar.gz']
	] as const)('keeps musl Linux %s on the musl asset', async (arch, assetName) => {
		host('linux', arch, 'musl');
		const info = await detectPlatform();
		expect(info.isMusl).toBe(true);
		expect(info.platformString).toBe(`linux-${arch}-musl`);
		expect(info.assetName).toBe(assetName);
	});

	it.each([
		['x64', 'codex-x86_64-apple-darwin.tar.gz'],
		['arm64', 'codex-aarch64-apple-darwin.tar.gz']
	] as const)('keeps macOS %s on the apple-darwin asset', async (arch, assetName) => {
		host('darwin', arch, 'none');
		expect((await detectPlatform()).assetName).toBe(assetName);
	});

	// Since rust-v0.129.0 the Linux binary no longer compiles bubblewrap in: its sandbox looks for
	// `codex-resources/bwrap` next to the executable, published as a separate release asset.
	it.each([
		['x64', 'glibc', 'bwrap-x86_64-unknown-linux-musl.tar.gz'],
		['x64', 'musl', 'bwrap-x86_64-unknown-linux-musl.tar.gz'],
		['arm64', 'glibc', 'bwrap-aarch64-unknown-linux-musl.tar.gz'],
		['arm64', 'musl', 'bwrap-aarch64-unknown-linux-musl.tar.gz']
	] as const)('names the bubblewrap asset for %s Linux (%s)', async (arch, libc, bwrapAssetName) => {
		host('linux', arch, libc);
		expect((await detectPlatform()).bwrapAssetName).toBe(bwrapAssetName);
	});

	it('names no bubblewrap asset on macOS', async () => {
		host('darwin', 'arm64', 'none');
		expect((await detectPlatform()).bwrapAssetName).toBeUndefined();
	});

	it('installs each CLI version into its own directory, binary at <dir>/codex', () => {
		const installDir = getInstallDir('0.166.0', 'linux-x64');
		expect(installDir.replace(/\\/g, '/')).toBe('/tmp/codex-generator/bin/codex-0.166.0-linux-x64');
		expect(getBinaryPath('0.166.0', 'linux-x64').replace(/\\/g, '/')).toBe(
			'/tmp/codex-generator/bin/codex-0.166.0-linux-x64/codex'
		);
		expect(getInstallDir('0.165.0', 'linux-x64')).not.toBe(installDir);
	});

	it('never resolves a linux-gnu asset, which current releases do not publish', async () => {
		for (const arch of ['x64', 'arm64'] as const) {
			for (const libc of ['glibc', 'musl'] as const) {
				host('linux', arch, libc);
				expect((await detectPlatform()).assetName).not.toContain('linux-gnu');
			}
		}
	});
});
