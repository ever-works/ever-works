import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';

import { CODEX_RELEASES_URL, DEFAULT_CLI_VERSION } from '../types.js';
import { detectPlatform, getBinaryPath } from './platform.js';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

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

async function extractTarGz(archivePath: string, outputDir: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn('tar', ['-xzf', archivePath, '-C', outputDir], {
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

			reject(new Error(stderr.trim() || `tar exited with code ${code}`));
		});
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
	const platform = detectPlatform();
	const binaryPath = getBinaryPath(version, platform.platformString);

	try {
		await fs.access(binaryPath, fs.constants.X_OK);
		logger?.debug(`Codex binary already cached at ${binaryPath}`);
		return binaryPath;
	} catch {
		// continue with download
	}

	await fs.mkdir(path.dirname(binaryPath), { recursive: true });

	const releaseTag = `rust-v${version}`;
	const assetUrl = `${CODEX_RELEASES_URL}/${releaseTag}/${platform.assetName}`;
	logger?.log(`Downloading Codex CLI ${version} from ${assetUrl}...`);

	const archiveBuffer = await fetchBuffer(assetUrl);
	const tempDir = await fs.mkdtemp(path.join(path.dirname(binaryPath), 'codex-download-'));
	try {
		const archivePath = path.join(tempDir, platform.assetName);
		await fs.writeFile(archivePath, archiveBuffer);
		await extractTarGz(archivePath, tempDir);

		const extractedBinary = await findBinary(tempDir, 'codex');
		if (!extractedBinary) {
			throw new Error(`Downloaded Codex archive did not contain a codex binary for ${platform.platformString}.`);
		}

		await fs.chmod(extractedBinary, 0o755);
		await fs.copyFile(extractedBinary, binaryPath);
		await fs.chmod(binaryPath, 0o755);

		logger?.log(`Codex CLI ${version} ready at ${binaryPath}`);
		return binaryPath;
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}
