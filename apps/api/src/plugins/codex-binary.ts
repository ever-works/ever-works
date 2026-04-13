import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const BASE_TEMP_DIR = '/tmp/codex-generator';
const CODEX_RELEASES_URL = 'https://github.com/openai/codex/releases/download';
const DEFAULT_CLI_VERSION = '0.120.0';

interface LoggerLike {
    log(message: string, ...args: unknown[]): void;
    debug?(message: string, ...args: unknown[]): void;
    warn?(message: string, ...args: unknown[]): void;
}

async function canExecute(command: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
        const child = spawn(command, ['--version'], {
            stdio: ['ignore', 'ignore', 'pipe'],
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
                error: code === 0 ? undefined : stderr.trim() || `codex exited with code ${code}`,
            });
        });
    });
}

function detectPlatform(): { assetName: string; platformString: string } {
    const platform = os.platform();
    const arch = os.arch();

    if (platform !== 'linux' && platform !== 'darwin') {
        throw new Error(`Unsupported OS: ${platform}. Only Linux and macOS are supported.`);
    }

    if (arch !== 'x64' && arch !== 'arm64') {
        throw new Error(`Unsupported architecture: ${arch}. Only x64 and arm64 are supported.`);
    }

    const platformString = `${platform}-${arch}`;
    const assetNameByPlatform: Record<string, string> = {
        'linux-x64': 'codex-x86_64-unknown-linux-gnu.tar.gz',
        'linux-arm64': 'codex-aarch64-unknown-linux-gnu.tar.gz',
        'darwin-x64': 'codex-x86_64-apple-darwin.tar.gz',
        'darwin-arm64': 'codex-aarch64-apple-darwin.tar.gz',
    };

    const assetName = assetNameByPlatform[platformString];
    if (!assetName) {
        throw new Error(`No Codex release asset configured for platform ${platformString}.`);
    }

    return { assetName, platformString };
}

function getBinaryPath(version: string, platformString: string): string {
    return path.join(BASE_TEMP_DIR, 'bin', `codex-${version}-${platformString}`);
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
                if (
                    res.statusCode &&
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location
                ) {
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
            stdio: ['ignore', 'ignore', 'pipe'],
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

async function findBinary(rootDir: string): Promise<string | null> {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        const candidate = path.join(rootDir, entry.name);
        if (entry.isFile() && (entry.name === 'codex' || entry.name.startsWith('codex-'))) {
            return candidate;
        }
        if (entry.isDirectory()) {
            const nested = await findBinary(candidate);
            if (nested) {
                return nested;
            }
        }
    }

    return null;
}

export async function ensureCodexBinary(logger?: LoggerLike): Promise<string> {
    const { assetName, platformString } = detectPlatform();
    const binaryPath = getBinaryPath(DEFAULT_CLI_VERSION, platformString);

    try {
        await fs.access(binaryPath, fs.constants.X_OK);
        const cachedBinary = await canExecute(binaryPath);
        if (cachedBinary.ok) {
            logger?.debug?.(`Codex binary already cached at ${binaryPath}`);
            return binaryPath;
        }

        logger?.warn?.(
            `Cached Codex binary at ${binaryPath} is not runnable: ${cachedBinary.error}`,
        );
    } catch {
        // continue with download
    }

    await fs.mkdir(path.dirname(binaryPath), { recursive: true });

    const releaseTag = `rust-v${DEFAULT_CLI_VERSION}`;
    const assetUrl = `${CODEX_RELEASES_URL}/${releaseTag}/${assetName}`;
    logger?.log(`Downloading Codex CLI ${DEFAULT_CLI_VERSION} from ${assetUrl}...`);

    const archiveBuffer = await fetchBuffer(assetUrl);
    const tempDir = await fs.mkdtemp(path.join(path.dirname(binaryPath), 'codex-download-'));

    try {
        const archivePath = path.join(tempDir, assetName);
        await fs.writeFile(archivePath, archiveBuffer);
        await extractTarGz(archivePath, tempDir);

        const extractedBinary = await findBinary(tempDir);
        if (!extractedBinary) {
            throw new Error(
                `Downloaded Codex archive did not contain a codex binary for ${platformString}.`,
            );
        }

        await fs.chmod(extractedBinary, 0o755);
        await fs.copyFile(extractedBinary, binaryPath);
        await fs.chmod(binaryPath, 0o755);

        const downloadedBinary = await canExecute(binaryPath);
        if (downloadedBinary.ok) {
            logger?.log(`Codex CLI ${DEFAULT_CLI_VERSION} ready at ${binaryPath}`);
            return binaryPath;
        }

        logger?.warn?.(
            `Downloaded Codex binary at ${binaryPath} is not runnable on this host: ${downloadedBinary.error}`,
        );
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    const systemBinary = await canExecute('codex');
    if (systemBinary.ok) {
        logger?.log(
            'Using system Codex CLI from PATH because the managed release binary is not compatible.',
        );
        return 'codex';
    }

    throw new Error(
        `Failed to resolve a runnable Codex CLI. System codex error: ${systemBinary.error ?? 'unavailable'}`,
    );
}
