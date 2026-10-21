import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
	fleetActionsRunnerPlatformOf,
	isFleetActionsRunnerDownloadUrl,
	type FleetActionsRunnerDownload
} from '@ever-works/contracts';
import { firstOutputLine, RunnerHostError, type RunnerHostDeps } from './host';

/**
 * Actions runners on computers (FL-18, plan §6.1 `runner-download.ts`, spec
 * FR-6, U6) — fetch the runner build GitHub publishes for this machine, verify
 * GitHub's SHA-256 BEFORE anything is extracted, then extract it into the
 * runner's folder.
 *
 *  - The URL must be GitHub's own release asset of the runner
 *    (`https://github.com/actions/runner/releases/download/…`); any other host is
 *    refused before a byte is fetched.
 *  - The build must be the one for THIS machine's OS and architecture.
 *  - A mismatch deletes the archive and fails with the file name in the hint;
 *    nothing is extracted.
 */

/** The largest archive accepted (today's builds are ~200 MB unpacked, ~80 MB packed). */
export const RUNNER_ARCHIVE_MAX_BYTES = 600 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

/** Check the payload's download against this machine before fetching it. */
export function assertRunnerDownloadFor(
	download: FleetActionsRunnerDownload | null | undefined,
	platform: string,
	arch: string
): FleetActionsRunnerDownload {
	if (!download || typeof download !== 'object') throw new RunnerHostError('the job names no runner build');
	if (!isFleetActionsRunnerDownloadUrl(download.downloadUrl)) {
		throw new RunnerHostError('the runner build is not a GitHub release asset; nothing was downloaded');
	}
	if (typeof download.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(download.sha256)) {
		throw new RunnerHostError('the runner build carries no checksum; nothing was downloaded');
	}
	if (typeof download.filename !== 'string' || !/^actions-runner-[A-Za-z0-9._-]+\.(?:tar\.gz|zip)$/.test(download.filename)) {
		throw new RunnerHostError('the runner build has an unexpected file name; nothing was downloaded');
	}
	const ours = fleetActionsRunnerPlatformOf(platform, arch);
	if (!ours || ours.os !== download.os || ours.architecture !== download.architecture) {
		throw new RunnerHostError(`the runner build is for ${download.os}/${download.architecture}, not this computer`);
	}
	return download;
}

/**
 * Download `download` into `<runners>/.downloads/<filename>` while hashing it;
 * resolve the archive path when GitHub's SHA-256 matches, else delete it and
 * throw with the file name (U6).
 */
export async function downloadRunnerArchive(
	deps: Pick<RunnerHostDeps, 'state' | 'fetch'>,
	download: FleetActionsRunnerDownload,
	signal: AbortSignal
): Promise<string> {
	const dir = deps.state.downloadsDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, download.filename);
	const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
	const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
	let response: Response;
	try {
		response = await deps.fetch(download.downloadUrl, { redirect: 'follow', signal: combined });
	} catch (error) {
		throw new RunnerHostError(
			`could not download ${download.filename}: ${error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error)}`
		);
	}
	if (!response.ok || !response.body) {
		throw new RunnerHostError(`could not download ${download.filename}: GitHub answered ${response.status}`);
	}
	const length = Number(response.headers.get('content-length') ?? '0');
	if (Number.isFinite(length) && length > RUNNER_ARCHIVE_MAX_BYTES) {
		throw new RunnerHostError(`${download.filename} is larger than expected; nothing was installed`);
	}
	const hash = createHash('sha256');
	let bytes = 0;
	const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
	source.on('data', (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes > RUNNER_ARCHIVE_MAX_BYTES) source.destroy(new Error('the archive is larger than expected'));
		hash.update(chunk);
	});
	try {
		await pipeline(source, createWriteStream(path, { mode: 0o600 }), { signal: combined });
	} catch (error) {
		await rm(path, { force: true }).catch(() => undefined);
		throw new RunnerHostError(
			`could not download ${download.filename}: ${error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error)}`
		);
	}
	const actual = hash.digest('hex');
	if (actual.toLowerCase() !== download.sha256.toLowerCase()) {
		await rm(path, { force: true }).catch(() => undefined);
		throw new RunnerHostError(`checksum mismatch for ${download.filename} — nothing was installed`);
	}
	return path;
}

/** The extraction argv: `tar -xzf` on Linux and macOS; Windows' own bsdtar (which reads zip) on Windows. */
export function extractArgs(platform: string, archive: string, into: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
	if (platform === 'win32') {
		const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
		return { command: `${systemRoot}\\System32\\tar.exe`, args: ['-xf', archive, '-C', into] };
	}
	return { command: 'tar', args: ['-xzf', archive, '-C', into] };
}

/** Extract a VERIFIED archive into the runner's folder, then delete the archive. */
export async function extractRunnerArchive(
	deps: Pick<RunnerHostDeps, 'exec' | 'platform'>,
	archive: string,
	into: string
): Promise<void> {
	const { command, args } = extractArgs(deps.platform, archive, into);
	const result = await deps.exec({ command, args, timeoutMs: EXTRACT_TIMEOUT_MS });
	await rm(archive, { force: true }).catch(() => undefined);
	if (result.spawnError) throw new RunnerHostError('tar was not found on this computer; nothing was installed');
	if (result.code !== 0) throw new RunnerHostError(`could not extract the runner: ${firstOutputLine(result, 'tar failed')}`);
}
