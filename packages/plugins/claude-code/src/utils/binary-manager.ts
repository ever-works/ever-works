import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { detectPlatform, getBinaryPath } from './platform.js';
import { BASE_TEMP_DIR, CLAUDE_CODE_DIST_URL, DEFAULT_CLI_VERSION } from '../types.js';

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

// Security: the CLI `version` originates from a user-configurable plugin setting
// (`settings.version`) and is interpolated unvalidated into both filesystem paths
// (getBinaryPath -> path.join(BASE_TEMP_DIR, 'bin', `claude-${version}-...`)) and the
// manifest/binary download URLs. A value containing `../` (e.g. `../../usr/local/bin/evil`)
// would let an authenticated tenant escape BASE_TEMP_DIR when writing/chmod'ing the binary,
// and could rewrite the fetch URL. Enforce a strict semver allowlist before the value is
// ever used so only genuine release identifiers (e.g. `2.1.76`) are accepted.
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function assertSafeVersion(version: string): void {
	if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
		throw new Error(
			`Invalid Claude Code CLI version "${version}". Expected a semantic version like "2.1.76".`
		);
	}
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
					// Security: the binary integrity gate trusts the SHA256 checksum that travels in
					// manifest.json over this same channel, so a redirect that downgrades to plaintext
					// HTTP would let a MITM swap in a trojaned binary together with a matching checksum.
					// Resolve the Location against the current URL and refuse to follow anything that is
					// not https — never fall back to the `http` module after a redirect.
					let redirectUrl: string;
					try {
						redirectUrl = new URL(res.headers.location, url).toString();
					} catch {
						reject(new Error(`Invalid redirect location while fetching ${url}`));
						return;
					}
					if (!redirectUrl.startsWith('https:')) {
						reject(new Error(`Refusing to follow non-https redirect to ${redirectUrl}`));
						return;
					}
					fetchBuffer(redirectUrl, maxRedirects - 1).then(resolve, reject);
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
	// Security: reject any version that is not a strict semver before building the fetch URL.
	assertSafeVersion(version);
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
	// Security: validate the user-supplied version before it reaches any path/URL construction.
	assertSafeVersion(version);

	const platform = await detectPlatform();
	const binaryPath = getBinaryPath(version, platform.platformString);

	// Security: defense-in-depth — assert the resolved cache path stays inside BASE_TEMP_DIR so
	// that even an unexpected platformString/version combination cannot escape the cache dir for
	// the write/chmod/rename below.
	const baseBinDir = path.resolve(BASE_TEMP_DIR, 'bin');
	const resolvedBinaryPath = path.resolve(binaryPath);
	if (resolvedBinaryPath !== baseBinDir && !resolvedBinaryPath.startsWith(baseBinDir + path.sep)) {
		throw new Error(`Refusing to use binary path outside ${baseBinDir}: ${resolvedBinaryPath}`);
	}

	// Check if binary already exists and is executable
	try {
		await fs.access(binaryPath, fs.constants.X_OK);
		logger?.debug(`Binary already cached at ${binaryPath}`);
		return binaryPath;
	} catch {
		// Binary doesn't exist or isn't executable, proceed with download
	}

	// Ensure bin work exists
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
