import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { spawn } from 'child_process';
import { createHash } from 'node:crypto';
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
}

interface ReleaseResponse {
	readonly tag_name: string;
	readonly assets: readonly ReleaseAsset[];
}

/** Socket idle timeout (ms). Resets on activity, so it's safe for large downloads on slow links. */
const FETCH_SOCKET_IDLE_TIMEOUT_MS = 60_000;

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

		const client = url.startsWith('https://') ? https : http;
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
					fetchBuffer(res.headers.location, maxRedirects - 1, signal).then(resolve, reject);
					return;
				}

				if ((res.statusCode || 500) >= 400) {
					res.resume();
					reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
					return;
				}

				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
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
		case 'linux-arm64-musl':
			// OpenCode ships glibc Linux archives; fall back to the glibc archive on musl (Alpine).
			return 'opencode-linux-arm64.zip';
		case 'linux-x64':
		case 'linux-x64-musl':
			return 'opencode-linux-x64.zip';
		default:
			throw new Error(`Unsupported OpenCode binary platform: ${platformString}`);
	}
}

async function verifySha256(filePath: string, checksum: string): Promise<boolean> {
	const file = await fs.readFile(filePath);
	return createHash('sha256').update(file).digest('hex') === checksum;
}

async function unzipArchive(archivePath: string, outputDir: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn('unzip', ['-o', archivePath, '-d', outputDir], {
			stdio: ['ignore', 'ignore', 'pipe']
		});

		let stderr = '';
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf-8');
		});

		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(stderr.trim() || `unzip failed with exit code ${code}`));
		});
	});
}

async function ensureUnzipAvailable(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn('unzip', ['-v'], {
			stdio: ['ignore', 'ignore', 'ignore']
		});

		child.on('error', (error) => {
			const message =
				error instanceof Error && 'code' in error && error.code === 'ENOENT'
					? 'OpenCode CLI extraction requires the system `unzip` binary, but it is not installed or not on PATH.'
					: error instanceof Error
						? error.message
						: 'Unknown unzip availability error';

			reject(
				new Error(
					`${message} Install \`unzip\` on the host before using the OpenCode plugin runtime installer.`
				)
			);
		});

		child.on('exit', (code) => {
			if (code === 0) {
				resolve();
				return;
			}

			reject(
				new Error(
					`OpenCode CLI extraction requires a working system \`unzip\` binary. ` +
						`\`unzip -v\` exited with code ${code}.`
				)
			);
		});
	});
}

async function resolveChecksum(
	assets: readonly ReleaseAsset[],
	archiveName: string,
	signal?: AbortSignal
): Promise<string | null> {
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

		const checksum = await resolveChecksum(release.assets, archiveName, signal);
		if (checksum) {
			const valid = await verifySha256(archivePath, checksum);
			if (!valid) {
				throw new Error(`Checksum mismatch for OpenCode ${release.tag_name} (${archiveName})`);
			}
		} else {
			logger?.warn(`No checksum asset found for ${archiveName}; proceeding without checksum verification.`);
		}

		await ensureUnzipAvailable();
		await unzipArchive(archivePath, tempDir);

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
