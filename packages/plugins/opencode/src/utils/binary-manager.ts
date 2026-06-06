import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { createHash } from 'node:crypto';
import extractZip from 'extract-zip';
import * as tar from 'tar';
import { detectPlatform, getBinaryPath } from './platform.js';
import { DEFAULT_CLI_VERSION, OPENCODE_GITHUB_REPO } from '../types.js';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

interface ReleaseAsset {
	readonly name: string;
	readonly browser_download_url: string;
	readonly digest?: string;
}

interface ReleaseResponse {
	readonly tag_name: string;
	readonly assets: readonly ReleaseAsset[];
}

/** Socket idle timeout (ms). Resets on activity, so it's safe for large downloads on slow links. */
const FETCH_SOCKET_IDLE_TIMEOUT_MS = 60_000;

// Security: cap the in-memory download size so a compromised CDN / MITM serving an
// unbounded (or chunked-infinite) response cannot OOM the API process. 500 MB is far
// above any real OpenCode archive (tens of MB) yet bounds heap growth in fetchBuffer.
const FETCH_MAX_BYTES = 500 * 1024 * 1024;

// Security: the binary archive + checksum are downloaded over the network and then
// extracted/chmod'd/executed as a native subprocess. Restrict every fetch (the GitHub
// API release JSON, the archive, and the .sha256) to https on GitHub-controlled hosts so
// a spoofed redirect / poisoned browser_download_url cannot point us at an internal
// metadata endpoint (SSRF, e.g. 169.254.169.254) or an attacker-hosted artifact.
const ALLOWED_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
	'api.github.com',
	'github.com',
	'objects.githubusercontent.com',
	'release-assets.githubusercontent.com',
	'codeload.github.com'
]);

// Security: the OpenCode CLI `version` is operator/tenant-supplied plugin settings
// (settings.version) and is interpolated into both the GitHub release URL and the cached
// binary's on-disk path (getBinaryPath -> path.join). Restrict it to a semver-like token
// (optional leading `v`, optional pre-release/build suffix) so values such as
// `../../etc/cron.d` cannot traverse out of the cache dir or inject into the URL.
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

function assertAllowedDownloadUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid OpenCode download URL: ${url}`);
	}
	if (parsed.protocol !== 'https:') {
		throw new Error(`Refusing non-https OpenCode download URL: ${url}`);
	}
	if (!ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
		throw new Error(`Refusing OpenCode download from disallowed host: ${parsed.hostname}`);
	}
	return parsed;
}

function fetchBuffer(url: string, maxRedirects = 5, signal?: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		if (maxRedirects <= 0) {
			reject(new Error('Too many redirects'));
			return;
		}
		if (signal?.aborted) {
			reject(new Error('Aborted'));
			return;
		}

		// Security: enforce https + GitHub host allowlist on every hop. Because redirects are
		// followed by recursing into fetchBuffer, validating here also gates redirect targets,
		// blocking SSRF/open-redirect to internal or metadata IPs and downgrade-to-http MITM.
		let parsed: URL;
		try {
			parsed = assertAllowedDownloadUrl(url);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		const client = parsed.protocol === 'https:' ? https : http;
		const req = client.get(
			url,
			{
				headers: {
					'user-agent': 'ever-works-opencode-plugin'
				}
			},
			(res) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume(); // drain so the socket is released before following the redirect
					// Security: resolve relative redirects against the current URL so the allowlist
					// check in the recursive call sees an absolute URL (a bare path would otherwise
					// throw as "invalid"); the recursive assertAllowedDownloadUrl still re-validates it.
					let redirectUrl: string;
					try {
						redirectUrl = new URL(res.headers.location, url).toString();
					} catch {
						reject(new Error(`Invalid redirect location while fetching ${url}`));
						return;
					}
					fetchBuffer(redirectUrl, maxRedirects - 1, signal).then(resolve, reject);
					return;
				}

				if ((res.statusCode || 500) >= 400) {
					res.resume();
					reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
					return;
				}

				// Security: bound accumulated bytes to prevent unbounded heap growth (DoS/OOM)
				// from a malicious/compromised server streaming an arbitrarily large response.
				const chunks: Buffer[] = [];
				let total = 0;
				res.on('data', (chunk: Buffer) => {
					total += chunk.length;
					if (total > FETCH_MAX_BYTES) {
						req.destroy(new Error(`Response exceeded ${FETCH_MAX_BYTES} bytes fetching ${url}`));
						return;
					}
					chunks.push(chunk);
				});
				res.on('end', () => resolve(Buffer.concat(chunks)));
				res.on('error', reject);
			}
		);

		req.setTimeout(FETCH_SOCKET_IDLE_TIMEOUT_MS, () => {
			req.destroy(new Error(`Request timed out after ${FETCH_SOCKET_IDLE_TIMEOUT_MS}ms of inactivity: ${url}`));
		});
		req.on('error', reject);

		if (signal) {
			const onAbort = () => req.destroy(new Error('Aborted'));
			signal.addEventListener('abort', onAbort, { once: true });
			req.on('close', () => signal.removeEventListener('abort', onAbort));
		}
	});
}

async function fetchRelease(version: string, signal?: AbortSignal): Promise<ReleaseResponse> {
	const normalizedVersion = version.startsWith('v') ? version : `v${version}`;
	const url = `https://api.github.com/repos/${OPENCODE_GITHUB_REPO}/releases/tags/${normalizedVersion}`;
	const buffer = await fetchBuffer(url, 5, signal);
	return JSON.parse(buffer.toString('utf-8')) as ReleaseResponse;
}

function getArchiveName(platformString: string): string {
	switch (platformString) {
		case 'darwin-arm64':
			return 'opencode-darwin-arm64.zip';
		case 'darwin-x64':
			return 'opencode-darwin-x64.zip';
		case 'linux-arm64':
			return 'opencode-linux-arm64.tar.gz';
		case 'linux-arm64-musl':
			return 'opencode-linux-arm64-musl.tar.gz';
		case 'linux-x64':
			return 'opencode-linux-x64.tar.gz';
		case 'linux-x64-musl':
			return 'opencode-linux-x64-musl.tar.gz';
		case 'windows-x64':
			return 'opencode-windows-x64.zip';
		default:
			throw new Error(`Unsupported OpenCode binary platform: ${platformString}`);
	}
}

async function verifySha256(filePath: string, checksum: string): Promise<boolean> {
	const file = await fs.readFile(filePath);
	return createHash('sha256').update(file).digest('hex') === checksum;
}

// Security: reject any archive entry whose resolved destination escapes the extraction
// directory (zip-slip / tar path traversal). The archive is downloaded over the network,
// so a compromised release could embed `../../etc/cron.d/evil` to write outside tempDir.
function isPathWithin(outputDir: string, entryName: string): boolean {
	const root = path.resolve(outputDir);
	const resolved = path.resolve(root, entryName);
	return resolved === root || resolved.startsWith(root + path.sep);
}

async function unzipArchive(archivePath: string, outputDir: string): Promise<void> {
	const root = path.resolve(outputDir);
	await extractZip(archivePath, {
		dir: outputDir,
		// Security: defense-in-depth zip-slip guard (does not rely solely on extract-zip's
		// internal confinement, which could regress on a downgrade).
		onEntry: (entry) => {
			if (!isPathWithin(root, entry.fileName)) {
				throw new Error(`Refusing to extract path-traversing zip entry: ${entry.fileName}`);
			}
		}
	});
}

async function extractTarGzArchive(archivePath: string, outputDir: string): Promise<void> {
	const root = path.resolve(outputDir);
	await tar.x({
		file: archivePath,
		cwd: outputDir,
		// Security: tar zip-slip guard — drop any entry that resolves outside outputDir.
		filter: (entryPath: string) => isPathWithin(root, entryPath)
	});
}

async function extractArchive(archivePath: string, outputDir: string): Promise<void> {
	if (archivePath.endsWith('.zip')) {
		await unzipArchive(archivePath, outputDir);
		return;
	}

	if (archivePath.endsWith('.tar.gz')) {
		await extractTarGzArchive(archivePath, outputDir);
		return;
	}

	throw new Error(`Unsupported OpenCode archive format: ${path.basename(archivePath)}`);
}

async function resolveChecksum(
	assets: readonly ReleaseAsset[],
	archiveName: string,
	signal?: AbortSignal
): Promise<string | null> {
	const archiveAsset = assets.find((asset) => asset.name === archiveName);
	const digest = archiveAsset?.digest?.trim();
	if (digest?.startsWith('sha256:')) {
		return digest.slice('sha256:'.length);
	}

	const checksumAsset = assets.find((asset) => asset.name === `${archiveName}.sha256`);
	if (!checksumAsset) {
		return null;
	}

	const checksumText = (await fetchBuffer(checksumAsset.browser_download_url, 5, signal)).toString('utf-8').trim();
	return checksumText.split(/\s+/u)[0] || null;
}

export async function ensureBinary(
	version: string = DEFAULT_CLI_VERSION,
	logger?: Logger,
	signal?: AbortSignal
): Promise<string> {
	// Security: validate the operator/tenant-supplied version before it is interpolated into
	// the GitHub release URL and the on-disk cache path. Rejects path-traversal / injection
	// payloads (e.g. `../../etc/cron.d`) while accepting normal semver tags like `v1.0.223`.
	if (!VERSION_PATTERN.test(version)) {
		throw new Error(`Invalid OpenCode CLI version: ${version}`);
	}

	const platform = await detectPlatform();
	const binaryPath = getBinaryPath(version, platform.platformString);

	try {
		await fs.access(binaryPath, fs.constants.X_OK);
		logger?.debug(`Binary already cached at ${binaryPath}`);
		return binaryPath;
	} catch {
		// Download below.
	}

	const binDir = path.dirname(binaryPath);
	await fs.mkdir(binDir, { recursive: true });

	logger?.log(`Resolving OpenCode release ${version} from GitHub...`);
	const release = await fetchRelease(version, signal);
	const archiveName = getArchiveName(platform.platformString);
	const archiveAsset = release.assets.find((asset) => asset.name === archiveName);

	if (!archiveAsset) {
		throw new Error(
			`No OpenCode release asset named ${archiveName} found for ${release.tag_name}. ` +
				`Check the upstream release assets for supported platforms.`
		);
	}

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-download-'));
	const archivePath = path.join(tempDir, archiveName);

	try {
		logger?.log(`Downloading OpenCode CLI from ${archiveAsset.browser_download_url}...`);
		const archiveBuffer = await fetchBuffer(archiveAsset.browser_download_url, 5, signal);
		await fs.writeFile(archivePath, archiveBuffer);

		// Security: fail closed when no checksum is available. Previously this logged a warning
		// and installed/executed the downloaded native binary with no integrity check, so a
		// MITM / compromised release that omits the digest and .sha256 asset could ship a
		// trojaned binary that is then chmod'd and run as a subprocess. Refuse to proceed.
		const checksum = await resolveChecksum(release.assets, archiveName, signal);
		if (!checksum) {
			throw new Error(
				`No checksum (digest or .sha256 asset) found for OpenCode ${release.tag_name} (${archiveName}); ` +
					`refusing to install an unverified binary.`
			);
		}
		const valid = await verifySha256(archivePath, checksum);
		if (!valid) {
			throw new Error(`Checksum mismatch for OpenCode ${release.tag_name} (${archiveName})`);
		}

		await extractArchive(archivePath, tempDir);

		const extractedBinaryPath = path.join(tempDir, 'opencode');
		await fs.access(extractedBinaryPath, fs.constants.X_OK);
		await fs.copyFile(extractedBinaryPath, binaryPath);
		await fs.chmod(binaryPath, 0o755);

		logger?.log(`OpenCode CLI ${release.tag_name} ready at ${binaryPath}`);
		return binaryPath;
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}
