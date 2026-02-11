import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { detectPlatform, getBinaryPath } from './platform.js';
import { CLAUDE_CODE_DIST_URL, DEFAULT_CLI_VERSION } from '../types.js';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

interface ManifestEntry {
	readonly binary: string;
	readonly checksum: string;
	readonly size?: number;
}

interface Manifest {
	readonly platforms: {
		readonly [platform: string]: ManifestEntry;
	};
}

/**
 * Follow redirects and fetch a URL, returning the response body as a Buffer.
 */
function fetchBuffer(url: string, maxRedirects = 5): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		if (maxRedirects <= 0) {
			reject(new Error('Too many redirects'));
			return;
		}

		const proto = url.startsWith('https') ? require('https') : require('http');
		proto
			.get(url, (res: import('http').IncomingMessage) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					fetchBuffer(res.headers.location, maxRedirects - 1).then(resolve, reject);
					return;
				}

				if (res.statusCode && res.statusCode !== 200) {
					reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
					return;
				}

				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => resolve(Buffer.concat(chunks)));
				res.on('error', reject);
			})
			.on('error', reject);
	});
}

/**
 * Fetch and parse the manifest.json for a given CLI version.
 */
async function fetchManifest(version: string): Promise<Manifest> {
	const url = `${CLAUDE_CODE_DIST_URL}/${version}/manifest.json`;
	const buffer = await fetchBuffer(url);
	return JSON.parse(buffer.toString('utf-8'));
}

/**
 * Verify the SHA256 checksum of a file.
 */
async function verifyChecksum(filePath: string, expectedSha256: string): Promise<boolean> {
	const fileBuffer = await fs.readFile(filePath);
	const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
	return hash === expectedSha256;
}

/**
 * Ensure the Claude Code CLI binary is available.
 * Downloads and caches if not already present.
 *
 * @returns Path to the executable binary
 */
export async function ensureBinary(version: string = DEFAULT_CLI_VERSION, logger?: Logger): Promise<string> {
	const platform = await detectPlatform();
	const binaryPath = getBinaryPath(version, platform.platformString);

	// Check if binary already exists and is executable
	try {
		await fs.access(binaryPath, fs.constants.X_OK);
		logger?.debug(`Binary already cached at ${binaryPath}`);
		return binaryPath;
	} catch {
		// Binary doesn't exist or isn't executable, proceed with download
	}

	// Ensure bin directory exists
	const binDir = path.dirname(binaryPath);
	await fs.mkdir(binDir, { recursive: true });

	// Fetch manifest for checksum verification
	logger?.log(`Fetching manifest for Claude Code v${version}...`);
	const manifest = await fetchManifest(version);

	const manifestEntry = manifest.platforms[platform.platformString];
	if (!manifestEntry) {
		throw new Error(
			`No binary available for platform ${platform.platformString} in Claude Code v${version}. ` +
				`Available platforms: ${Object.keys(manifest).join(', ')}`
		);
	}

	// Download binary
	const binaryUrl = `${CLAUDE_CODE_DIST_URL}/${version}/${platform.platformString}/${manifestEntry.binary}`;
	logger?.log(`Downloading Claude Code CLI from ${binaryUrl}...`);
	const binaryBuffer = await fetchBuffer(binaryUrl);

	// Write to temp file first, then rename (atomic-ish)
	const tmpPath = `${binaryPath}.tmp`;
	await fs.writeFile(tmpPath, binaryBuffer);

	// Verify checksum
	const checksumValid = await verifyChecksum(tmpPath, manifestEntry.checksum);
	if (!checksumValid) {
		await fs.unlink(tmpPath).catch(() => {});
		throw new Error(
			`Checksum mismatch for Claude Code v${version} (${platform.platformString}). ` +
				`The download may be corrupted.`
		);
	}

	// Make executable and move into place
	await fs.chmod(tmpPath, 0o755);
	await fs.rename(tmpPath, binaryPath);

	logger?.log(`Claude Code CLI v${version} ready at ${binaryPath}`);
	return binaryPath;
}
