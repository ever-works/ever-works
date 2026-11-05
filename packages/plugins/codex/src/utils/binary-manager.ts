import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { spawn } from 'child_process';
import * as tar from 'tar';

import { DEFAULT_CLI_VERSION } from '../types.js';
import { detectPlatform, getBinaryPath, type PlatformInfo } from './platform.js';

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

/**
 * Since rust-v0.129.0 the Linux build no longer compiles bubblewrap in (rust-v0.128.0 still
 * shipped `vendored_bwrap.rs`). `codex-rs/linux-sandbox` now execs a system `bwrap` from PATH or
 * the bundled `codex-resources/bwrap` next to the executable, checked against a sha256 compiled
 * into codex (`CODEX_BWRAP_SHA256`); with neither it panics "bubblewrap is unavailable". Each
 * release publishes it as `bwrap-<target>.tar.gz`. Verified at tags rust-v0.128.0, rust-v0.129.0
 * and rust-v0.166.0 on 2026-11-06.
 */
const FIRST_VERSION_WITH_SEPARATE_BWRAP: readonly [number, number, number] = [0, 129, 0];

/** Whether this version, on this platform, needs the bundled bwrap installed next to it. */
function needsBundledBwrap(version: string, platform: PlatformInfo): boolean {
	if (!platform.bwrapAssetName) {
		return false;
	}
	const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
	if (!match) {
		// Unknown version shape: require bwrap, so a release without it fails closed.
		return true;
	}
	const parts = match.slice(1, 4).map(Number);
	for (let index = 0; index < FIRST_VERSION_WITH_SEPARATE_BWRAP.length; index++) {
		if (parts[index] !== FIRST_VERSION_WITH_SEPARATE_BWRAP[index]) {
			return parts[index] > FIRST_VERSION_WITH_SEPARATE_BWRAP[index];
		}
	}
	return true;
}

/** `<install dir>/codex-resources/bwrap`, the first place codex looks for its bundled bwrap. */
function bundledBwrapPath(binaryPath: string): string {
	return path.join(path.dirname(binaryPath), 'codex-resources', 'bwrap');
}

async function isExecutable(target: string): Promise<boolean> {
	try {
		await fs.access(target, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * A complete install has the codex binary and, where needed, the bundled bwrap. The binary is
 * copied into place last, so its presence also marks a finished install.
 */
async function isCompleteInstall(binaryPath: string, withBwrap: boolean): Promise<boolean> {
	return (await isExecutable(binaryPath)) && (!withBwrap || (await isExecutable(bundledBwrapPath(binaryPath))));
}

/**
 * Before 2026-11-06 the plugin cached the binary as a bare file at the path that is now the
 * install directory. Answers that file's path when one is there.
 */
async function findLegacyFlatBinary(installDir: string): Promise<string | null> {
	const stat = await fs.lstat(installDir).catch(() => null);
	return stat?.isFile() ? installDir : null;
}

/**
 * Download one release asset into `tempDir` and verify it against the release's published
 * SHA-256 before anything extracts, chmods or runs it.
 *
 * Security: fail closed when no checksum is available, and reject any mismatch. A MITM /
 * compromised release that omits the digest and .sha256 asset, or swaps the archive, cannot get
 * a trojaned binary installed and executed. Mirrors the opencode binary-manager.
 */
async function downloadVerifiedAsset(
	release: ReleaseResponse,
	asset: ReleaseAsset,
	tempDir: string,
	label: string,
	logger?: Logger
): Promise<string> {
	logger?.log(`Downloading ${label} from ${asset.browser_download_url}...`);
	const buffer = await fetchBuffer(asset.browser_download_url);
	const archivePath = path.join(tempDir, asset.name);
	await fs.writeFile(archivePath, buffer);

	const checksum = await resolveChecksum(release.assets, asset.name);
	if (!checksum) {
		throw new Error(
			`No checksum (digest or .sha256 asset) found for ${label} ${release.tag_name} (${asset.name}); ` +
				`refusing to install an unverified binary.`
		);
	}
	if (!(await verifySha256(archivePath, checksum))) {
		throw new Error(`Checksum mismatch for ${label} ${release.tag_name} (${asset.name})`);
	}
	return archivePath;
}

async function extractSingleBinary(archivePath: string, outputDir: string, binaryName: string): Promise<string | null> {
	await fs.mkdir(outputDir, { recursive: true });
	await extractTarGz(archivePath, outputDir);
	return findBinary(outputDir, binaryName);
}

export async function ensureBinary(version: string = DEFAULT_CLI_VERSION, logger?: Logger): Promise<string> {
	const platform = await detectPlatform();
	const binaryPath = getBinaryPath(version, platform.platformString);
	const installDir = path.dirname(binaryPath);
	const withBwrap = needsBundledBwrap(version, platform);

	if (await isCompleteInstall(binaryPath, withBwrap)) {
		const cachedBinary = await canExecute(binaryPath);
		if (cachedBinary.ok) {
			logger?.debug(`Codex binary already cached at ${binaryPath}`);
			return binaryPath;
		}

		logger?.warn?.(`Cached Codex binary at ${binaryPath} is not runnable: ${cachedBinary.error}`);
	}

	await fs.mkdir(path.dirname(installDir), { recursive: true });

	// Security: resolve the release via the GitHub API so we can obtain the published SHA-256
	// for each asset and verify integrity before installing. The archive was previously fetched
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
	const bwrapAsset = withBwrap ? release.assets.find((asset) => asset.name === platform.bwrapAssetName) : undefined;
	if (withBwrap && !bwrapAsset) {
		throw new Error(
			`No bubblewrap asset named ${platform.bwrapAssetName} found for Codex ${release.tag_name}. ` +
				`Codex ${version} on Linux needs it (or a system bwrap) for its sandbox; refusing a partial install.`
		);
	}

	const tempDir = await fs.mkdtemp(path.join(path.dirname(installDir), 'codex-download-'));
	try {
		// Verify every archive before extracting any of them.
		const archivePath = await downloadVerifiedAsset(release, archiveAsset, tempDir, 'Codex', logger);
		const bwrapArchivePath = bwrapAsset
			? await downloadVerifiedAsset(release, bwrapAsset, tempDir, 'bubblewrap', logger)
			: null;

		// Each archive gets its own extraction directory, so a lookup never matches the archive
		// file itself (`codex-<target>.tar.gz` also starts with `codex-`).
		const extractedBinary = await extractSingleBinary(archivePath, path.join(tempDir, 'extract-codex'), 'codex');
		if (!extractedBinary) {
			throw new Error(`Downloaded Codex archive did not contain a codex binary for ${platform.platformString}.`);
		}
		const extractedBwrap = bwrapArchivePath
			? await extractSingleBinary(bwrapArchivePath, path.join(tempDir, 'extract-bwrap'), 'bwrap')
			: null;
		if (bwrapArchivePath && !extractedBwrap) {
			throw new Error(
				`Downloaded bubblewrap archive did not contain a bwrap binary for ${platform.platformString}.`
			);
		}

		// A bare binary cached by an older plugin release sits where the install directory goes.
		// Replace it only now that the new install is verified and extracted.
		const legacyFlatBinary = await findLegacyFlatBinary(installDir);
		if (legacyFlatBinary) {
			await fs.rm(legacyFlatBinary, { force: true });
		}

		// Install bwrap first and the codex binary last: the binary's presence marks a complete
		// install. Each version keeps its own bwrap, because codex checks it against the sha256
		// it was built with.
		await fs.mkdir(installDir, { recursive: true });
		if (extractedBwrap) {
			const bwrapPath = bundledBwrapPath(binaryPath);
			await fs.mkdir(path.dirname(bwrapPath), { recursive: true });
			await fs.copyFile(extractedBwrap, bwrapPath);
			await fs.chmod(bwrapPath, 0o755);
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

	if (await isCompleteInstall(binaryPath, needsBundledBwrap(version, platform))) {
		const cachedBinary = await canExecute(binaryPath);
		if (cachedBinary.ok) {
			return binaryPath;
		}
	}

	// A bare binary cached by an older plugin release still serves `codex login` / `login status`,
	// which run no sandbox; ensureBinary replaces it before the next generation run.
	const legacyFlatBinary = await findLegacyFlatBinary(path.dirname(binaryPath));
	if (legacyFlatBinary && (await isExecutable(legacyFlatBinary)) && (await canExecute(legacyFlatBinary)).ok) {
		return legacyFlatBinary;
	}

	const systemBinary = await canExecute('codex');
	return systemBinary.ok ? 'codex' : null;
}
