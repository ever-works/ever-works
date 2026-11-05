import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';

import { BASE_TEMP_DIR } from '../types.js';

export interface PlatformInfo {
	readonly os: 'linux' | 'darwin';
	readonly arch: 'x64' | 'arm64';
	readonly assetName: string;
	readonly platformString: string;
	readonly isMusl: boolean;
	/**
	 * Release asset with the bubblewrap helper that the Linux sandbox execs (Linux only). Since
	 * rust-v0.129.0 Codex no longer compiles bubblewrap in; it looks for `codex-resources/bwrap`
	 * next to the executable when no system `bwrap` is on PATH.
	 */
	readonly bwrapAssetName?: string;
}

async function isMuslLinux(): Promise<boolean> {
	try {
		const libFiles = await fs.readdir('/lib').catch(() => [] as string[]);
		if (libFiles.some((f) => f.startsWith('ld-musl'))) {
			return true;
		}
		const lddOutput = await fs.readFile('/usr/bin/ldd', 'utf-8').catch(() => '');
		return lddOutput.includes('musl');
	} catch {
		return false;
	}
}

export async function detectPlatform(): Promise<PlatformInfo> {
	const platform = os.platform();
	const arch = os.arch();

	if (platform !== 'linux' && platform !== 'darwin') {
		throw new Error(`Unsupported OS: ${platform}. Only Linux and macOS are supported.`);
	}

	if (arch !== 'x64' && arch !== 'arm64') {
		throw new Error(`Unsupported architecture: ${arch}. Only x64 and arm64 are supported.`);
	}

	const detectedOs = platform as 'linux' | 'darwin';
	const detectedArch = arch as 'x64' | 'arm64';
	const isMusl = detectedOs === 'linux' ? await isMuslLinux() : false;
	const platformString = isMusl ? `${detectedOs}-${detectedArch}-musl` : `${detectedOs}-${detectedArch}`;

	// openai/codex stopped publishing `*-unknown-linux-gnu` assets in 0.128.0 (#19445); since
	// then every release ships Linux only as static musl binaries, which also run on glibc
	// hosts. So both Linux flavours map to the musl archive. The platform string still tells
	// them apart, which keeps their cached binaries in separate paths.
	const assetNameByPlatform: Record<string, string> = {
		'linux-x64': 'codex-x86_64-unknown-linux-musl.tar.gz',
		'linux-x64-musl': 'codex-x86_64-unknown-linux-musl.tar.gz',
		'linux-arm64': 'codex-aarch64-unknown-linux-musl.tar.gz',
		'linux-arm64-musl': 'codex-aarch64-unknown-linux-musl.tar.gz',
		'darwin-x64': 'codex-x86_64-apple-darwin.tar.gz',
		'darwin-arm64': 'codex-aarch64-apple-darwin.tar.gz'
	};

	const assetName = assetNameByPlatform[platformString];
	if (!assetName) {
		throw new Error(`No Codex release asset configured for platform ${platformString}.`);
	}

	const bwrapAssetName =
		detectedOs === 'linux'
			? `bwrap-${detectedArch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl.tar.gz`
			: undefined;

	return {
		os: detectedOs,
		arch: detectedArch,
		assetName,
		platformString,
		isMusl,
		bwrapAssetName
	};
}

/**
 * Per-version install directory: `<bin>/codex-<version>-<platform>/`, holding `codex` and, on
 * Linux, `codex-resources/bwrap`. Each version keeps its own bwrap because the codex binary
 * checks it against the sha256 it was built with. (Before 2026-11-06 the binary itself was
 * cached as a bare file at this path; the binary-manager replaces such a file.)
 */
export function getInstallDir(version: string, platformString: string): string {
	return path.join(BASE_TEMP_DIR, 'bin', `codex-${version}-${platformString}`);
}

export function getBinaryPath(version: string, platformString: string): string {
	return path.join(getInstallDir(version, platformString), 'codex');
}
