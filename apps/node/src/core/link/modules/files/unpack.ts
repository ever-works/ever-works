import {
	FLEET_FILES_LIMITS,
	FLEET_FILES_RECORD_TAGS,
	FleetFilesStreamTracker,
	decodeFleetFilesRecords,
	fleetFilesPolicyFor,
	type FleetFilesRecord,
	type FleetFilesStreamHeader,
	type FleetFilesWritePolicy
} from '@ever-works/contracts';
import { isInsideRoot } from '../../allowed-roots';
import type { FilesIo, FilesWriter } from './files-io';
import { filesPathApi, FilesRequestError } from './path-guard';

/**
 * Files on computers (FL-11, T-06) — `files.unpack`: a files stream written
 * into a destination folder, never half-written (FR-15):
 *
 *  - every entry lands first in `<destination>/.ever-works-partial-<op>/`
 *    (same volume, so the final rename is atomic), each path re-checked to
 *    stay inside it — a header the contract's decoder let through is still
 *    proved here, and a link whose target would leave it is skipped;
 *  - bytes are written in the order they arrived; each `DATA` frame is
 *    acknowledged (`ACK` credit) once it is on disk, so a slow disk slows the
 *    sender, never the platform's memory;
 *  - on the stream's `END`, each top-level entry is moved into place by the
 *    policy (Skip by default; Replace named entries or all — FR-13): a replaced
 *    entry is set aside first and restored if the move fails;
 *  - a cancel, a closed channel, a link drop or any failure removes the
 *    partial folder — nothing partial is left.
 */

export interface UnpackResult {
	entries: number;
	bytes: number;
	replaced: number;
	skipped: number;
	skippedLinks: number;
}

export interface UnpackerOptions {
	io: FilesIo;
	/** The destination folder, canonical, inside an allowed root. */
	destReal: string;
	operationId: string;
	policy: FleetFilesWritePolicy;
	/** Credit back the bytes of one `DATA` frame once written. */
	ack(bytes: number): void;
	onProgress(progress: { bytes: number; entries: number }): void;
	/** The first failure while frames were being written (the stream is then dead). */
	onFail?(error: FilesRequestError): void;
}

/** The partial folder's name for an operation. */
export function partialFolderName(operationId: string): string {
	return `.ever-works-partial-${operationId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'op'}`;
}

/** Frames queued but not yet on disk beyond this are a sender ignoring credit. */
const MAX_QUEUED_BYTES = 2 * FLEET_FILES_LIMITS.windowBytes;

export class Unpacker {
	readonly partial: string;
	private readonly aside: string;
	private readonly tracker = new FleetFilesStreamTracker();
	private chain: Promise<void> = Promise.resolve();
	private writer: FilesWriter | null = null;
	private failure: FilesRequestError | null = null;
	private queued = 0;
	private readonly tops: string[] = [];
	private readonly finals: FleetFilesStreamHeader[] = [];
	private skippedLinks = 0;
	private done = false;

	constructor(private readonly options: UnpackerOptions) {
		const api = filesPathApi(options.io.platform);
		this.partial = api.join(options.destReal, partialFolderName(options.operationId));
		this.aside = api.join(this.partial, '.replaced');
	}

	/** Create the partial folder (a stale one from a crash is removed first). */
	async start(): Promise<void> {
		await this.options.io.remove(this.partial).catch(() => undefined);
		await this.options.io.mkdir(this.partial);
	}

	get failed(): FilesRequestError | null {
		return this.failure;
	}

	/** One `DATA` frame. Never throws: a problem marks the unpack failed. */
	push(payload: Uint8Array): void {
		if (this.failure || this.done) return;
		const records = decodeFleetFilesRecords(payload);
		if (!records) {
			this.fail(new FilesRequestError('invalid', 'the transfer stream is malformed'));
			return;
		}
		this.queued += payload.byteLength;
		if (this.queued > MAX_QUEUED_BYTES) {
			this.fail(new FilesRequestError('limit_exceeded', 'the sender did not wait for credit'));
			return;
		}
		const length = payload.byteLength;
		this.chain = this.chain
			.then(async () => {
				if (this.failure) return;
				await this.apply(records);
				this.queued -= length;
				this.options.ack(length);
			})
			.catch((error: unknown) => {
				this.fail(
					error instanceof FilesRequestError
						? error
						: new FilesRequestError('operation_failed', firstLine(error))
				);
			});
	}

	/** The stream's `END`: move everything into place. */
	async finish(): Promise<UnpackResult> {
		await this.chain;
		if (this.failure) throw this.failure;
		if (!this.tracker.complete)
			throw new FilesRequestError('invalid', 'the transfer ended in the middle of a file');
		this.done = true;
		await this.closeWriter();
		const { io, destReal, policy } = this.options;
		const api = filesPathApi(io.platform);
		// Times and modes once every byte is in (folders last, deepest first, so writing inside does not move them).
		for (const header of [...this.finals].reverse()) {
			const path = api.join(this.partial, ...header.path.split('/'));
			if (header.kind !== 'link') await io.chmod(path, header.mode).catch(() => undefined);
			if (header.mtimeMs > 0 && header.kind !== 'link')
				await io.setTimes(path, header.mtimeMs).catch(() => undefined);
		}
		let replaced = 0;
		let skipped = 0;
		try {
			for (const top of this.tops) {
				const source = api.join(this.partial, top);
				const target = api.join(destReal, top);
				const exists = await io
					.lstat(target)
					.then(() => true)
					.catch(() => false);
				if (exists && fleetFilesPolicyFor(policy, top) === 'skip') {
					skipped += 1;
					continue;
				}
				if (exists) {
					await io.mkdir(this.aside);
					const setAside = api.join(this.aside, top);
					await io.rename(target, setAside);
					try {
						await io.rename(source, target);
					} catch (error) {
						await io.rename(setAside, target).catch(() => undefined);
						throw error;
					}
					replaced += 1;
				} else {
					await io.rename(source, target);
				}
			}
		} catch (error) {
			throw new FilesRequestError('operation_failed', firstLine(error));
		} finally {
			await io.remove(this.partial).catch(() => undefined);
		}
		return {
			entries: this.tracker.entries,
			bytes: this.tracker.bytes,
			replaced,
			skipped,
			skippedLinks: this.skippedLinks
		};
	}

	/** Cancel, close or failure: nothing partial survives. */
	async abort(): Promise<void> {
		if (!this.failure) this.failure = new FilesRequestError('operation_failed', 'cancelled');
		this.done = true;
		await this.chain.catch(() => undefined);
		await this.closeWriter().catch(() => undefined);
		await this.options.io.remove(this.partial).catch(() => undefined);
	}

	private fail(error: FilesRequestError): void {
		if (this.failure) return;
		this.failure = error;
		try {
			this.options.onFail?.(error);
		} catch {
			// the listener's failure is its own
		}
	}

	private async closeWriter(): Promise<void> {
		const writer = this.writer;
		this.writer = null;
		if (writer) await writer.close();
	}

	private async apply(records: FleetFilesRecord[]): Promise<void> {
		const { io } = this.options;
		const api = filesPathApi(io.platform);
		for (const record of records) {
			const problem = this.tracker.push(record);
			if (problem) {
				const code = /items|GiB/.test(problem) ? 'limit_exceeded' : 'invalid';
				throw new FilesRequestError(code, problem);
			}
			if (record.tag === FLEET_FILES_RECORD_TAGS.bytes) {
				if (!this.writer) throw new FilesRequestError('invalid', 'bytes outside a file');
				await this.writer.write(record.bytes);
				this.options.onProgress({ bytes: this.tracker.bytes, entries: this.tracker.entries });
				continue;
			}
			await this.closeWriter();
			const header = record.header;
			const segments = header.path.split('/');
			const path = api.join(this.partial, ...segments);
			if (!isInsideRoot(path, this.partial, io.platform) || path === this.partial) {
				throw new FilesRequestError('invalid', 'That path leaves its root');
			}
			if (segments[0] === '.replaced') throw new FilesRequestError('invalid', 'a reserved name');
			if (!this.tops.includes(segments[0])) this.tops.push(segments[0]);
			if (segments.length > 1) await io.mkdir(api.dirname(path));
			switch (header.kind) {
				case 'folder':
					await io.mkdir(path);
					this.finals.push(header);
					break;
				case 'file':
					this.writer = await io.createWriter(path, header.mode);
					this.finals.push(header);
					if (header.size === 0) await this.closeWriter();
					break;
				case 'link': {
					const target = header.target ?? '';
					const resolved = api.resolve(api.dirname(path), ...target.split('/'));
					if (!isInsideRoot(resolved, this.partial, io.platform)) {
						this.skippedLinks += 1;
						break;
					}
					try {
						await io.symlink(target.split('/').join(api.sep), path, 'file');
					} catch {
						// Windows without the symlink privilege, or a filesystem without links.
						this.skippedLinks += 1;
					}
					break;
				}
			}
			this.options.onProgress({ bytes: this.tracker.bytes, entries: this.tracker.entries });
		}
	}
}

function firstLine(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0].slice(0, 300);
}
