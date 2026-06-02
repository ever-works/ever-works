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

/**
 * Detect the current platform and architecture.
 * Throws on unsupported OS (Windows) or architecture.
 */
export async function detectPlatform(): Promise<PlatformInfo> {
	const platform = os.platform();
	const arch = os.arch();

	if (platform === 'win32') {
		throw new Error('OpenCode CLI is not supported on Windows');
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
	const binaryPath = path.join(BASE_TEMP_DIR, 'bin', `opencode-${version}-${platformString}`);
	// Security: defense-in-depth path confinement. `version` originates from tenant-supplied
	// plugin settings; although callers validate it against a semver pattern first, assert the
	// resolved path stays inside BASE_TEMP_DIR so a traversal payload (e.g. `../../etc/cron.d`)
	// can never point the binary cache / spawn target outside the temp dir. Legitimate values
	// like `opencode-v1.0.223-linux-x64` resolve well within the base and are unaffected.
	const resolvedBase = path.resolve(BASE_TEMP_DIR);
	const resolvedPath = path.resolve(binaryPath);
	if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + path.sep)) {
		throw new Error('Invalid OpenCode binary path: resolves outside the cache directory');
	}
	return binaryPath;
}
