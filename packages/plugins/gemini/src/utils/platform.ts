import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { BASE_TEMP_DIR } from '../types.js';

export interface PlatformInfo {
	readonly os: 'linux' | 'darwin';
	readonly arch: 'x64' | 'arm64';
	readonly platformString: string;
	readonly isMusl: boolean;
}

/**
 * Detect whether the Linux system uses musl libc (e.g., Alpine).
 */
async function isMuslLinux(): Promise<boolean> {
	try {
		const libFiles = await fs.readdir('/lib').catch(() => []);
		if (libFiles.some((f) => f.startsWith('ld-musl'))) {
			return true;
		}

		const lddOutput = await fs.readFile('/usr/bin/ldd', 'utf-8').catch(() => '');
		return lddOutput.includes('musl');
	} catch {
		return false;
	}
}

/**
 * Detect the current platform and architecture.
 * Throws on unsupported OS (Windows) or architecture.
 */
export async function detectPlatform(): Promise<PlatformInfo> {
	const platform = os.platform();
	const arch = os.arch();

	if (platform === 'win32') {
		throw new Error('Gemini CLI is not supported on Windows');
	}

	if (platform !== 'linux' && platform !== 'darwin') {
		throw new Error(`Unsupported OS: ${platform}. Only Linux and macOS are supported.`);
	}

	if (arch !== 'x64' && arch !== 'arm64') {
		throw new Error(`Unsupported architecture: ${arch}. Only x64 and arm64 are supported.`);
	}

	const detectedOs = platform as 'linux' | 'darwin';
	const detectedArch = arch as 'x64' | 'arm64';
	const isMusl = detectedOs === 'linux' ? await isMuslLinux() : false;

	let platformString = `${detectedOs}-${detectedArch}`;
	if (isMusl) {
		platformString = `${detectedOs}-${detectedArch}-musl`;
	}

	return {
		os: detectedOs,
		arch: detectedArch,
		platformString,
		isMusl
	};
}

/**
 * Get the cached binary path for a given version and platform.
 */
export function getBinaryPath(version: string, platformString: string): string {
	return path.join(BASE_TEMP_DIR, 'bin', `gemini-${version}-${platformString}`);
}
