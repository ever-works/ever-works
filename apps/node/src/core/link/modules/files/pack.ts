import {
	FLEET_FILES_LIMITS,
	FLEET_FILES_MAX_BYTES_RECORD,
	encodeFleetFilesBytesRecord,
	encodeFleetFilesHeaderRecord,
	isCredentialShapedName,
	joinFleetFilePath,
	type FleetFilesStreamHeader
} from '@ever-works/contracts';
import { isInsideRoot, type AllowedRoot } from '../../allowed-roots';
import type { FilesIo } from './files-io';
import { compareFileNames } from './list';
import { describeLink, filesPathApi, FilesRequestError, LEAVES_ROOT_HINT, resolveEntry } from './path-guard';

/**
 * Files on computers (FL-11, T-05) — `files.pack`: the selection of a folder
 * as a files stream (the contract's records, `@ever-works/contracts`
 * `fleet-files.types.ts`).
 *
 * Two passes, so every limit is checked **before the first byte** (FR-16):
 *
 *  1. {@link scanSelection} walks the selection — folders recursively, never
 *     following a link out of the selection — counting entries and bytes, and
 *     refuses `limit_exceeded` past 5 000 entries or 2 GiB. It also collects
 *     the credential-shaped names inside (FR-17: the platform confirms, or
 *     refuses an Agent, before anything moves).
 *  2. {@link streamSelection} sends one header record per entry and each
 *     file's bytes in records of at most 64 KiB, each as its own `DATA` frame,
 *     through a sink that waits for `ACK` credit (CONTRACTS §3.2: at most
 *     8 MiB unacknowledged).
 *
 * Links (spec S3, FR-29): a link whose target stays inside the selection is
 * sent as a link (its target rewritten relative to the link's own folder);
 * one pointing outside it — or outside the root, or broken — is skipped and
 * counted. A link the person selected ITSELF is followed when its target stays
 * inside the root (they asked for what it points to) and refused `invalid`
 * otherwise. Sockets, devices and pipes are skipped and counted.
 */

export interface PackItem {
	/** Absolute path to read (a selected link: its target). */
	abs: string;
	header: FleetFilesStreamHeader;
}

export interface PackScan {
	items: PackItem[];
	entries: number;
	bytes: number;
	skippedLinks: number;
	skippedOther: number;
	/** Relative paths of the credential-shaped files inside (at most 20 named). */
	credentialShaped: string[];
	credentialShapedCount: number;
}

export const LIMIT_ENTRIES_HINT = `Select fewer than ${FLEET_FILES_LIMITS.maxEntries.toLocaleString('en-US')} items`;
export const LIMIT_BYTES_HINT = 'One transfer moves at most 2 GiB — select less';

export async function scanSelection(
	io: FilesIo,
	root: AllowedRoot,
	folderReal: string,
	relFolder: string,
	names: readonly string[],
	signal: AbortSignal
): Promise<PackScan> {
	const api = filesPathApi(io.platform);
	const scan: PackScan = {
		items: [],
		entries: 0,
		bytes: 0,
		skippedLinks: 0,
		skippedOther: 0,
		credentialShaped: [],
		credentialShapedCount: 0
	};
	if (names.length === 0) throw new FilesRequestError('invalid', 'Select at least one item');
	if (names.length > FLEET_FILES_LIMITS.maxEntries) throw new FilesRequestError('limit_exceeded', LIMIT_ENTRIES_HINT);

	// The selection's real tops: what "inside the set" means for links below them.
	const tops: Array<{ name: string; real: string; kind: 'file' | 'folder' }> = [];
	for (const name of [...new Set(names)]) {
		const { path, stat } = await resolveEntry(io, folderReal, name);
		if (stat.kind === 'link') {
			const link = await describeLink(io, root, path);
			if (!link) throw new FilesRequestError('not_found', `${name} points to something that is gone`);
			if (!link.inside) throw new FilesRequestError('invalid', `${name} points outside the root`);
			if (link.kind !== 'file' && link.kind !== 'folder') {
				throw new FilesRequestError('invalid', `${name} is not a file or a folder`);
			}
			tops.push({ name, real: link.real, kind: link.kind });
		} else if (stat.kind === 'file' || stat.kind === 'folder') {
			tops.push({ name, real: path, kind: stat.kind });
		} else {
			throw new FilesRequestError('invalid', `${name} is not a file or a folder`);
		}
	}
	const insideSet = (real: string): boolean => tops.some((top) => isInsideRoot(real, top.real, io.platform));

	const count = (header: FleetFilesStreamHeader): void => {
		scan.entries += 1;
		if (scan.entries > FLEET_FILES_LIMITS.maxEntries)
			throw new FilesRequestError('limit_exceeded', LIMIT_ENTRIES_HINT);
		scan.bytes += header.size;
		if (scan.bytes > FLEET_FILES_LIMITS.maxOpBytes) {
			throw new FilesRequestError('limit_exceeded', LIMIT_BYTES_HINT, {
				maxBytes: FLEET_FILES_LIMITS.maxOpBytes
			});
		}
		if (header.kind === 'file') {
			const name = header.path.slice(header.path.lastIndexOf('/') + 1);
			if (isCredentialShapedName(name, joinFleetFilePath(relFolder, header.path))) {
				scan.credentialShapedCount += 1;
				if (scan.credentialShaped.length < 20) scan.credentialShaped.push(header.path);
			}
		}
	};

	const walk = async (abs: string, rel: string, followed: boolean): Promise<void> => {
		if (signal.aborted) throw new FilesRequestError('operation_failed', 'cancelled');
		const stat = followed ? await io.stat(abs) : await io.lstat(abs);
		if (stat.kind === 'link') {
			const link = await describeLink(io, root, abs);
			if (!link || !link.inside || !insideSet(link.real)) {
				scan.skippedLinks += 1;
				return;
			}
			const target = api.relative(api.dirname(abs), link.real).split(api.sep).join('/');
			if (target.length === 0 || target.startsWith('/')) {
				scan.skippedLinks += 1;
				return;
			}
			const header: FleetFilesStreamHeader = {
				path: rel,
				kind: 'link',
				size: 0,
				mode: 0o777,
				mtimeMs: stat.mtimeMs,
				target
			};
			count(header);
			scan.items.push({ abs, header });
			return;
		}
		if (stat.kind === 'file') {
			const header: FleetFilesStreamHeader = {
				path: rel,
				kind: 'file',
				size: stat.size,
				mode: stat.mode,
				mtimeMs: stat.mtimeMs
			};
			count(header);
			scan.items.push({ abs, header });
			return;
		}
		if (stat.kind === 'folder') {
			const header: FleetFilesStreamHeader = {
				path: rel,
				kind: 'folder',
				size: 0,
				mode: stat.mode,
				mtimeMs: stat.mtimeMs
			};
			count(header);
			scan.items.push({ abs, header });
			const children = (await io.readdir(abs)).sort(compareFileNames);
			for (const child of children) await walk(api.join(abs, child), `${rel}/${child}`, false);
			return;
		}
		scan.skippedOther += 1;
	};

	for (const top of tops) await walk(top.real, top.name, true);
	return scan;
}

/** Where a pack's records go: resolves once the record was handed to the link (credit permitting). */
export interface FilesStreamSink {
	send(record: Uint8Array): Promise<void>;
}

export interface StreamProgress {
	bytes: number;
	entries: number;
}

/**
 * Send the scanned selection. A file that changed size since the scan fails
 * the operation (`operation_failed`) rather than send something else under
 * its name.
 */
export async function streamSelection(
	io: FilesIo,
	scan: PackScan,
	sink: FilesStreamSink,
	signal: AbortSignal,
	onProgress: (progress: StreamProgress) => void
): Promise<StreamProgress> {
	const progress: StreamProgress = { bytes: 0, entries: 0 };
	for (const item of scan.items) {
		if (signal.aborted) throw new FilesRequestError('operation_failed', 'cancelled');
		const header = encodeFleetFilesHeaderRecord(item.header);
		if (!header) throw new FilesRequestError('invalid', `${item.header.path} has a name too long to send`);
		await sink.send(header);
		progress.entries += 1;
		if (item.header.kind === 'file') {
			let sent = 0;
			for await (const chunk of io.readChunks(item.abs, FLEET_FILES_MAX_BYTES_RECORD, signal)) {
				if (sent + chunk.byteLength > item.header.size) {
					throw new FilesRequestError('operation_failed', `${item.header.path} grew while it was read`);
				}
				const record = encodeFleetFilesBytesRecord(chunk);
				if (!record) continue;
				await sink.send(record);
				sent += chunk.byteLength;
				progress.bytes += chunk.byteLength;
				onProgress(progress);
			}
			if (signal.aborted) throw new FilesRequestError('operation_failed', 'cancelled');
			if (sent !== item.header.size) {
				throw new FilesRequestError('operation_failed', `${item.header.path} shrank while it was read`);
			}
		}
		onProgress(progress);
	}
	return progress;
}

export { LEAVES_ROOT_HINT };
