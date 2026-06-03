import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { spawn } from 'child_process';
import * as tar from 'tar';

import { DEFAULT_CLI_VERSION } from '../types.js';
import { detectPlatform, getBinaryPath } from './platform.js';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	warn?(message: string, ...args: unknown[]): void;
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

// Security: the Codex repo whose releases we download, install, chmod 0755 and execute as a
// native subprocess. Pinned here so the GitHub API and asset hosts can be allowlisted; the
// existing CODEX_RELEASES_URL already targets this same repo.
const CODEX_GITHUB_REPO = 'openai/codex';

// Security: the release JSON, the archive, and any .sha256 asset are downloaded over the
// network and then extracted/chmod'd/executed. Restrict every fetch to https on
// GitHub-controlled hosts so a spoofed redirect / poisoned browser_download_url cannot point
// us at an internal metadata endpoint (SSRF, e.g. 169.254.169.254) or an attacker-hosted
// artifact. Mirrors the opencode binary-manager allowlist.
const ALLOWED_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
	'api.github.com',
	'github.com',
	'objects.githubusercontent.com',
	'release-assets.githubusercontent.com',
	'codeload.github.com'
]);

// Security: cap the in-memory download size so a compromised CDN / MITM serving an unbounded
// (or chunked-infinite) response cannot OOM the API process. 500 MB is far above any real
// Codex archive (tens of MB) yet bounds heap growth in fetchBuffer.
const FETCH_MAX_BYTES = 500 * 1024 * 1024;

function assertAllowedDownloadUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid Codex download URL: ${url}`);
	}
	if (parsed.protocol !== 'https:') {
		throw new Error(`Refusing non-https Codex download URL: ${url}`);
	}
	if (!ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
		throw new Error(`Refusing Codex download from disallowed host: ${parsed.hostname}`);
	}
	return parsed;
}

async function canExecute(command: string): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, ['--version'], {
			stdio: ['ignore', 'ignore', 'pipe']
		});

		let stderr = '';
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf-8');
		});

		child.on('error', (error) => {
			resolve({ ok: false, error: error.message });
		});

		child.on('exit', (code) => {
			resolve({
				ok: code === 0,
				error: code === 0 ? undefined : stderr.trim() || `codex exited with code ${code}`
			});
		});
	});
}

function fetchBuffer(url: string, maxRedirects = 5): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		if (maxRedirects <= 0) {
			reject(new Error('Too many redirects'));
			return;
		}

		// Security: the codex archive is chmod'd and executed as a native subprocess, so its
		// integrity rests on TLS + the SHA-256 verification below. Enforce https + the GitHub
		// host allowlist on every hop. Because redirects recurse into fetchBuffer, validating
		// here also gates redirect targets, blocking SSRF/open-redirect to internal/metadata
		// IPs and downgrade-to-http MITM. Never fall back to the `http` module after a redirect.
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
					// Security: GitHub's REST API rejects requests without a User-Agent.
					'user-agent': 'ever-works-codex-plugin'
				}
			},
			(res: http.IncomingMessage) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume(); // drain so the socket is released before following the redirect
					// Security: resolve relative redirects against the current URL so the allowlist
					// check in the recursive call sees an absolute URL; the recursive
					// assertAllowedDownloadUrl still re-validates it.
					let redirectUrl: string;
					try {
						redirectUrl = new URL(res.headers.location, url).toString();
					} catch {
						reject(new Error(`Invalid redirect location while fetching ${url}`));
						return;
					}
					fetchBuffer(redirectUrl, maxRedirects - 1).then(resolve, reject);
					return;
				}

				if (res.statusCode && res.statusCode !== 200) {
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

		req.on('error', reject);
	});
}

async function fetchRelease(version: string): Promise<ReleaseResponse> {
	const releaseTag = `rust-v${version}`;
	const url = `https://api.github.com/repos/${CODEX_GITHUB_REPO}/releases/tags/${releaseTag}`;
	const buffer = await fetchBuffer(url);
	return JSON.parse(buffer.toString('utf-8')) as ReleaseResponse;
}

async function verifySha256(filePath: string, checksum: string): Promise<boolean> {
	const file = await fs.readFile(filePath);
	return createHash('sha256').update(file).digest('hex') === checksum;
}

// Security: resolve the SHA-256 for the archive from the GitHub release metadata. Prefer the
// asset's own `digest` (sha256:...) field; fall back to a sibling `${assetName}.sha256` asset.
// Returns null when no checksum is published so the caller can fail closed.
async function resolveChecksum(assets: readonly ReleaseAsset[], assetName: string): Promise<string | null> {
	const archiveAsset = assets.find((asset) => asset.name === assetName);
	const digest = archiveAsset?.digest?.trim();
	if (digest?.startsWith('sha256:')) {
		return digest.slice('sha256:'.length);
	}

	const checksumAsset = assets.find((asset) => asset.name === `${assetName}.sha256`);
	if (!checksumAsset) {
		return null;
	}

	const checksumText = (await fetchBuffer(checksumAsset.browser_download_url)).toString('utf-8').trim();
	return checksumText.split(/\s+/u)[0] || null;
}

async function extractTarGz(archivePath: string, outputDir: string): Promise<void> {
	const root = path.resolve(outputDir);
	await tar.x({
		file: archivePath,
		cwd: outputDir,
		// Security: tar zip-slip guard — drop any entry that resolves outside outputDir. The
		// archive is downloaded over the network, so a compromised release could embed
		// `../../etc/cron.d/evil` to write outside tempDir.
		filter: (entryPath: string) => {
			const resolved = path.resolve(root, entryPath);
			return resolved === root || resolved.startsWith(root + path.sep);
		}
	});
}

async function findBinary(rootDir: string, binaryName: string): Promise<string | null> {
	const entries = await fs.readdir(rootDir, { withFileTypes: true });
	for (const entry of entries) {
		const candidate = path.join(rootDir, entry.name);
		if (
			entry.isFile() &&
			(entry.name === binaryName ||
				entry.name === path.basename(binaryName) ||
				entry.name.startsWith(`${binaryName}-`))
		) {
			return candidate;
		}
		if (entry.isDirectory()) {
			const nested = await findBinary(candidate, binaryName);
			if (nested) {
				return nested;
			}
		}
	}

	return null;
}

export async function ensureBinary(version: string = DEFAULT_CLI_VERSION, logger?: Logger): Promise<string> {
	const platform = await detectPlatform();
	const binaryPath = getBinaryPath(version, platform.platformString);

	try {
		await fs.access(binaryPath, fs.constants.X_OK);
		const cachedBinary = await canExecute(binaryPath);
		if (cachedBinary.ok) {
			logger?.debug(`Codex binary already cached at ${binaryPath}`);
			return binaryPath;
		}

		logger?.warn?.(`Cached Codex binary at ${binaryPath} is not runnable: ${cachedBinary.error}`);
	} catch {
		// continue with download
	}

	await fs.mkdir(path.dirname(binaryPath), { recursive: true });

	// Security: resolve the release via the GitHub API so we can obtain the published SHA-256
	// for the asset and verify integrity before installing. The archive was previously fetched
	// from a constructed download URL and executed with ZERO integrity check, so a MITM /
	// compromised release could ship a trojaned binary that we chmod'd and ran as a subprocess.
	logger?.log(`Resolving Codex CLI ${version} release from GitHub...`);
	const release = await fetchRelease(version);
	const archiveAsset = release.assets.find((asset) => asset.name === platform.assetName);
	if (!archiveAsset) {
		throw new Error(
			`No Codex release asset named ${platform.assetName} found for ${release.tag_name}. ` +
				`Check the upstream release assets for supported platforms.`
		);
	}

	logger?.log(`Downloading Codex CLI ${version} from ${archiveAsset.browser_download_url}...`);
	const archiveBuffer = await fetchBuffer(archiveAsset.browser_download_url);
	const tempDir = await fs.mkdtemp(path.join(path.dirname(binaryPath), 'codex-download-'));
	try {
		const archivePath = path.join(tempDir, platform.assetName);
		await fs.writeFile(archivePath, archiveBuffer);

		// Security: fail closed when no checksum is available, and reject any mismatch BEFORE
		// extracting/chmod/copy/exec. Mirrors the opencode binary-manager: a MITM / compromised
		// release that omits the digest and .sha256 asset, or swaps the archive, cannot get a
		// trojaned binary installed and executed. Hosts where the GitHub API is unreachable
		// degrade to the system `codex` on PATH below, exactly as a network failure does today.
		const checksum = await resolveChecksum(release.assets, platform.assetName);
		if (!checksum) {
			throw new Error(
				`No checksum (digest or .sha256 asset) found for Codex ${release.tag_name} (${platform.assetName}); ` +
					`refusing to install an unverified binary.`
			);
		}
		const valid = await verifySha256(archivePath, checksum);
		if (!valid) {
			throw new Error(`Checksum mismatch for Codex ${release.tag_name} (${platform.assetName})`);
		}

		await extractTarGz(archivePath, tempDir);

		const extractedBinary = await findBinary(tempDir, 'codex');
		if (!extractedBinary) {
			throw new Error(`Downloaded Codex archive did not contain a codex binary for ${platform.platformString}.`);
		}

		await fs.chmod(extractedBinary, 0o755);
		await fs.copyFile(extractedBinary, binaryPath);
		await fs.chmod(binaryPath, 0o755);

		const downloadedBinary = await canExecute(binaryPath);
		if (downloadedBinary.ok) {
			logger?.log(`Codex CLI ${version} ready at ${binaryPath}`);
			return binaryPath;
		}

		logger?.warn?.(
			`Downloaded Codex binary at ${binaryPath} is not runnable on this host: ${downloadedBinary.error}`
		);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}

	const systemBinary = await canExecute('codex');
	if (systemBinary.ok) {
		logger?.log('Using system Codex CLI from PATH because the managed release binary is not compatible.');
		return 'codex';
	}

	throw new Error(
		`Failed to resolve a runnable Codex CLI. System codex error: ${systemBinary.error ?? 'unavailable'}`
	);
}

export async function resolveExistingBinary(version: string = DEFAULT_CLI_VERSION): Promise<string | null> {
	const platform = await detectPlatform();
	const binaryPath = getBinaryPath(version, platform.platformString);

	try {
		await fs.access(binaryPath, fs.constants.X_OK);
		const cachedBinary = await canExecute(binaryPath);
		if (cachedBinary.ok) {
			return binaryPath;
		}
	} catch {
		// No cached binary available.
	}

	const systemBinary = await canExecute('codex');
	return systemBinary.ok ? 'codex' : null;
}
