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

	const assetNameByPlatform: Record<string, string> = {
		'linux-x64': 'codex-x86_64-unknown-linux-gnu.tar.gz',
		'linux-x64-musl': 'codex-x86_64-unknown-linux-musl.tar.gz',
		'linux-arm64': 'codex-aarch64-unknown-linux-gnu.tar.gz',
		'linux-arm64-musl': 'codex-aarch64-unknown-linux-musl.tar.gz',
		'darwin-x64': 'codex-x86_64-apple-darwin.tar.gz',
		'darwin-arm64': 'codex-aarch64-apple-darwin.tar.gz'
	};

	const assetName = assetNameByPlatform[platformString];
	if (!assetName) {
		throw new Error(`No Codex release asset configured for platform ${platformString}.`);
	}

	return {
		os: detectedOs,
		arch: detectedArch,
		assetName,
		platformString,
		isMusl
	};
}

export function getBinaryPath(version: string, platformString: string): string {
	return path.join(BASE_TEMP_DIR, 'bin', `codex-${version}-${platformString}`);
}
